import { useCallback } from 'react'
import { useMachine } from '@xstate/react'
import { assign, setup } from 'xstate'

/**
 * Pure-UI orchestration machine for the onboarding wizard
 * (`apps/web/src/screens/onboarding/wizard.tsx`).
 *
 * The original screen kept its step + form state in 6+ `useState`
 * hooks across the parent and child step components. Tab order /
 * back-navigation / inline-error recovery were all hand-rolled.
 *
 * This machine owns ONLY UI orchestration:
 *   - the active step
 *   - per-step form drafts (`companyForm`, `teamForm`, `seedOptions`)
 *   - error string for the current step
 *
 * The TanStack mutations themselves still live in the parent component
 * — the machine emits `SUBMIT` and the parent kicks off the network
 * call, then `MARK_SUBMITTED` / `MARK_FAILED` to advance or surface an
 * error. This keeps the machine framework-free and unit-testable
 * without standing up MSW or query clients.
 *
 * State graph:
 *
 *   company_step ──NEXT (guard: slug + name non-empty)──▶ team_step
 *                ──SUBMIT──▶ submitting (parent calls createCompany)
 *   submitting ──MARK_SUBMITTED──▶ team_step
 *              ──MARK_FAILED──▶ error (preserves form so user can retry)
 *   team_step ──NEXT──▶ seed_step
 *             ──BACK──▶ company_step
 *   seed_step ──NEXT/SUBMIT──▶ done
 *             ──BACK──▶ team_step
 *   error ──RETRY──▶ submitting
 *         ──BACK──▶ company_step
 *
 * Guards:
 *   - `NEXT` from `company_step` requires `companyForm.slug` and
 *     `companyForm.name` to be non-empty (trimmed) — matches the
 *     original screen's `disabled={!slug.trim() || !companyName.trim()}`.
 */

export interface CompanyForm {
  slug: string
  name: string
  seedDefaults: boolean
}

export interface InvitedTeamMember {
  clerkUserId: string
  role: string
}

export interface TeamForm {
  pendingClerkUserId: string
  pendingRole: string
  invited: InvitedTeamMember[]
}

export interface SeedOptions {
  customerName: string
  workerName: string
  yardName: string
}

type Context = {
  companyForm: CompanyForm
  teamForm: TeamForm
  seedOptions: SeedOptions
  /** Error surfaced by the company-step create-company mutation. */
  error: string | null
  /**
   * Optional hint text shown beneath the slug field after a 409 with a
   * server-supplied `suggested_slug`. Cleared the next time the user
   * edits the slug, or when the create succeeds.
   */
  slugHint: string | null
  /** Inline error for the team-step invite mutation (substep-controlled). */
  teamError: string | null
  /** Inline error for the seed-step seed inserts (substep-controlled). */
  seedError: string | null
  /** True while the seed-step is firing its parallel mutations. */
  seedSubmitting: boolean
}

export type OnboardingWizardEvent =
  | { type: 'NEXT' }
  | { type: 'BACK' }
  | { type: 'SUBMIT' }
  | { type: 'RETRY' }
  | { type: 'MARK_SUBMITTED' }
  | { type: 'MARK_FAILED'; error: string }
  /**
   * 409 from POST /api/companies with a server-supplied `suggested_slug`.
   * Auto-populates the slug field with the suggestion and surfaces a
   * one-line hint under the input so the user understands the change.
   * Routes back to `company_step` so the user can keep editing the form.
   */
  | { type: 'SLUG_SUGGESTION'; suggestion: string; hint?: string }
  | { type: 'SET_COMPANY_FIELD'; field: keyof CompanyForm; value: string | boolean }
  | { type: 'SET_TEAM_FIELD'; field: 'pendingClerkUserId' | 'pendingRole'; value: string }
  | { type: 'APPEND_INVITED'; member: InvitedTeamMember }
  | { type: 'CLEAR_PENDING_INVITE' }
  | { type: 'SET_SEED_FIELD'; field: keyof SeedOptions; value: string }
  // New, controlled-substep events (Phase: lift state out of TeamStep /
  // SeedStep). `ADD_INVITE` is a higher-level alias for the
  // pending-id + APPEND_INVITED dance; the substep components can emit
  // it after a successful invite mutation without holding their own
  // pending-id state. `REMOVE_INVITE` lets the team list trim entries.
  // `SET_SEED` is the spec-shaped alias for `SET_SEED_FIELD`.
  | { type: 'ADD_INVITE'; clerkUserId: string; role: string }
  | { type: 'REMOVE_INVITE'; clerkUserId: string }
  | { type: 'SET_SEED'; field: keyof SeedOptions; value: string }
  | { type: 'SET_TEAM_ERROR'; error: string | null }
  | { type: 'SET_SEED_ERROR'; error: string | null }
  | { type: 'SET_SEED_SUBMITTING'; submitting: boolean }
  | { type: 'DISMISS_ERROR' }

