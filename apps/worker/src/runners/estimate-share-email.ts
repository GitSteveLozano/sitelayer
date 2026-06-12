// Estimate-share delivery runner. Drains `mutation_outbox` rows of
// mutation_type='send_estimate_share' enqueued by
// POST /api/projects/:id/estimate/share (apps/api/src/routes/
// estimate-shares-admin.ts) and emails the recipient their portal link.
//
// Before 2026-06-12 this mutation_type had NO handler anywhere: the generic
// drain stamped the row 'applied', ops saw success, and the customer email
// never sent. The type is now in DEDICATED_HANDLER_MUTATION_TYPES
// (@sitelayer/queue) so only this runner can complete it.
//
// Payload (written by the route):
//   { estimate_share_link_id, project_id, recipient_email, recipient_name,
//     message, include_signed_link, share_url_path }
//
// Idempotency / staleness:
//   - The outbox idempotency_key (`estimate_share:send:<shareId>`) collapses
//     replayed SENDs for the same share onto one row.
//   - Before sending, the runner re-reads the share row in the SAME tx the
//     drain holds. A share that has since been revoked or expired is SKIPPED
//     (applied with send_skipped logged) — we must not email a dead link.
//   - Standard outbox retry/parking applies: a transient provider failure
//     throws, drainAgentMutations reschedules with backoff and parks the row
//     at status='failed' after 5 attempts.
//
// PII hygiene mirrors welcome-email.ts: recipient address and message body
// never hit the logs verbatim (redactEmail), and the share token is only
// embedded in the outbound mail, never logged.

import type { Pool, PoolClient } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { redactEmail, sendEmail as defaultSendEmail, type EmailMessage } from '../email.js'
import { drainAgentMutations, type AgentDrainSummary } from '../runner-utils.js'

export interface EstimateShareEmailPayload {
  estimate_share_link_id?: string
  project_id?: string
  recipient_email?: string
  recipient_name?: string | null
  message?: string | null
  include_signed_link?: boolean
  /** e.g. /portal/estimates/<token> — appended to the public base URL. */
  share_url_path?: string
}

export interface EstimateShareEmailTemplate {
  subject: string
  text: string
  html: string
}

/** Same default as apps/api/src/server.ts:portalBaseUrl. */
export function resolvePortalBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.APP_PUBLIC_URL ?? '').trim().replace(/\/$/, '') || 'https://sitelayer.sandolab.xyz'
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Pure template renderer (testable without the drain). The estimator's
 * optional note is included verbatim in text and HTML-escaped in html.
 */
export function renderEstimateShareEmail(input: {
  recipientName: string | null
  companyName: string
  projectName: string | null
  message: string | null
  shareUrl: string
  expiresAt: string | null
}): EstimateShareEmailTemplate {
  const greetingName = (input.recipientName ?? '').trim() || 'there'
  const companyName = input.companyName.trim() || 'Your contractor'
  const forProject = input.projectName ? ` for ${input.projectName}` : ''
  const expiresLine = input.expiresAt ? `This link expires on ${new Date(input.expiresAt).toDateString()}.` : ''

  const subject = `${companyName} sent you an estimate${forProject}`
  const textParts = [
    `Hi ${greetingName},`,
    '',
    `${companyName} has shared an estimate${forProject} with you.`,
    '',
    ...(input.message ? [input.message, ''] : []),
    `View the estimate: ${input.shareUrl}`,
    ...(expiresLine ? ['', expiresLine] : []),
    '',
    'Sent via Sitelayer.',
  ]
  const htmlParts = [
    `<p>Hi ${escapeHtml(greetingName)},</p>`,
    `<p><strong>${escapeHtml(companyName)}</strong> has shared an estimate${escapeHtml(forProject)} with you.</p>`,
    ...(input.message ? [`<p>${escapeHtml(input.message)}</p>`] : []),
    `<p><a href="${input.shareUrl}">View the estimate</a></p>`,
    ...(expiresLine ? [`<p>${escapeHtml(expiresLine)}</p>`] : []),
    '<p>Sent via Sitelayer.</p>',
  ]
  return { subject, text: textParts.join('\n'), html: htmlParts.join('\n') }
}

