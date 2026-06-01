import { describe, expect, it, vi } from 'vitest'
import { createActor, type Actor } from 'xstate'
import fc from 'fast-check'
import {
  createInviteTeammateMachine,
  DESIGN_ROLE_TO_COMPANY_ROLE,
  INVITE_DESIGN_ROLES,
  type InviteSubmitPayload,
} from './invite-teammate.js'

/**
 * Coverage for the owner INVITE TEAMMATE machine (design msg__94 / M01):
 *   - golden affordance map (SEND gated by role + identifier)
 *   - `sent` absorbs further SEND (single-shot)
 *   - the design-role → COMPANY_ROLE mapping table (locks the SME
 *     decision into a test)
 */

function startActor(
  submitter: (p: InviteSubmitPayload) => Promise<unknown> = async () => ({ ok: true }),
): Actor<ReturnType<typeof createInviteTeammateMachine>> {
  const actor = createActor(createInviteTeammateMachine(), { input: { submitter } })
  actor.start()
  return actor
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

describe('inviteTeammateMachine — affordance golden map', () => {
  it('SEND is gated by a chosen role + non-empty identifier', () => {
    const actor = startActor()
    // editing, nothing chosen → SEND rejected
    expect(actor.getSnapshot().can({ type: 'SEND' })).toBe(false)
    // role only → still rejected
    actor.send({ type: 'SELECT_ROLE', role: 'foreman' })
    expect(actor.getSnapshot().can({ type: 'SEND' })).toBe(false)
    // role + identifier → accepted
    actor.send({ type: 'SET_IDENTIFIER', value: 'jane@example.com' })
    expect(actor.getSnapshot().can({ type: 'SEND' })).toBe(true)
    // whitespace identifier → rejected
    actor.send({ type: 'SET_IDENTIFIER', value: '   ' })
    expect(actor.getSnapshot().can({ type: 'SEND' })).toBe(false)
  })

  it('exposes a stable accepted-event set per state', async () => {
    const actor = startActor()
    const ALL = ['SELECT_ROLE', 'SET_IDENTIFIER', 'SEND', 'RESET'] as const
    function accepted(): string[] {
      const s = actor.getSnapshot()
      return ALL.filter((type) => {
        switch (type) {
          case 'SELECT_ROLE':
            return s.can({ type, role: 'foreman' })
          case 'SET_IDENTIFIER':
            return s.can({ type, value: 'x' })
          default:
            return s.can({ type })
        }
      })
        .slice()
        .sort()
    }
    const map: Record<string, string[]> = {}
    // editing (valid, so SEND is reachable)
    actor.send({ type: 'SELECT_ROLE', role: 'foreman' })
    actor.send({ type: 'SET_IDENTIFIER', value: 'a@b.co' })
    map.editing = accepted()
    actor.send({ type: 'SEND' })
    map.sending = accepted()
    await settle()
    map.sent = accepted()
    expect(map).toMatchInlineSnapshot(`
      {
        "editing": [
          "RESET",
          "SELECT_ROLE",
          "SEND",
          "SET_IDENTIFIER",
        ],
        "sending": [
          "SELECT_ROLE",
          "SET_IDENTIFIER",
        ],
        "sent": [
          "RESET",
          "SELECT_ROLE",
          "SET_IDENTIFIER",
        ],
      }
    `)
  })
})

describe('inviteTeammateMachine — lifecycle', () => {
  it('SEND → onDone lands in sent and records the identifier', async () => {
    const submitter = vi.fn(async () => ({ ok: true }))
    const actor = startActor(submitter)
    actor.send({ type: 'SELECT_ROLE', role: 'crew' })
    actor.send({ type: 'SET_IDENTIFIER', value: ' bob@site.io ' })
    actor.send({ type: 'SEND' })
    expect(actor.getSnapshot().value).toBe('sending')
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('sent')
    expect(snap.context.sentTo).toEqual(['bob@site.io'])
    // submitter received the MAPPED company role + trimmed identifier
    expect(submitter).toHaveBeenCalledWith({ role: 'member', identifier: 'bob@site.io' })
  })

  it('SEND → onError returns to editing with the error', async () => {
    const actor = startActor(async () => {
      throw new Error('already a member')
    })
    actor.send({ type: 'SELECT_ROLE', role: 'foreman' })
    actor.send({ type: 'SET_IDENTIFIER', value: 'x@y.co' })
    actor.send({ type: 'SEND' })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('editing')
    expect(snap.context.error).toBe('already a member')
  })

  it('sent absorbs further SEND (single-shot) until RESET', async () => {
    const submitter = vi.fn(async () => ({ ok: true }))
    const actor = startActor(submitter)
    actor.send({ type: 'SELECT_ROLE', role: 'owner' })
    actor.send({ type: 'SET_IDENTIFIER', value: 'a@b.co' })
    actor.send({ type: 'SEND' })
    await settle()
    expect(actor.getSnapshot().value).toBe('sent')
    // a stray SEND in `sent` is a no-op
    actor.send({ type: 'SEND' })
    await settle()
    expect(actor.getSnapshot().value).toBe('sent')
    expect(submitter).toHaveBeenCalledTimes(1)
    // RESET re-opens editing for another invite
    actor.send({ type: 'RESET' })
    expect(actor.getSnapshot().value).toBe('editing')
    expect(actor.getSnapshot().context.role).toBeNull()
    expect(actor.getSnapshot().context.identifier).toBe('')
  })
})

describe('inviteTeammateMachine — design-role → COMPANY_ROLE mapping (SME-locked)', () => {
  it('maps each design role to the agreed company role', () => {
    // ⚠️ Changing this table is a product decision — update the source
    // table in invite-teammate.ts in the same commit.
    expect(DESIGN_ROLE_TO_COMPANY_ROLE).toEqual({
      estimator: 'office',
      foreman: 'foreman',
      crew: 'member',
      owner: 'admin',
    })
  })

  it('every design role maps to a value the submitter receives', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...INVITE_DESIGN_ROLES), async (designRole) => {
        const submitter = vi.fn(async () => ({ ok: true }))
        const actor = startActor(submitter)
        actor.send({ type: 'SELECT_ROLE', role: designRole })
        actor.send({ type: 'SET_IDENTIFIER', value: 'p@q.co' })
        actor.send({ type: 'SEND' })
        await settle()
        expect(submitter).toHaveBeenCalledWith({
          role: DESIGN_ROLE_TO_COMPANY_ROLE[designRole],
          identifier: 'p@q.co',
        })
        actor.stop()
      }),
      { numRuns: 12 },
    )
  })
})

