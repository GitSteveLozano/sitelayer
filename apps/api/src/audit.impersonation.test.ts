import { describe, expect, it } from 'vitest'
import { recordAudit, type AuditExecutor } from './audit.js'

class FakeExec {
  calls: Array<{ text: string; values: unknown[] }> = []
  async query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
    this.calls.push({ text, values: (values as unknown[]) ?? [] })
    return { rows: [] }
  }
  // pg's query type is heavily overloaded; expose a structural AuditExecutor.
  get exec(): AuditExecutor {
    return this as unknown as AuditExecutor
  }
}

describe('recordAudit — impersonated_by (P4b)', () => {
  it('writes impersonated_by from explicit input (position $11)', async () => {
    const ex = new FakeExec()
    await recordAudit(ex.exec, {
      companyId: 'co-1',
      entityType: 'project',
      entityId: 'p-1',
      action: 'updated',
      actorUserId: 'user_subject',
      impersonatedBy: 'user_admin',
    })
    expect(ex.calls).toHaveLength(1)
    const { text, values } = ex.calls[0]!
    expect(text).toMatch(/impersonated_by/)
    expect(values[1]).toBe('user_subject') // actor_user_id stays the effective user
    expect(values[10]).toBe('user_admin') // $11 impersonated_by = the real admin
  })

  it('defaults impersonated_by to null when not impersonating', async () => {
    const ex = new FakeExec()
    await recordAudit(ex.exec, { companyId: 'co-1', entityType: 'project', entityId: 'p-1', action: 'updated' })
    expect(ex.calls[0]!.values[10]).toBeNull()
  })

  it('skips non-auditable entity types entirely', async () => {
    const ex = new FakeExec()
    await recordAudit(ex.exec, { companyId: 'co-1', entityType: 'not_a_domain_entity', entityId: 'x', action: 'a' })
    expect(ex.calls).toHaveLength(0)
  })
})