const DEFAULT_TEAM_FORM: TeamForm = {
  pendingClerkUserId: '',
  pendingRole: 'foreman',
  invited: [],
}

const DEFAULT_SEED_OPTIONS: SeedOptions = {
  customerName: '',
  workerName: '',
  yardName: 'Main yard',
}

const DEFAULT_COMPANY_FORM: CompanyForm = {
  slug: '',
  name: '',
  seedDefaults: true,
}

export const onboardingWizardMachine = setup({
  types: {
    context: {} as Context,
    input: {} as { companyForm?: Partial<CompanyForm>; seedOptions?: Partial<SeedOptions> },
    events: {} as OnboardingWizardEvent,
  },
  guards: {
    companyFormValid: ({ context }) =>
      context.companyForm.slug.trim().length > 0 && context.companyForm.name.trim().length > 0,
  },
  actions: {
    clearError: assign({ error: () => null }),
    clearSlugHint: assign({ slugHint: () => null }),
    setError: assign({
      error: ({ context, event }) => (event.type === 'MARK_FAILED' ? event.error : context.error),
    }),
    applySlugSuggestion: assign({
      companyForm: ({ context, event }) => {
        if (event.type !== 'SLUG_SUGGESTION') return context.companyForm
        return { ...context.companyForm, slug: event.suggestion } as CompanyForm
      },
      slugHint: ({ context, event }) => {
        if (event.type !== 'SLUG_SUGGESTION') return context.slugHint
        return (
          event.hint ??
          `That slug is taken. We've picked \`${event.suggestion}\` — feel free to change it before continuing.`
        )
      },
      error: () => null,
    }),
    setCompanyField: assign({
      companyForm: ({ context, event }) => {
        if (event.type !== 'SET_COMPANY_FIELD') return context.companyForm
        return { ...context.companyForm, [event.field]: event.value } as CompanyForm
      },
      // Editing the slug invalidates the auto-suggested hint — once the
      // user types over it, the hint becomes stale and would be
      // confusing if it stuck around.
      slugHint: ({ context, event }) => {
        if (event.type !== 'SET_COMPANY_FIELD') return context.slugHint
        if (event.field === 'slug') return null
        return context.slugHint
      },
    }),
    setTeamField: assign({
      teamForm: ({ context, event }) => {
        if (event.type !== 'SET_TEAM_FIELD') return context.teamForm
        return { ...context.teamForm, [event.field]: event.value }
      },
    }),
    appendInvited: assign({
      teamForm: ({ context, event }) => {
        if (event.type !== 'APPEND_INVITED') return context.teamForm
        return {
          ...context.teamForm,
          invited: [...context.teamForm.invited, event.member],
          pendingClerkUserId: '',
        }
      },
    }),
    clearPendingInvite: assign({
      teamForm: ({ context }) => ({ ...context.teamForm, pendingClerkUserId: '' }),
    }),
    setSeedField: assign({
      seedOptions: ({ context, event }) => {
        if (event.type !== 'SET_SEED_FIELD') return context.seedOptions
        return { ...context.seedOptions, [event.field]: event.value }
      },
    }),
    addInvite: assign({
      teamForm: ({ context, event }) => {
        if (event.type !== 'ADD_INVITE') return context.teamForm
        // Idempotent — don't append duplicate clerk ids.
        if (context.teamForm.invited.some((row) => row.clerkUserId === event.clerkUserId)) {
          return { ...context.teamForm, pendingClerkUserId: '' }
        }
        return {
          ...context.teamForm,
          invited: [...context.teamForm.invited, { clerkUserId: event.clerkUserId, role: event.role }],
          pendingClerkUserId: '',
        }
      },
    }),
    removeInvite: assign({
      teamForm: ({ context, event }) => {
        if (event.type !== 'REMOVE_INVITE') return context.teamForm
        return {
          ...context.teamForm,
          invited: context.teamForm.invited.filter((row) => row.clerkUserId !== event.clerkUserId),
        }
      },
    }),
    setSeed: assign({
      seedOptions: ({ context, event }) => {
        if (event.type !== 'SET_SEED') return context.seedOptions
        return { ...context.seedOptions, [event.field]: event.value }
      },
    }),
    setTeamError: assign({
      teamError: ({ context, event }) => (event.type === 'SET_TEAM_ERROR' ? event.error : context.teamError),
    }),
    setSeedError: assign({
      seedError: ({ context, event }) => (event.type === 'SET_SEED_ERROR' ? event.error : context.seedError),
    }),
    setSeedSubmitting: assign({
      seedSubmitting: ({ context, event }) =>
        event.type === 'SET_SEED_SUBMITTING' ? event.submitting : context.seedSubmitting,
    }),
  },
}).createMachine({
  id: 'onboardingWizard',
  initial: 'company_step',
  context: ({ input }) => ({
    companyForm: { ...DEFAULT_COMPANY_FORM, ...(input.companyForm ?? {}) },
    teamForm: { ...DEFAULT_TEAM_FORM },
    seedOptions: { ...DEFAULT_SEED_OPTIONS, ...(input.seedOptions ?? {}) },
    error: null,
    slugHint: null,
    teamError: null,
    seedError: null,
    seedSubmitting: false,
  }),
  // Form-field mutations and error dismissal are valid in any state.
  on: {
    SET_COMPANY_FIELD: { actions: 'setCompanyField' },
    SET_TEAM_FIELD: { actions: 'setTeamField' },
    APPEND_INVITED: { actions: 'appendInvited' },
    CLEAR_PENDING_INVITE: { actions: 'clearPendingInvite' },
    SET_SEED_FIELD: { actions: 'setSeedField' },
    ADD_INVITE: { actions: 'addInvite' },
    REMOVE_INVITE: { actions: 'removeInvite' },
    SET_SEED: { actions: 'setSeed' },
    SET_TEAM_ERROR: { actions: 'setTeamError' },
    SET_SEED_ERROR: { actions: 'setSeedError' },
    SET_SEED_SUBMITTING: { actions: 'setSeedSubmitting' },
    DISMISS_ERROR: { actions: 'clearError' },
  },
  states: {
    company_step: {
      on: {
        SUBMIT: {
          target: 'submitting',
          guard: 'companyFormValid',
          actions: 'clearError',
        },
        NEXT: {
          target: 'submitting',
          guard: 'companyFormValid',
          actions: 'clearError',
        },
      },
    },
    submitting: {
      on: {
        MARK_SUBMITTED: {
          target: 'team_step',
          actions: ['clearError', 'clearSlugHint'],
        },
        MARK_FAILED: {
          target: 'error',
          actions: 'setError',
        },
        // 409 → server gave us a free candidate slug. Pop back to the
        // company step with the field pre-filled + hint visible.
        SLUG_SUGGESTION: {
          target: 'company_step',
          actions: 'applySlugSuggestion',
        },
      },
    },
    error: {
      on: {
        RETRY: {
          target: 'submitting',
          guard: 'companyFormValid',
          actions: 'clearError',
        },
        BACK: {
          target: 'company_step',
          actions: 'clearError',
        },
        // Same flow if the suggestion arrives after MARK_FAILED routed
        // us to the error state — apply it and go back to editing.
        SLUG_SUGGESTION: {
          target: 'company_step',
          actions: 'applySlugSuggestion',
        },
      },
    },
    team_step: {
      on: {
        NEXT: 'seed_step',
        BACK: 'company_step',
      },
    },
    seed_step: {
      on: {
        SUBMIT: 'done',
        NEXT: 'done',
        BACK: 'team_step',
      },
    },
    done: {
      type: 'final',
    },
  },
})