export type EstimateShareEmailDeps = {
  pool: Pool
  logger: Logger
  /** Injectable for tests; defaults to the worker's shared sendEmail. */
  sendEmail?: typeof defaultSendEmail
  /** Injectable for tests; defaults to APP_PUBLIC_URL / prod fallback. */
  portalBaseUrl?: string
}

type ShareGuardRow = {
  id: string
  revoked_at: string | null
  expires_at: string | null
  expired: boolean
  project_name: string | null
  company_name: string | null
}

/**
 * Build the send_estimate_share runner — a drainAgentMutations wrapper that
 * validates the payload, re-checks the share row is still live, renders the
 * template, and delivers via the shared provider-agnostic sendEmail.
 */
export function createEstimateShareEmailRunner(deps: EstimateShareEmailDeps) {
  const { pool, logger, sendEmail = defaultSendEmail } = deps
  const portalBaseUrl = (deps.portalBaseUrl ?? resolvePortalBaseUrl()).replace(/\/$/, '')

  return async function drainEstimateShareEmails(companyId: string): Promise<AgentDrainSummary> {
    return drainAgentMutations<EstimateShareEmailPayload>(
      pool,
      'send_estimate_share',
      companyId,
      'send_estimate_share',
      async (client: PoolClient, cid: string, payload: EstimateShareEmailPayload) => {
        const shareId = typeof payload?.estimate_share_link_id === 'string' ? payload.estimate_share_link_id : null
        if (!shareId) {
          throw new Error('send_estimate_share payload missing estimate_share_link_id')
        }
        const recipientEmail = typeof payload?.recipient_email === 'string' ? payload.recipient_email.trim() : ''
        if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
          throw new Error(`send_estimate_share ${shareId}: payload recipient_email is missing or invalid`)
        }
        const shareUrlPath = typeof payload?.share_url_path === 'string' ? payload.share_url_path : ''
        if (!shareUrlPath.startsWith('/')) {
          throw new Error(`send_estimate_share ${shareId}: payload share_url_path is missing or not a path`)
        }

        // Re-read the share in the drain's tx (RLS GUC already bound): a
        // revoked or expired share must not be emailed, but the row should
        // still complete (skip), not retry forever.
        const guard = await client.query<ShareGuardRow>(
          `select l.id,
                  l.revoked_at,
                  l.expires_at,
                  (l.expires_at is not null and l.expires_at <= now()) as expired,
                  p.name as project_name,
                  c.name as company_name
             from estimate_share_links l
             left join projects p on p.id = l.project_id and p.company_id = l.company_id
             left join companies c on c.id = l.company_id
            where l.company_id = $1 and l.id = $2
            limit 1`,
          [cid, shareId],
        )
        const share = guard.rows[0]
        if (!share) {
          // Hard failure → backoff then park; a missing share row is a bug,
          // not a transient condition, and must stay visible.
          throw new Error(`send_estimate_share: estimate_share_link ${shareId} not found for company`)
        }
        if (share.revoked_at || share.expired) {
          logger.info(
            {
              company_id: cid,
              estimate_share_link_id: shareId,
              revoked: Boolean(share.revoked_at),
              expired: share.expired,
            },
            '[estimate-share-email] share no longer live — skipping send',
          )
          return { insightsCreated: 0 }
        }

        const template = renderEstimateShareEmail({
          recipientName: typeof payload.recipient_name === 'string' ? payload.recipient_name : null,
          companyName: share.company_name ?? 'Your contractor',
          projectName: share.project_name,
          message: typeof payload.message === 'string' && payload.message.trim() ? payload.message.trim() : null,
          shareUrl: `${portalBaseUrl}${shareUrlPath}`,
          expiresAt: share.expires_at,
        })

        const message: EmailMessage = {
          to: recipientEmail,
          subject: template.subject,
          text: template.text,
          html: template.html,
        }
        const result = await sendEmail(message)
        logger.info(
          {
            provider: result.provider,
            messageId: result.messageId,
            company_id: cid,
            estimate_share_link_id: shareId,
            ...redactEmail(message),
          },
          '[estimate-share-email] sent',
        )
        return { insightsCreated: 0 }
      },
    )
  }
}
