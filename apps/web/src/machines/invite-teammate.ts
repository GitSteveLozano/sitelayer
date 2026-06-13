import { useCallback, useMemo } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'
import type { CompanyRole } from '@sitelayer/domain'

/**
 * UI machine for the owner "INVITE TEAMMATE" send screen (design msg__94,
 * conformance report M01). Wraps the same one-shot-POST shape as the
 * generic `submitForm` machine (idle ⇄ sending → sent) plus the
 * design's role-grid selection + identifier draft.
 *
 * The send is a single idempotent CRUD write to
 * `POST /api/companies/:id/memberships` (server-side membership upsert),
 * NOT a multi-step workflow — so there is no backend reducer and no
 * outbox. The machine owns only UI state: selected role, identifier
 * draft, in-flight flag, error, and the list of who has been sent.
 *
 * State graph:
 *   editing ─SEND (role chosen + identifier non-empty)▶ sending
 *   sending ─run onDone▶ sent (append sentTo)
 *           ─run onError▶ editing (error set)
 *   sent ─RESET▶ editing (cleared, to invite another)
 *
 * `sent` re-enters `editing` only on RESET (so the screen can show a
 * success toast then offer "invite another"); a stray SEND in `sent` is
 * a no-op.
 */

/** The roles the design's invite grid offers. */
export type InviteDesignRole = 'estimator' | 'foreman' | 'crew' | 'owner' | 'bookkeeper'

export const INVITE_DESIGN_ROLES: readonly InviteDesignRole[] = ['estimator', 'foreman', 'crew', 'owner', 'bookkeeper']

/**
 * Design-role → `company_memberships.role` (the canonical
 * `COMPANY_ROLES` union) mapping.
 *
 * ⚠️ SME REVIEW: this mapping encodes a product decision and is locked
 * by a unit test (`invite-teammate.test.ts`). The non-obvious entries:
 *   - CREW       → 'member'     (field crew = the base member role)
 *   - OWNER      → 'admin'      ('office' normalizes to 'admin' on read, so
 *                               admin is the durable owner role)
 *   - ESTIMATOR  → 'office'     (office persona = pricing/takeoff; collapses
 *                               to admin on read via normalizeCompanyRole)
 *   - FOREMAN    → 'foreman'
 *   - BOOKKEEPER → 'bookkeeper' (finance/payroll-only shell; does not clock
 *                               in and never sees the field surface)
 * If the SME wants estimator to map to 'member' or owner to a distinct
 * role, change the table here + the test in one place.
 */
export const DESIGN_ROLE_TO_COMPANY_ROLE: Record<InviteDesignRole, CompanyRole> = {
  estimator: 'office',
  foreman: 'foreman',
  crew: 'member',
  owner: 'admin',
  bookkeeper: 'bookkeeper',
}

export interface InviteSubmitPayload {
  /** The mapped company role sent to the membership API. */
  role: CompanyRole
  /** Email or Clerk user id entered by the owner. */
  identifier: string
}

type Context = {
  submitter: (payload: InviteSubmitPayload) => Promise<unknown>
  role: InviteDesignRole | null
  identifier: string
  error: string | null
  /** Identifiers successfully invited this session (for multi-invite). */
  sentTo: string[]
}

type Event =
  | { type: 'SELECT_ROLE'; role: InviteDesignRole }
  | { type: 'SET_IDENTIFIER'; value: string }
  | { type: 'SEND' }
  | { type: 'RESET' }

export function createInviteTeammateMachine() {
  return setup({
    types: {
      context: {} as Context,
      input: {} as { submitter: (payload: InviteSubmitPayload) => Promise<unknown> },
      events: {} as Event,
    },
    actors: {
      run: fromPromise<unknown, { payload: InviteSubmitPayload; submitter: Context['submitter'] }>(async ({ input }) =>
        input.submitter(input.payload),
      ),
    },
    guards: {
      // SEND is only valid with a role chosen AND a non-empty identifier.
      canSend: ({ context }) => context.role !== null && context.identifier.trim().length > 0,
    },
  }).createMachine({
    id: 'inviteTeammate',
    initial: 'editing',
    context: ({ input }) => ({
      submitter: input.submitter,
      role: null,
      identifier: '',
      error: null,
      sentTo: [],
    }),
    on: {
      SELECT_ROLE: { actions: assign({ role: ({ event }) => event.role }) },
      SET_IDENTIFIER: { actions: assign({ identifier: ({ event }) => event.value }) },
    },
    states: {
      editing: {
        on: {
          SEND: { guard: 'canSend', target: 'sending', actions: assign({ error: () => null }) },
          RESET: {
            actions: assign({ role: () => null, identifier: () => '', error: () => null }),
          },
        },
      },
      sending: {
        invoke: {
          src: 'run',
          input: ({ context }) => {
            if (!context.role) throw new Error('sending entered without a role')
            return {
              submitter: context.submitter,
              payload: {
                role: DESIGN_ROLE_TO_COMPANY_ROLE[context.role],
                identifier: context.identifier.trim(),
              },
            }
          },
          onDone: {
            target: 'sent',
            actions: assign({
              sentTo: ({ context }) => [...context.sentTo, context.identifier.trim()],
              error: () => null,
            }),
          },
          onError: {
            target: 'editing',
            actions: assign({
              error: ({ event }) => (event.error instanceof Error ? event.error.message : 'invite failed'),
            }),
          },
        },
      },
      sent: {
        on: {
          // Clear the draft to invite the next teammate.
          RESET: {
            target: 'editing',
            actions: assign({ role: () => null, identifier: () => '', error: () => null }),
          },
        },
      },
    },
  })
}

export const inviteTeammateMachine = createInviteTeammateMachine()

export interface InviteTeammateHookResult {
  role: InviteDesignRole | null
  identifier: string
  error: string | null
  sentTo: string[]
  isSending: boolean
  isSent: boolean
  canSend: boolean
  selectRole: (role: InviteDesignRole) => void
  setIdentifier: (value: string) => void
  send: () => void
  reset: () => void
}

export function useInviteTeammate(
  submitter: (payload: InviteSubmitPayload) => Promise<unknown>,
): InviteTeammateHookResult {
  const machine = useMemo(() => createInviteTeammateMachine(), [])
  const [state, send] = useMachine(machine, { input: { submitter } })

  const selectRole = useCallback((role: InviteDesignRole) => send({ type: 'SELECT_ROLE', role }), [send])
  const setIdentifier = useCallback((value: string) => send({ type: 'SET_IDENTIFIER', value }), [send])
  const dispatchSend = useCallback(() => send({ type: 'SEND' }), [send])
  const reset = useCallback(() => send({ type: 'RESET' }), [send])

  const { role, identifier } = state.context
  return {
    role,
    identifier,
    error: state.context.error,
    sentTo: state.context.sentTo,
    isSending: state.matches('sending'),
    isSent: state.matches('sent'),
    canSend: role !== null && identifier.trim().length > 0,
    selectRole,
    setIdentifier,
    send: dispatchSend,
    reset,
  }
}
