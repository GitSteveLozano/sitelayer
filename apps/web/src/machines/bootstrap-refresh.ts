import { useEffect } from 'react'
import { useMachine } from '@xstate/react'
import { assign, fromPromise, setup } from 'xstate'

import {
  apiGet,
  type BootstrapResponse,
  type CompaniesResponse,
  type QboConnectionResponse,
  type SessionResponse,
  type SyncStatusResponse,
} from '../api.js'

/**
 * Bootstrap-refresh state machine.
 *
 * Replaces the inline `refresh()` callback + Effect 4 in App.tsx that was
 * driving the company-level fetch fan-out (session / bootstrap / companies /
 * sync_status / qbo_connection). The Explore-agent audit identified two real
 * bugs in the legacy implementation:
 *
 *   1. error state never cleared in non-fatal cases — if companies fetch
 *      fails but bootstrap succeeds, the error sticks across subsequent
 *      successful refreshes (App.tsx:280 only clears on the OUTER catch path).
 *   2. on company-slug change, two effects could race: refresh() and the
 *      offline-replay loop both writing offlineQueue. (Fixed in #76 by giving
 *      the offline machine sole ownership of that state.)
 *
 * This machine fixes (1) by centralising every fetch error into a single
 * `error` context field that's cleared at the start of every refresh.
 *
 * States: idle → loading → { loaded | error } → loading on REFRESH /
 * COMPANY_SLUG_CHANGED.
 *
 * Events:
 *   REFRESH               — re-run the fan-out (e.g. after a mutation)
 *   COMPANY_SLUG_CHANGED  — caller switched company; reset and re-fetch
 *   SET_ACTION_ERROR      — record an error from a mutation handler
 *   CLEAR_ERROR           — explicit clear (rare; mostly automatic)
 *
 * Action errors live in the same context.error field as fetch errors so the
 * UI has one place to render them — the legacy code already conflated them
 * but did so unsafely. The machine now does it deliberately.
 */
type Context = {
  companySlug: string
  bootstrap: BootstrapResponse | null
  session: SessionResponse | null
  companies: CompaniesResponse['companies']
  syncStatus: SyncStatusResponse | null
  qboConnection: QboConnectionResponse['connection'] | null
  error: string | null
  /** Bumped on every successful fetch so consumers can re-trigger derived state. */
  refreshKey: number
}

type Event =
  | { type: 'REFRESH' }
  | { type: 'COMPANY_SLUG_CHANGED'; companySlug: string }
  | { type: 'SET_ACTION_ERROR'; message: string }
  | { type: 'CLEAR_ERROR' }

type FetchOutput = {
  session: SessionResponse
  bootstrap: BootstrapResponse
  companies: CompaniesResponse['companies'] | null
  syncStatus: SyncStatusResponse | null
  qboConnection: QboConnectionResponse['connection'] | null
  /** First non-fatal error encountered during the fan-out, if any. */
  partialError: string | null
}