export type OnboardingWizardState = 'company_step' | 'submitting' | 'error' | 'team_step' | 'seed_step' | 'done'

export interface OnboardingWizardHookResult {
  state: OnboardingWizardState
  companyForm: CompanyForm
  teamForm: TeamForm
  seedOptions: SeedOptions
  error: string | null
  slugHint: string | null
  teamError: string | null
  seedError: string | null
  seedSubmitting: boolean
  isCompanyStep: boolean
  isTeamStep: boolean
  isSeedStep: boolean
  isSubmitting: boolean
  isError: boolean
  isDone: boolean
  canAdvanceFromCompany: boolean
  next: () => void
  back: () => void
  submit: () => void
  retry: () => void
  markSubmitted: () => void
  markFailed: (error: string) => void
  applySlugSuggestion: (suggestion: string, hint?: string) => void
  setCompanyField: (field: keyof CompanyForm, value: string | boolean) => void
  setTeamField: (field: 'pendingClerkUserId' | 'pendingRole', value: string) => void
  appendInvited: (member: InvitedTeamMember) => void
  clearPendingInvite: () => void
  setSeedField: (field: keyof SeedOptions, value: string) => void
  addInvite: (clerkUserId: string, role: string) => void
  removeInvite: (clerkUserId: string) => void
  setSeed: (field: keyof SeedOptions, value: string) => void
  setTeamError: (error: string | null) => void
  setSeedError: (error: string | null) => void
  setSeedSubmitting: (submitting: boolean) => void
  dismissError: () => void
}

