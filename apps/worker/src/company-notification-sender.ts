import type { Pool, PoolClient } from 'pg'

/**
 * Per-company notification sender resolution (multi-tenant email).
 *
 * The `from` address for every outbound notification has always come from a
 * single process-wide env (EMAIL_FROM, default 'noreply@sitelayer.sandolab.xyz';
 * see email.ts:loadEmailConfig). With multiple companies onboarding, that means
 * every tenant's customers get mail from one generic, unbranded address.
 *
 * Migration 150 added `companies.notification_from_email` /
 * `notification_from_name` so the sender CAN differ per company. This module is
 * the READ path with an env fallback: a company that has not set a custom
 * sender (the default for every existing row — both columns are NULL) resolves
 * to exactly the env `from` it used before, so behavior is unchanged.
 *
 * EXPAND-ONLY STATUS: this resolver is NOT yet wired into the actual send path.
 * Sending from a per-company address safely requires domain/sender VERIFICATION
 * (SPF/DKIM/DMARC) per company first — see docs/MULTI_TENANCY.md "Flagged
 * follow-ups". Shipping the resolver now (a) makes the schema usable, (b) gives
 * future code a single, tested seam, and (c) keeps the env as the safe default.
 *
 * The DB read tolerates the OLD schema (pre-migration-150): an undefined_column
 * error (42703) resolves to the env fallback rather than failing the drain, so
 * a worker that deploys ahead of the migration stays safe.
 */

export interface CompanyNotificationSender {
  /** Bare email address used as the envelope/From address. */
  email: string
  /** Optional display name (null when none configured). */
  name: string | null
  /** True when the email came from a per-company override (not the env default). */
  perCompany: boolean
}

/**
 * Format a sender into a single `From:` header value. With a display name:
 * `"Acme Construction" <noreply@acme.com>`. Without: the bare address.
 */
export function formatSenderFromHeader(sender: Pick<CompanyNotificationSender, 'email' | 'name'>): string {
  const name = sender.name?.trim()
  if (!name) return sender.email
  // Quote the display name and escape embedded quotes/backslashes per RFC 5322.
  const escaped = name.replace(/[\\"]/g, (c) => `\\${c}`)
  return `"${escaped}" <${sender.email}>`
}

/**
 * Pure combiner: given the per-company row (or null) and the env fallback,
 * decide the effective sender. Exposed so the fallback truth table is unit
 * testable without a DB. A blank/whitespace per-company email falls back to
 * the env (an operator who clears the field reverts to the default).
 */
export function resolveSender(
  row: { notification_from_email: string | null; notification_from_name: string | null } | null,
  envFrom: string,
): CompanyNotificationSender {
  const customEmail = row?.notification_from_email?.trim()
  if (customEmail) {
    return {
      email: customEmail,
      name: row?.notification_from_name?.trim() || null,
      perCompany: true,
    }
  }
  return { email: envFrom, name: null, perCompany: false }
}

/**
 * Read the per-company sender for `companyId`, falling back to `envFrom`
 * (typically loadEmailConfig().from). Never throws on the missing-column case;
 * any other error propagates.
 */
export async function resolveCompanyNotificationSender(
  executor: Pick<Pool | PoolClient, 'query'>,
  companyId: string,
  envFrom: string,
): Promise<CompanyNotificationSender> {
  try {
    const result = await executor.query<{
      notification_from_email: string | null
      notification_from_name: string | null
    }>(
      `select notification_from_email, notification_from_name
         from companies
        where id = $1
        limit 1`,
      [companyId],
    )
    return resolveSender(result.rows[0] ?? null, envFrom)
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '42703') {
      // Pre-migration-150 schema: column absent → env fallback, never fail.
      return resolveSender(null, envFrom)
    }
    throw err
  }
}