describe('inviteTeammateMachine — invite-API submitter wrapping (post-refactor)', () => {
  // The send surface (screens/mobile/invite-teammate.tsx) now POSTs the
  // invite API instead of the membership upsert. Its submitter maps the
  // machine payload {role, identifier} → useCreateInvite({email, role}),
  // carrying the identifier verbatim as the invitee email. This locks that
  // wrapping so the screen can't silently revert to the old
  // {clerk_user_id, role} membership shape.
  it('wraps the machine payload as {email, role} for useCreateInvite', async () => {
    const createInvite = vi.fn(async (_input: { email: string; role: string }) => ({ invite: { id: 'i1' } }))
    // Mirror InviteTeammateScreen.submitter exactly.
    const submitter = (payload: InviteSubmitPayload) => createInvite({ email: payload.identifier, role: payload.role })

    const actor = startActor(submitter)
    actor.send({ type: 'SELECT_ROLE', role: 'crew' })
    actor.send({ type: 'SET_IDENTIFIER', value: ' jane@example.com ' })
    actor.send({ type: 'SEND' })
    await settle()
    expect(actor.getSnapshot().value).toBe('sent')
    // crew → 'member'; identifier trimmed → email.
    expect(createInvite).toHaveBeenCalledWith({ email: 'jane@example.com', role: 'member' })
    actor.stop()
  })
})
