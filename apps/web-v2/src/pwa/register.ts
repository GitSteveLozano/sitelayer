import { registerSW } from 'virtual:pwa-register'

/**
 * Service-worker registration shim.
 *
 * `vite-plugin-pwa` generates the SW; this helper hands the host
 * application three callbacks so a UI layer (toast, inline banner) can
 * react to update / offline-ready / registration events when Phase 1
 * adds them.
 *
 * Phase 0 keeps this passive — `register()` schedules the SW but does
 * not surface anything to the user. Update-on-prompt UI lands in Phase 1
 * along with the offline mutation queue.
 */
export interface RegisterOptions {
  onNeedRefresh?: () => void
  onOfflineReady?: () => void
  onRegisterError?: (err: unknown) => void
}

export function registerServiceWorker(opts: RegisterOptions = {}): () => Promise<void> {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh: () => opts.onNeedRefresh?.(),
    onOfflineReady: () => opts.onOfflineReady?.(),
    onRegisterError: (err) => opts.onRegisterError?.(err),
  })
  return updateSW
}