export const bootstrapRefreshMachine = setup({
  types: {
    context: {} as Context,
    input: {} as { companySlug: string },
    events: {} as Event,
  },
  actors: {
    runRefresh: fromPromise<FetchOutput, { companySlug: string }>(async ({ input }) => {
      // session + bootstrap are required — failures throw out to onError.
      // Everything else is best-effort: a partial failure still produces a
      // usable bootstrap, and the first non-fatal error is surfaced as
      // partialError so the UI can show it without blocking the page.
      const [session, bootstrap] = await Promise.all([
        apiGet<SessionResponse>('/api/session', input.companySlug),
        apiGet<BootstrapResponse>('/api/bootstrap', input.companySlug),
      ])

      let companies: CompaniesResponse['companies'] | null = null
      let syncStatus: SyncStatusResponse | null = null
      let qboConnection: QboConnectionResponse['connection'] | null = null
      let partialError: string | null = null

      try {
        const c = await apiGet<CompaniesResponse>('/api/companies', input.companySlug)
        companies = c.companies
      } catch (caught) {
        partialError ??= caught instanceof Error ? caught.message : String(caught)
      }
      try {
        syncStatus = await apiGet<SyncStatusResponse>('/api/sync/status', input.companySlug)
      } catch (caught) {
        partialError ??= caught instanceof Error ? caught.message : String(caught)
      }
      try {
        const qbo = await apiGet<QboConnectionResponse>('/api/integrations/qbo', input.companySlug)
        qboConnection = qbo.connection
        // The qbo response embeds a fresh sync status; prefer it over the
        // earlier /api/sync/status fetch because it can be a tick newer.
        syncStatus = qbo.status
      } catch (caught) {
        partialError ??= caught instanceof Error ? caught.message : String(caught)
      }

      return { session, bootstrap, companies, syncStatus, qboConnection, partialError }
    }),
  },
}).createMachine({
  id: 'bootstrapRefresh',
  initial: 'loading',
  context: ({ input }) => ({
    companySlug: input.companySlug,
    bootstrap: null,
    session: null,
    companies: [],
    syncStatus: null,
    qboConnection: null,
    error: null,
    refreshKey: 0,
  }),
  on: {
    COMPANY_SLUG_CHANGED: {
      target: '.loading',
      actions: assign({
        companySlug: ({ event }) => event.companySlug,
        bootstrap: () => null,
        session: () => null,
        syncStatus: () => null,
        qboConnection: () => null,
        // Don't reset companies — the SPA's CompanySwitcher needs the list
        // to keep rendering during the cross-company fetch. They get
        // refreshed in the next loaded state.
        error: () => null,
      }),
    },
    SET_ACTION_ERROR: {
      actions: assign({
        error: ({ event }) => event.message,
      }),
    },
    CLEAR_ERROR: {
      actions: assign({
        error: () => null,
      }),
    },
  },
  states: {
    loading: {
      // Clear any prior error at the start of every refresh attempt so a
      // success cleanly replaces a previous error (the legacy code only
      // cleared on the outer .then path, missing inner non-fatal errors).
      entry: assign({ error: () => null }),
      invoke: {
        src: 'runRefresh',
        input: ({ context }) => ({ companySlug: context.companySlug }),
        onDone: {
          target: 'loaded',
          actions: assign(({ context, event }) => ({
            session: event.output.session,
            bootstrap: event.output.bootstrap,
            companies: event.output.companies ?? context.companies,
            syncStatus: event.output.syncStatus,
            qboConnection: event.output.qboConnection,
            error: event.output.partialError,
            refreshKey: context.refreshKey + 1,
          })),
        },
        onError: {
          target: 'error',
          actions: assign({
            error: ({ event }) => (event.error instanceof Error ? event.error.message : 'unknown error'),
          }),
        },
      },
    },
    loaded: {
      on: {
        REFRESH: 'loading',
      },
    },
    error: {
      on: {
        REFRESH: 'loading',
      },
    },
  },
})

export type BootstrapRefreshSnapshot = {
  bootstrap: BootstrapResponse | null
  session: SessionResponse | null
  companies: CompaniesResponse['companies']
  syncStatus: SyncStatusResponse | null
  qboConnection: QboConnectionResponse['connection'] | null
  error: string | null
  isLoading: boolean
  refreshKey: number
  refresh: () => void
  setActionError: (message: string) => void
  clearError: () => void
}

/**
 * Hook that mirrors the legacy `refresh` + Effect 4 behaviour. The caller
 * passes `companySlug`; the hook auto-refreshes on slug change. Use
 * `refresh()` to re-run after a mutation, `setActionError(msg)` to surface
 * an action failure into the same banner the UI already renders, and
 * `clearError()` to dismiss explicitly.
 */
export function useBootstrapRefresh(companySlug: string): BootstrapRefreshSnapshot {
  const [state, send] = useMachine(bootstrapRefreshMachine, { input: { companySlug } })

  useEffect(() => {
    send({ type: 'COMPANY_SLUG_CHANGED', companySlug })
  }, [companySlug, send])

  return {
    bootstrap: state.context.bootstrap,
    session: state.context.session,
    companies: state.context.companies,
    syncStatus: state.context.syncStatus,
    qboConnection: state.context.qboConnection,
    error: state.context.error,
    isLoading: state.matches('loading'),
    refreshKey: state.context.refreshKey,
    refresh: () => send({ type: 'REFRESH' }),
    setActionError: (message: string) => send({ type: 'SET_ACTION_ERROR', message }),
    clearError: () => send({ type: 'CLEAR_ERROR' }),
  }
}
