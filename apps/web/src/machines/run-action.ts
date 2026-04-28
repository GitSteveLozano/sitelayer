import { useCallback, useState } from 'react'
import { toastError, toastSuccess } from '../components/ui/toast.js'

type RunActionOptions = {
  skipRefresh?: boolean
}

type UseRunActionInputs = {
  refresh: () => Promise<void>
  refreshSummary: (projectId: string) => Promise<void>
  clearError: () => void
  setActionError: (message: string) => void
  selectedProjectId: string
}

export type RunActionFn = (label: string, action: () => Promise<void>, options?: RunActionOptions) => Promise<void>

/**
 * Wraps the busy/error/refresh lifecycle that every UI mutation goes
 * through:
 *   1. mark `busy = label` and clear any prior banner
 *   2. await the action
 *   3. on success, refresh the bootstrap fan-out (and the per-project
 *      summary if a project is selected) unless `options.skipRefresh`
 *   4. surface a success toast for a small allowlist of user-visible
 *      labels (other labels are mutation-internal and would be noisy)
 *   5. on error, show the banner via `setActionError` and an error toast
 *   6. always clear the busy flag in `finally`
 *
 * Returns `{ busy, runAction }` — `busy` is the current label-or-null,
 * which views use to disable buttons; `runAction` is the wrapper itself.
 */
export function useRunAction(inputs: UseRunActionInputs): { busy: string | null; runAction: RunActionFn } {
  const { refresh, refreshSummary, clearError, setActionError, selectedProjectId } = inputs
  const [busy, setBusy] = useState<string | null>(null)

  const runAction = useCallback<RunActionFn>(
    async (label, action, options) => {
      try {
        setBusy(label)
        clearError()
        await action()
        if (!options?.skipRefresh) {
          await refresh()
          if (selectedProjectId) {
            await refreshSummary(selectedProjectId)
          }
        }
        if (label === 'create-company') toastSuccess('Company created')
        if (label === 'invite-member') toastSuccess('Invitation sent')
        if (label === 'qbo-sync') toastSuccess('QBO sync triggered')
      } catch (caught: unknown) {
        const message = caught instanceof Error ? caught.message : 'unknown error'
        setActionError(message)
        toastError(`${label} failed`, message)
      } finally {
        setBusy(null)
      }
    },
    [refresh, refreshSummary, clearError, setActionError, selectedProjectId],
  )

  return { busy, runAction }
}
