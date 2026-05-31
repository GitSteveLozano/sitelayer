import {
  dispatchDailyLogEvent,
  fetchDailyLogSnapshot,
  type DailyLogHumanEvent,
  type DailyLogSnapshot,
} from '@/lib/api'
import { createHeadlessWorkflowMachine, type HeadlessWorkflowHookResult } from './headless-workflow'

/**
 * Headless daily-log lifecycle machine. The `daily_log` reducer is a
 * deliberately minimal two-state lifecycle (draft → submitted via a
 * single SUBMIT event), so the generic headless-workflow factory is the
 * correct fit — exactly like billing-review / estimate-push.
 *
 * This machine owns ONLY the lifecycle UI orchestration over the server
 * snapshot: loading / idle / submitting, `outOfSync` on a 409, and a
 * `refresh` that reloads the snapshot. It never mirrors the business
 * state — the screen renders `snapshot.state` / `snapshot.context` /
 * `snapshot.next_events` verbatim.
 *
 * The daily-log-SPECIFIC editor UX (notes debounce/autosave, one-shot
 * auto-assembly prefill, apply-proposal PATCH) is content editing on the
 * separate `version` counter, NOT a lifecycle transition, so it lives in
 * the editor hook/components, not here.
 */
const { machine, useHook } = createHeadlessWorkflowMachine<DailyLogSnapshot, DailyLogHumanEvent>({
  id: 'dailyLog',
  load: (id) => fetchDailyLogSnapshot(id),
  submit: (id, event, stateVersion) => dispatchDailyLogEvent(id, event, stateVersion),
})

export const dailyLogMachine = machine

export type DailyLogMachineResult = HeadlessWorkflowHookResult<DailyLogSnapshot, DailyLogHumanEvent>

export function useDailyLogWorkflow(id: string, companySlug: string): DailyLogMachineResult {
  return useHook(id, companySlug)
}
