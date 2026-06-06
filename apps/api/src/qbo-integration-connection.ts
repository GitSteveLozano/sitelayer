/**
 * `integration_connections` CRUD for QBO and any other provider that
 * stores OAuth credentials. Pool-parameterized so callers can pass an
 * existing transaction client to keep the write atomic with the
 * surrounding ledger row.
 */
import type { Pool } from 'pg'
import type { LedgerExecutor } from './mutation-tx.js'

export async function getIntegrationConnection(
  pool: Pool,
  companyId: string,
  provider: string,
  executor: LedgerExecutor = pool,
) {
  const result = await executor.query(
    `
    select id, provider, provider_account_id, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
    from integration_connections
    where company_id = $1 and provider = $2
    order by created_at desc
    limit 1
    `,
    [companyId, provider],
  )
  return result.rows[0] ?? null
}

export async function getIntegrationConnectionWithSecrets(pool: Pool, companyId: string, provider: string) {
  const result = await pool.query(
    `
    select id, provider, provider_account_id, access_token, refresh_token, webhook_secret, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
    from integration_connections
    where company_id = $1 and provider = $2
    order by created_at desc
    limit 1
    `,
    [companyId, provider],
  )
  return result.rows[0] ?? null
}

export async function upsertIntegrationConnection(
  pool: Pool,
  companyId: string,
  provider: string,
  values: {
    provider_account_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
    webhook_secret?: string | null
    sync_cursor?: string | null
    status?: string | null
    /**
     * Optimistic-concurrency guard. When supplied, the UPDATE only fires
     * if the persisted row still has version === expected_version; if a
     * concurrent caller has already bumped the row, the UPDATE returns
     * zero rows and this function returns `null` so the route can emit
     * 409 (matching the entity-CRUD pattern).
     *
     * `getIntegrationConnection()` reads outside the transaction in the
     * existing route, so without this WHERE clause two concurrent POSTs
     * with the same expected_version both passed the version check and
     * both ran the UPDATE — the second clobbering the first. The
     * version=expected guard moves the gate into the UPDATE itself, so
     * only one of the two writes lands.
     */
    expected_version?: number | null
  },
  executor: LedgerExecutor = pool,
) {
  const existing = await getIntegrationConnection(pool, companyId, provider, executor)
  if (!existing) {
    const inserted = await executor.query(
      `
      insert into integration_connections (
        company_id, provider, provider_account_id, access_token, refresh_token, webhook_secret, sync_cursor, status
      )
      values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, 'connected'))
      returning id, provider, provider_account_id, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
      `,
      [
        companyId,
        provider,
        values.provider_account_id ?? null,
        values.access_token ?? null,
        values.refresh_token ?? null,
        values.webhook_secret ?? null,
        values.sync_cursor ?? null,
        values.status ?? 'connected',
      ],
    )
    return inserted.rows[0]
  }

  const expectedVersion = values.expected_version ?? null
  const updated = await executor.query(
    `
    update integration_connections
    set
      provider_account_id = coalesce($3, provider_account_id),
      access_token = coalesce($4, access_token),
      refresh_token = coalesce($5, refresh_token),
      webhook_secret = coalesce($6, webhook_secret),
      sync_cursor = coalesce($7, sync_cursor),
      status = coalesce($8, status),
      last_synced_at = coalesce(last_synced_at, now()),
      version = version + 1
    where company_id = $1 and provider = $2 and id = $9
      and ($10::int is null or version = $10)
    returning id, provider, provider_account_id, sync_cursor, last_synced_at, retry_state, rate_limit_state, status, version, created_at
    `,
    [
      companyId,
      provider,
      values.provider_account_id ?? null,
      values.access_token ?? null,
      values.refresh_token ?? null,
      values.webhook_secret ?? null,
      values.sync_cursor ?? null,
      values.status ?? null,
      existing.id,
      expectedVersion,
    ],
  )
  // If expected_version was passed and the row has been bumped by a
  // concurrent caller, the UPDATE returns zero rows. Return null so the
  // caller can emit 409 with the live version (mirrors the
  // versioned-update.ts entity-CRUD pattern).
  if (updated.rowCount === 0) {
    if (expectedVersion !== null) return null
    return existing
  }
  return updated.rows[0]
}
