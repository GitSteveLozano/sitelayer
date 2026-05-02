import { describe, expect, it, vi } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import {
  enqueueNotificationRow,
  listCompanyAdminIds,
  listIssueRecipientUserIds,
  type NotificationQueryClient,
} from './notifications.js'

function makeResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return {
    rows,
    rowCount: rows.length,
    command: 'INSERT',
    oid: 0,
    fields: [],
  } as unknown as QueryResult<T>
}

function stubClient<T extends QueryResultRow>(rows: T[]): NotificationQueryClient {
  return {
    query: vi.fn(async () => makeResult(rows)),
  } as unknown as NotificationQueryClient
}

describe('enqueueNotificationRow', () => {
  it('inserts a row and returns its id', async () => {
    const rows = [{ id: '00000000-0000-0000-0000-000000000001' }]
    const client = stubClient(rows)
    const querySpy = client.query as unknown as ReturnType<typeof vi.fn>

    const result = await enqueueNotificationRow(client, {
      companyId: 'company-1',
      recipientUserId: 'user_123',
      kind: 'membership_welcome',
      subject: 'hello',
      text: 'welcome',
      html: '<p>welcome</p>',
      payload: { role: 'admin' },
    })

    expect(result.id).toBe('00000000-0000-0000-0000-000000000001')
    expect(querySpy).toHaveBeenCalledOnce()
    const [sqlArg, valuesArg] = querySpy.mock.calls[0]!
    expect(sqlArg).toMatch(/insert into notifications/)
    expect(valuesArg).toEqual([
      'company-1',
      'user_123',
      null,
      'membership_welcome',
      'hello',
      'welcome',
      '<p>welcome</p>',
      JSON.stringify({ role: 'admin' }),
    ])
  })

  it('defaults recipient_email, body_html, and payload when omitted', async () => {
    const client = stubClient([{ id: 'nid' }])
    const querySpy = client.query as unknown as ReturnType<typeof vi.fn>
    await enqueueNotificationRow(client, {
      companyId: 'company-2',
      kind: 'sync_failure',
      subject: 'boom',
      text: 'it broke',
    })
    const [, valuesArg] = querySpy.mock.calls[0]!
    expect(valuesArg).toEqual(['company-2', null, null, 'sync_failure', 'boom', 'it broke', null, '{}'])
  })

  it('throws if the insert returns no row', async () => {
    const client = stubClient<{ id: string }>([])
    await expect(
      enqueueNotificationRow(client, {
        companyId: 'company-3',
        kind: 'x',
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow(/returned no row/)
  })
})

describe('listCompanyAdminIds', () => {
  it('returns the clerk_user_id column for admins', async () => {
    const client = stubClient([{ clerk_user_id: 'user_a' }, { clerk_user_id: 'user_b' }])
    const ids = await listCompanyAdminIds(client, 'company-1')
    expect(ids).toEqual(['user_a', 'user_b'])
  })

  it('returns [] when no admins exist', async () => {
    const client = stubClient<{ clerk_user_id: string }>([])
    const ids = await listCompanyAdminIds(client, 'company-1')
    expect(ids).toEqual([])
  })
})

describe('listIssueRecipientUserIds', () => {
  it('returns clerk_user_ids for foreman/admin/office roles', async () => {
    const client = stubClient([
      { clerk_user_id: 'user_foreman' },
      { clerk_user_id: 'user_admin' },
      { clerk_user_id: 'user_office' },
    ])
    const querySpy = client.query as unknown as ReturnType<typeof vi.fn>
    const ids = await listIssueRecipientUserIds(client, 'company-1')
    expect(ids).toEqual(['user_foreman', 'user_admin', 'user_office'])
    const [sqlArg] = querySpy.mock.calls[0]!
    expect(sqlArg).toMatch(/role in \('foreman', 'admin', 'office'\)/)
  })
})