export function useOnboardingWizard(
  options: { companyForm?: Partial<CompanyForm>; seedOptions?: Partial<SeedOptions> } = {},
): OnboardingWizardHookResult {
  const input: { companyForm?: Partial<CompanyForm>; seedOptions?: Partial<SeedOptions> } = {}
  if (options.companyForm !== undefined) input.companyForm = options.companyForm
  if (options.seedOptions !== undefined) input.seedOptions = options.seedOptions
  const [state, send] = useMachine(onboardingWizardMachine, { input })

  const next = useCallback(() => send({ type: 'NEXT' }), [send])
  const back = useCallback(() => send({ type: 'BACK' }), [send])
  const submit = useCallback(() => send({ type: 'SUBMIT' }), [send])
  const retry = useCallback(() => send({ type: 'RETRY' }), [send])
  const markSubmitted = useCallback(() => send({ type: 'MARK_SUBMITTED' }), [send])
  const markFailed = useCallback((err: string) => send({ type: 'MARK_FAILED', error: err }), [send])
  const applySlugSuggestion = useCallback(
    (suggestion: string, hint?: string) =>
      send(
        hint !== undefined ? { type: 'SLUG_SUGGESTION', suggestion, hint } : { type: 'SLUG_SUGGESTION', suggestion },
      ),
    [send],
  )
  const setCompanyField = useCallback(
    (field: keyof CompanyForm, value: string | boolean) => send({ type: 'SET_COMPANY_FIELD', field, value }),
    [send],
  )
  const setTeamField = useCallback(
    (field: 'pendingClerkUserId' | 'pendingRole', value: string) => send({ type: 'SET_TEAM_FIELD', field, value }),
    [send],
  )
  const appendInvited = useCallback((member: InvitedTeamMember) => send({ type: 'APPEND_INVITED', member }), [send])
  const clearPendingInvite = useCallback(() => send({ type: 'CLEAR_PENDING_INVITE' }), [send])
  const setSeedField = useCallback(
    (field: keyof SeedOptions, value: string) => send({ type: 'SET_SEED_FIELD', field, value }),
    [send],
  )
  const addInvite = useCallback(
    (clerkUserId: string, role: string) => send({ type: 'ADD_INVITE', clerkUserId, role }),
    [send],
  )
  const removeInvite = useCallback((clerkUserId: string) => send({ type: 'REMOVE_INVITE', clerkUserId }), [send])
  const setSeed = useCallback(
    (field: keyof SeedOptions, value: string) => send({ type: 'SET_SEED', field, value }),
    [send],
  )
  const setTeamError = useCallback((err: string | null) => send({ type: 'SET_TEAM_ERROR', error: err }), [send])
  const setSeedError = useCallback((err: string | null) => send({ type: 'SET_SEED_ERROR', error: err }), [send])
  const setSeedSubmitting = useCallback(
    (submitting: boolean) => send({ type: 'SET_SEED_SUBMITTING', submitting }),
    [send],
  )
  const dismissError = useCallback(() => send({ type: 'DISMISS_ERROR' }), [send])

  const currentState = (state.value as OnboardingWizardState) ?? 'company_step'

  return {
    state: currentState,
    companyForm: state.context.companyForm,
    teamForm: state.context.teamForm,
    seedOptions: state.context.seedOptions,
    error: state.context.error,
    slugHint: state.context.slugHint,
    teamError: state.context.teamError,
    seedError: state.context.seedError,
    seedSubmitting: state.context.seedSubmitting,
    isCompanyStep: currentState === 'company_step',
    isTeamStep: currentState === 'team_step',
    isSeedStep: currentState === 'seed_step',
    isSubmitting: currentState === 'submitting',
    isError: currentState === 'error',
    isDone: currentState === 'done',
    canAdvanceFromCompany:
      state.context.companyForm.slug.trim().length > 0 && state.context.companyForm.name.trim().length > 0,
    next,
    back,
    submit,
    retry,
    markSubmitted,
    markFailed,
    applySlugSuggestion,
    setCompanyField,
    setTeamField,
    appendInvited,
    clearPendingInvite,
    setSeedField,
    addInvite,
    removeInvite,
    setSeed,
    setTeamError,
    setSeedError,
    setSeedSubmitting,
    dismissError,
  }
}
