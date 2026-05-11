import { useEffect, useState } from 'react'

/**
 * `pwa-post-install` — Sitemap §1 panel 5 ("Post-install splash").
 *
 * The first time the user opens the app from the home-screen icon
 * (display-mode: standalone) we welcome them with a one-shot branded
 * splash that confirms the install worked. Auto-progresses after a
 * couple of seconds so the field user never has to tap to clear it;
 * the "Get started" button is there for the keyboard / a11y path.
 *
 * Persists a localStorage flag the first time it shows so subsequent
 * standalone launches drop straight into the app. The flag is keyed
 * separately from `SafariLandingScreen`'s flag so we don't conflate
 * "the user dismissed the install hint" with "the user has launched
 * the installed app once".
 */
export const POST_INSTALL_SPLASH_KEY = 'sitelayer.v2.post-install-splash-shown'

export interface PostInstallSplashProps {
  /**
   * Override for tests / Storybook. When omitted the splash decides
   * whether to render based on display-mode + localStorage flag.
   */
  forceShow?: boolean
  /** Called once the splash dismisses (auto or via button). */
  onDismiss?: () => void
}

export function PostInstallSplash({ forceShow, onDismiss }: PostInstallSplashProps = {}) {
  const [show, setShow] = useState<boolean>(Boolean(forceShow))

  useEffect(() => {
    if (forceShow) {
      setShow(true)
      return
    }
    if (typeof window === 'undefined') return
    if (window.localStorage.getItem(POST_INSTALL_SPLASH_KEY)) return
    const standalone =
      (typeof navigator !== 'undefined' && (navigator as unknown as { standalone?: boolean }).standalone === true) ||
      window.matchMedia('(display-mode: standalone)').matches
    if (!standalone) return
    setShow(true)
  }, [forceShow])

  useEffect(() => {
    if (!show) return
    // Auto-dismiss after a beat so the field user never has to tap
    // through a splash to start their day. Keyboard / a11y users can
    // hit the Get started button.
    const t = window.setTimeout(() => {
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(POST_INSTALL_SPLASH_KEY, String(Date.now()))
        } catch {
          // localStorage may throw in private-mode iOS — splash will
          // just re-show on next launch, which is fine.
        }
      }
      setShow(false)
      onDismiss?.()
    }, 2400)
    return () => window.clearTimeout(t)
  }, [show, onDismiss])

  const dismiss = () => {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(POST_INSTALL_SPLASH_KEY, String(Date.now()))
      } catch {
        // localStorage may throw in private-mode iOS — splash will just
        // re-show on next launch, which is fine.
      }
    }
    setShow(false)
    onDismiss?.()
  }

  if (!show) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="post-install-splash-title"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-ink text-[#f3ecdf] px-6"
    >
      <div className="flex-1" />
      <div className="text-center">
        <div className="w-20 h-20 rounded-[20px] bg-accent inline-flex items-center justify-center mb-5 shadow-[0_8px_32px_rgba(217,144,74,0.5)]">
          <span className="font-display text-[36px] font-bold text-white tracking-tight leading-none">SL</span>
        </div>
        <h1 id="post-install-splash-title" className="font-display text-[20px] font-bold tracking-tight">
          Sitelayer
        </h1>
        <p className="text-[12px] text-[#8a8278] mt-1">Construction operations</p>
        <p className="text-[13px] text-[#aea69a] mt-6 max-w-[26ch] leading-relaxed mx-auto">
          You're installed. The app now opens from your home screen and works offline at the job site.
        </p>
      </div>

      <div className="flex-1 flex flex-col items-center justify-end w-full pb-[calc(env(safe-area-inset-bottom,0px)+24px)]">
        <div className="w-[140px]">
          <div className="h-[3px] bg-[#3a342d] rounded-full overflow-hidden">
            <div className="h-full bg-accent w-[45%] animate-[post-install-bar_1.6s_ease-in-out_infinite]" />
          </div>
          <div className="text-[10px] text-[#5a5346] text-center mt-2 font-mono tabular-nums">
            Syncing projects · offline ready
          </div>
        </div>

        <button
          type="button"
          onClick={dismiss}
          className="mt-6 w-full max-w-[280px] h-[44px] rounded-[14px] bg-accent text-white text-[14px] font-semibold inline-flex items-center justify-center"
        >
          Get started
        </button>
      </div>

      <style>{`
        @keyframes post-install-bar {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(80%); }
          100% { transform: translateX(220%); }
        }
      `}</style>
    </div>
  )
}
