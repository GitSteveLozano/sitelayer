// Welcome-email runner. Drains `mutation_outbox` rows of
// mutation_type='welcome_email' that were enqueued by POST /api/companies
// when a new owner finishes the onboarding wizard.
//
// Why the company-creation seam (not the Clerk user.created webhook):
//   The welcome email is only useful AFTER the user has gone through the
//   onboarding wizard and created their company. Enqueuing at company
//   creation:
//     - sidesteps the "pre-tenancy outbox" complication (mutation_outbox
//       is keyed by company_id),
//     - gives the email a real `companyName` to address,
//     - keeps the Clerk webhook handler a no-op as designed by ADR 0003.
//
// PII hygiene (CLAUDE.md ops rule + the round-8 audit follow-up):
//   - The payload from the API carries `user_id` only — never the email
//     verbatim. The worker hydrates the address via Clerk at send time.
//   - The rendered body intentionally omits the user's email so the
//     template can't leak it back through provider logs / replay tooling.
//   - All logger calls funnel through `redactEmail` so the recipient
//     shows up as a sha256 prefix.
//
// Idempotency:
//   The outbox row's idempotency_key (`welcome_email:<userId>:<companyId>`)
//   is unique on (company_id, idempotency_key). A second POST /api/companies
//   for the same (user, company) would upsert onto the same row rather
//   than fan out a second send. The runner marks the row `applied` after
//   a successful send so the standard outbox retry/dlq machinery applies
//   for transient failures.

import type { Pool, PoolClient } from 'pg'
import type { Logger } from '@sitelayer/logger'
import type { User } from '@clerk/backend'
import { createClerkClient } from '@clerk/backend'
import { redactEmail, sendEmail as defaultSendEmail, type EmailMessage } from '../email.js'
import { clerkUserFetcherFromClient, type ClerkUserFetcher } from '../clerk-hydrate.js'
import { drainAgentMutations, type AgentDrainSummary } from '../runner-utils.js'

export interface WelcomeEmailPayload {
  user_id: string
  company_id: string
  company_name: string
}

export interface WelcomeEmailTemplate {
  subject: string
  text: string
  html: string
}

/**
 * Pure template renderer. Lives next to the runner so tests can assert
 * the body shape without standing up the rest of the worker.
 *
 * The body is short (4–6 sentences) and deliberately omits the user's
 * email so the row's payload can't smuggle PII back to the SMTP provider.
 */
export function renderWelcomeEmail(input: { firstName: string | null; companyName: string }): WelcomeEmailTemplate {
  const greetingName = (input.firstName ?? '').trim() || 'there'
  const companyName = input.companyName.trim() || 'your company'
  const appUrl = 'https://sitelayer.sandolab.xyz'

  const subject = 'Welcome to Sitelayer'
  const text = [
    `Hi ${greetingName},`,
    '',
    `Welcome to Sitelayer! Your account ${companyName} is ready.`,
    '',
    'Quick start:',
    '1. Upload your first blueprint or import customers from QuickBooks',
    '2. Invite your foreman and crew from the More menu',
    `3. Need help? Reply to this email or visit ${appUrl}/help`,
    '',
    'Built for construction teams that bid faster and bill cleaner.',
    '',
    '— The Sitelayer team',
  ].join('\n')

  const html = [
    `<p>Hi ${escapeHtml(greetingName)},</p>`,
    `<p>Welcome to Sitelayer! Your account <strong>${escapeHtml(companyName)}</strong> is ready.</p>`,
    '<p><strong>Quick start:</strong></p>',
    '<ol>',
    '<li>Upload your first blueprint or import customers from QuickBooks</li>',
    '<li>Invite your foreman and crew from the More menu</li>',
    `<li>Need help? Reply to this email or visit <a href="${appUrl}/help">${appUrl}/help</a></li>`,
    '</ol>',
    '<p>Built for construction teams that bid faster and bill cleaner.</p>',
    '<p>— The Sitelayer team</p>',
  ].join('\n')

  return { subject, text, html }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function pickPrimaryEmail(user: User): string | null {
  const primaryId = user.primaryEmailAddressId
  const list = user.emailAddresses ?? []
  if (primaryId) {
    const match = list.find((entry) => entry.id === primaryId)
    if (match?.emailAddress) return match.emailAddress
  }
  const first = list[0]
  return first?.emailAddress ?? null
}

export type WelcomeEmailDeps = {
  pool: Pool
  logger: Logger
  /** Injectable for tests; defaults to the real Clerk-backend fetcher. */
  getUser?: ClerkUserFetcher | null
  /** Injectable for tests; defaults to the worker's shared sendEmail. */
  sendEmail?: typeof defaultSendEmail
}

/**
 * Build the welcome-email runner. The runner is a thin wrapper around
 * `drainAgentMutations` that hydrates the recipient's email + first name
 * from Clerk, renders the template, and calls `sendEmail`.
 *
 * Returns `null` (and logs at warn) when `CLERK_SECRET_KEY` is missing
 * AND no test injection is provided — the worker treats this as a soft
 * disable so dev/preview tiers without a Clerk backend key can still boot.
 * Production sets `CLERK_SECRET_KEY` (the notification runner already
 * enforces it at boot, so production paths always have it available).
 */
export function createWelcomeEmailRunner(deps: WelcomeEmailDeps) {
  const { pool, logger, sendEmail = defaultSendEmail } = deps

  let getUser: ClerkUserFetcher | null = deps.getUser ?? null
  if (!getUser) {
    const clerkSecretKey = (process.env.CLERK_SECRET_KEY ?? '').trim()
    if (clerkSecretKey) {
      const clerkClient = createClerkClient({ secretKey: clerkSecretKey })
      getUser = clerkUserFetcherFromClient(clerkClient)
    } else {
      logger.warn(
        { hint: 'set CLERK_SECRET_KEY to enable welcome_email hydration' },
        '[welcome-email] CLERK_SECRET_KEY missing — runner will defer rows',
      )
    }
  }

  return async function drainWelcomeEmails(companyId: string): Promise<AgentDrainSummary> {
    if (!getUser) {
      // Hydration disabled: do not claim rows (would otherwise burn the
      // attempt_count and DLQ a row through no fault of its own).
      return { processed: 0, insightsCreated: 0, failed: 0 }
    }

    return drainAgentMutations<WelcomeEmailPayload>(
      pool,
      'welcome_email',
      companyId,
      'welcome_email',
      async (_client: PoolClient, _cid: string, payload: WelcomeEmailPayload) => {
        const userId = typeof payload?.user_id === 'string' ? payload.user_id : null
        if (!userId) {
          throw new Error('welcome_email payload missing user_id')
        }
        const companyName =
          typeof payload?.company_name === 'string' && payload.company_name.trim().length > 0
            ? payload.company_name
            : 'your company'

        const user = await getUser!(userId)
        const email = pickPrimaryEmail(user)
        if (!email) {
          // No email on the Clerk profile — surface as a hard failure so
          // the row goes to the DLQ rather than retrying forever.
          throw new Error(`welcome_email: clerk user ${userId} has no email`)
        }

        const template = renderWelcomeEmail({
          firstName: user.firstName ?? null,
          companyName,
        })

        const message: EmailMessage = {
          to: email,
          subject: template.subject,
          text: template.text,
          html: template.html,
        }
        const result = await sendEmail(message)
        logger.info(
          {
            provider: result.provider,
            messageId: result.messageId,
            company_id: companyId,
            user_id: userId,
            ...redactEmail(message),
          },
          '[welcome-email] sent',
        )
        return { insightsCreated: 0 }
      },
    )
  }
}
