import type { QueryResult, QueryResultRow } from 'pg'

/**
 * Minimal query interface satisfied by both `pg.Pool` and `pg.PoolClient`.
 * Kept narrow so the helpers below can be unit-tested against a stub without a
 * live database.
 */
export interface NotificationQueryClient {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>
}

export type EnqueueNotificationInput = {
  companyId: string
  recipientUserId?: string | null
  recipientEmail?: string | null
  kind: string
  subject: string
  text: string
  html?: string | null
  payload?: Record<string, unknown>
}

/**
 * Insert one row into `notifications`. Returns the row id or `null` if the
 * write silently failed (caller is expected to have a pool wired up; this
 * helper doesn't swallow exceptions so the server.ts layer can decide).
 */
export async function enqueueNotificationRow(
  client: NotificationQueryClient,
  input: EnqueueNotificationInput,
): Promise<{ id: string }> {
  const payload = input.payload ?? {}
  const result = await client.query<{ id: string }>(
    `
    insert into notifications (
      company_id, recipient_clerk_user_id, recipient_email, kind, subject, body_text, body_html, payload
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    returning id
    `,
    [
      input.companyId,
      input.recipientUserId ?? null,
      input.recipientEmail ?? null,
      input.kind,
      input.subject,
      input.text,
      input.html ?? null,
      JSON.stringify(payload),
    ],
  )
  const row = result.rows[0]
  if (!row) throw new Error('notification insert returned no row')
  return row
}

export async function listCompanyAdminIds(client: NotificationQueryClient, companyId: string): Promise<string[]> {
  const result = await client.query<{ clerk_user_id: string }>(
    `select cm.clerk_user_id from company_memberships cm where cm.company_id = $1 and cm.role = 'admin'`,
    [companyId],
  )
  return result.rows.map((row: { clerk_user_id: string }) => row.clerk_user_id)
}

/**
 * Recipients for a worker-flagged problem (`wk-issue` ping). The crew-side
 * intent is "send a push to whoever needs to act" — that's the foremen
 * first, with admin/office as a safety net so the ping isn't dropped if a
 * company has no foreman seat assigned yet.
 */
export async function listIssueRecipientUserIds(client: NotificationQueryClient, companyId: string): Promise<string[]> {
  const result = await client.query<{ clerk_user_id: string }>(
    `select cm.clerk_user_id from company_memberships cm
     where cm.company_id = $1 and cm.role in ('foreman', 'admin', 'office')`,
    [companyId],
  )
  return result.rows.map((row) => row.clerk_user_id)
}
