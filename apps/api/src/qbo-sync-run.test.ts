import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'

// Mock the metrics module — `observeWorkflowEvent` reaches into prom-client
// and we don't want test runs to mutate the global registry counters.
vi.mock('./metrics.js', () => ({
  observeWorkflowEvent: vi.fn(),
}))

// Mock the ledger writers so we can assert call shape without touching pg.
vi.mock('./mutation-tx.js', () => ({
  recordMutationOutbox: vi.fn(),
  recordWorkflowEvent: vi.fn(),
}))

import { completeQboSyncRunFailure, completeQboSyncRunSuccess, startQboSyncRun } from './qbo-sync-run.js'
import * as mutationTx from './mutation-tx.js'
import * as metrics from './metrics.js'

type QueryHandler = (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>

/**
 * Stub PoolClient — we only consume `.query()`. The handler routes by SQL
 * substring to return either a freshly-created row, an updated row, or a
 * locked snapshot, mirroring the qbo_sync_runs DDL fields that the helpers
 * read back.
 */
function makeClient(handler: QueryHandler): PoolClient & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => handler(sql, params))
  return { query } as unknown as PoolClient & { query: ReturnType<typeof vi.fn> }
}

const baseRow = {
  id: 'run-1',
  company_id: 'co-1',
  integration_connection_id: 'conn-1',
  state_version: 1 as number,
  started_at: null as string | null,
  succeeded_at: null as string | null,
  failed_at: null as string | null,
  retried_at: null as string | null,
  error: null as string | null,
  snapshot: null as Record<string, unknown> | null,
  triggered_by: 'user-7' as string | null,
}

describe('startQboSyncRun', () => {
  beforeEach(() => {
    vi.mocked(mutationTx.recordMutationOutbox).mockClear()
    vi.mocked(mutationTx.recordWorkflowEvent).mockClear()
    vi.mocked(metrics.observeWorkflowEvent).mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('inserts a pending row, dispatches START_SYNC, writes the workflow event, and emits an outbox row', async () => {
    const client = makeClient(async (sql) => {
      if (sql.includes('insert into qbo_sync_runs')) {
        return { rows: [{ ...baseRow, status: 'pending' }] }
      }
      if (sql.includes('update qbo_sync_runs')) {
        return {
          rows: [
            {
              ...baseRow,
              status: 'syncing',
              state_version: 2,
              started_at: '2026-05-17T12:00:00.000Z',
            },
          ],
        }
      }
      throw new Error(`Unhandled SQL: ${sql.slice(0, 80)}`)
    })

    const { run, snapshot } = await startQboSyncRun(client, {
      companyId: 'co-1',
      integrationConnectionId: 'conn-1',
      triggeredBy: 'user-7',
    })

    // The returned snapshot reflects the post-START_SYNC state.
    expect(snapshot.state).toBe('syncing')
    expect(snapshot.state_version).toBe(2)
    expect(snapshot.started_at).toBeTruthy()
    expect(snapshot.error).toBeNull()
    expect(run.status).toBe('syncing')

    // INSERT, then UPDATE.
    const queries = client.query.mock.calls.map(([sql]) => sql as string)
    expect(queries.some((sql) => sql.includes('insert into qbo_sync_runs'))).toBe(true)
    expect(queries.some((sql) => sql.includes('update qbo_sync_runs'))).toBe(true)

    // Workflow event log written against the prior (pending) state_version=1.
    expect(mutationTx.recordWorkflowEvent).toHaveBeenCalledTimes(1)
    const eventCall = vi.mocked(mutationTx.recordWorkflowEvent).mock.calls[0]!
    expect(eventCall[1]).toMatchObject({
      companyId: 'co-1',
      workflowName: 'qbo_sync_run',
      entityType: 'qbo_sync_run',
      entityId: 'run-1',
      stateVersion: 1,
      eventType: 'START_SYNC',
      actorUserId: 'user-7',
    })

    // Outbox emits the run_qbo_sync side-effect anchor.
    expect(mutationTx.recordMutationOutbox).toHaveBeenCalledTimes(1)
    const outboxArgs = vi.mocked(mutationTx.recordMutationOutbox).mock.calls[0]!
    expect(outboxArgs[0]).toBe('co-1') // companyId
    expect(outboxArgs[1]).toBe('qbo_sync_run') // entityType
    expect(outboxArgs[2]).toBe('run-1') // entityId
    expect(outboxArgs[3]).toBe('run_qbo_sync') // mutationType
    expect(outboxArgs[5]).toBe('qbo_sync_run:run:run-1') // idempotencyKey

    expect(metrics.observeWorkflowEvent).toHaveBeenCalledWith('qbo_sync_run', 'requested')
  })
})

describe('completeQboSyncRunSuccess', () => {
  beforeEach(() => {
    vi.mocked(mutationTx.recordMutationOutbox).mockClear()
    vi.mocked(mutationTx.recordWorkflowEvent).mockClear()
    vi.mocked(metrics.observeWorkflowEvent).mockClear()
  })

  it('reads the locked syncing row, dispatches SYNC_SUCCEEDED, updates the row, and writes the event log', async () => {
    const client = makeClient(async (sql) => {
      if (sql.includes('for update')) {
        return {
          rows: [
            {
              ...baseRow,
              status: 'syncing',
              state_version: 2,
              started_at: '2026-05-17T12:00:00.000Z',
            },
          ],
        }
      }
      if (sql.includes('update qbo_sync_runs')) {
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unhandled SQL: ${sql.slice(0, 80)}`)
    })

    await completeQboSyncRunSuccess(client, {
      companyId: 'co-1',
      runId: 'run-1',
      snapshot: { customers_pulled: 12 },
      triggeredBy: 'user-7',
    })

    const queries = client.query.mock.calls.map(([sql]) => sql as string)
    expect(queries.some((sql) => sql.includes('for update'))).toBe(true)
    expect(queries.some((sql) => sql.includes('update qbo_sync_runs'))).toBe(true)

    expect(mutationTx.recordWorkflowEvent).toHaveBeenCalledTimes(1)
    const eventCall = vi.mocked(mutationTx.recordWorkflowEvent).mock.calls[0]!
    expect(eventCall[1]).toMatchObject({
      stateVersion: 2,
      eventType: 'SYNC_SUCCEEDED',
      entityId: 'run-1',
    })

    expect(metrics.observeWorkflowEvent).toHaveBeenCalledWith('qbo_sync_run', 'succeeded')
  })

  it('is a no-op when the row is not found (no event log, no metric)', async () => {
    const client = makeClient(async (sql) => {
      if (sql.includes('for update')) return { rows: [] }
      throw new Error(`Unhandled SQL: ${sql.slice(0, 80)}`)
    })

    await completeQboSyncRunSuccess(client, {
      companyId: 'co-1',
      runId: 'missing',
      snapshot: {},
      triggeredBy: 'user-7',
    })

    expect(mutationTx.recordWorkflowEvent).not.toHaveBeenCalled()
    expect(metrics.observeWorkflowEvent).not.toHaveBeenCalled()
  })

  it('rejects illegal transitions (calling success from pending state)', async () => {
    const client = makeClient(async (sql) => {
      if (sql.includes('for update')) {
        return { rows: [{ ...baseRow, status: 'pending', state_version: 1 }] }
      }
      throw new Error(`Unhandled SQL: ${sql.slice(0, 80)}`)
    })

    await expect(
      completeQboSyncRunSuccess(client, {
        companyId: 'co-1',
        runId: 'run-1',
        snapshot: {},
        triggeredBy: 'user-7',
      }),
    ).rejects.toThrow(/illegal transition from pending on SYNC_SUCCEEDED/)
    expect(mutationTx.recordWorkflowEvent).not.toHaveBeenCalled()
    expect(metrics.observeWorkflowEvent).not.toHaveBeenCalled()
  })
})

describe('completeQboSyncRunFailure', () => {
  beforeEach(() => {
    vi.mocked(mutationTx.recordMutationOutbox).mockClear()
    vi.mocked(mutationTx.recordWorkflowEvent).mockClear()
    vi.mocked(metrics.observeWorkflowEvent).mockClear()
  })

  it('dispatches SYNC_FAILED and writes the event log + metric', async () => {
    const client = makeClient(async (sql) => {
      if (sql.includes('for update')) {
        return {
          rows: [
            {
              ...baseRow,
              status: 'syncing',
              state_version: 2,
              started_at: '2026-05-17T12:00:00.000Z',
            },
          ],
        }
      }
      if (sql.includes('update qbo_sync_runs')) return { rows: [], rowCount: 1 }
      throw new Error(`Unhandled SQL: ${sql.slice(0, 80)}`)
    })

    await completeQboSyncRunFailure(client, {
      companyId: 'co-1',
      runId: 'run-1',
      error: 'QBO API error: 503',
      triggeredBy: 'user-7',
    })

    expect(mutationTx.recordWorkflowEvent).toHaveBeenCalledTimes(1)
    const eventCall = vi.mocked(mutationTx.recordWorkflowEvent).mock.calls[0]!
    expect(eventCall[1]).toMatchObject({
      stateVersion: 2,
      eventType: 'SYNC_FAILED',
      entityId: 'run-1',
    })
    expect((eventCall[1].eventPayload as { error: string }).error).toBe('QBO API error: 503')
    expect(metrics.observeWorkflowEvent).toHaveBeenCalledWith('qbo_sync_run', 'failed')
  })

  it('rejects illegal transitions (calling failure from a succeeded state)', async () => {
    const client = makeClient(async (sql) => {
      if (sql.includes('for update')) {
        return { rows: [{ ...baseRow, status: 'succeeded', state_version: 3 }] }
      }
      throw new Error(`Unhandled SQL: ${sql.slice(0, 80)}`)
    })

    await expect(
      completeQboSyncRunFailure(client, {
        companyId: 'co-1',
        runId: 'run-1',
        error: 'boom',
        triggeredBy: 'user-7',
      }),
    ).rejects.toThrow(/illegal transition from succeeded on SYNC_FAILED/)
    expect(mutationTx.recordWorkflowEvent).not.toHaveBeenCalled()
  })
})
