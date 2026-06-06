import { useEffect, useState } from 'react'

/**
 * `pwa-install-sheet` — Sitemap §1 panel 2 ("Install prompt sheet").
 *
 * Captures Chrome / Edge / Android's deferred `beforeinstallprompt` event
 * and surfaces a richer bottom-sheet treatment than the one-row
 * `InstallPromptBanner`. The banner is fine inside the running shell, but
 * for the first-run hand-off the design calls for a full-width sheet with
 * a clear value prop, an Install primary action, and a Not-now secondary.
 *
 * iOS Safari never fires `beforeinstallprompt` — it uses the share-sheet
 * Add-to-Home-Screen flow handled by `SafariLandingScreen`. This sheet
 * stays hidden on iOS by design.
 *
 * Dismissal is sticky: a "Not now" tap stamps localStorage so the sheet
 * stops nagging for 14 days. Once the user installs, the event fires
 * once more with outcome=accepted and we never show the sheet again.
 */
export const INSTALL_SHEET_DISMISS_KEY = 'sitelayer.v2.install-sheet-dismissed-at'
const DISMISS_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 days — same cadence as the banner

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export interface InstallPromptSheetProps {
  /**
   * Optional override to inject the event in tests / Storybook. When
   * omitted the sheet listens for the real `beforeinstallprompt` event.
   */
  forcedEvent?: BeforeInstallPromptEvent | null
}

export function InstallPromptSheet({ forcedEvent }: InstallPromptSheetProps = {}) {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(forcedEvent ?? null)
  const [installing, setInstalling] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (forcedEvent) {
      setEvent(forcedEvent)
      setOpen(true)
      return
    }
    if (typeof window === 'undefined') return
    const dismissedAt = Number(window.localStorage.getItem(INSTALL_SHEET_DISMISS_KEY) ?? 0)
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_TTL_MS) return

    const onPrompt = (e: Event) => {
      // Chrome fires this on first visit when the PWA criteria match.
      // Stash the event so .prompt() can be called from a user gesture.
      e.preventDefault()
      setEvent(e as BeforeInstallPromptEvent)
      setOpen(true)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [forcedEvent])

  if (!event || !open) return null

  const onInstall = async () => {
    if (installing) return
    setInstalling(true)
    try {
      await event.prompt()
      const choice = await event.userChoice
      if (choice.outcome === 'dismissed') {
        window.localStorage.setItem(INSTALL_SHEET_DISMISS_KEY, String(Date.now()))
      }
    } catch {
      // User-agent blocked the prompt or the event already consumed.
    } finally {
      setEvent(null)
      setOpen(false)
      setInstalling(false)
    }
  }

  const onDismiss = () => {
    window.localStorage.setItem(INSTALL_SHEET_DISMISS_KEY, String(Date.now()))
    setEvent(null)
    setOpen(false)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-sheet-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/55"
    >
      <button
        type="button"
        aria-label="Dismiss install prompt"
        onClick={onDismiss}
        className="absolute inset-0 w-full h-full cursor-default"
      />
      <div className="relative w-full max-w-[420px] rounded-t-[18px] bg-bg text-ink pb-[calc(env(safe-area-inset-bottom,0px)+20px)] pt-3 px-5 shadow-[0_-12px_32px_rgba(0,0,0,0.35)]">
        <div className="w-9 h-1.5 rounded-full bg-line mx-auto mb-4" aria-hidden="true" />

        <div className="flex items-start gap-3">
          <div className="w-14 h-14 rounded-2xl bg-accent flex items-center justify-center shrink-0 shadow-[0_6px_16px_rgba(217,144,74,0.3)]">
            <span className="font-display text-[22px] font-bold text-white tracking-tight leading-none">SL</span>
          </div>
          <div className="min-w-0">
            <h2 id="install-sheet-title" className="font-display text-[18px] font-bold tracking-tight leading-tight">
              Install Sitelayer
            </h2>
            <p className="text-[13px] text-ink-3 mt-1 leading-relaxed">
              Faster loads, offline log entry, and push notifications when the schedule changes.
            </p>
          </div>
        </div>

        <ul className="mt-4 space-y-2 text-[12px] text-ink-2">
          <li className="flex items-center gap-2">
            <CheckDot />
            Works offline at the job site
          </li>
          <li className="flex items-center gap-2">
            <CheckDot />
            Push notifications for clock-in + approvals
          </li>
          <li className="flex items-center gap-2">
            <CheckDot />
            Opens in one tap from the home screen
          </li>
        </ul>

        <div className="mt-5 grid grid-cols-1 gap-2">
          <button
            type="button"
            onClick={onInstall}
            disabled={installing}
            className="w-full h-[48px] rounded-[14px] bg-accent text-white text-[15px] font-semibold inline-flex items-center justify-center disabled:opacity-60"
          >
            {installing ? 'Installing…' : 'Install'}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="w-full h-[44px] rounded-[14px] text-ink-3 text-[14px] font-medium"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}

function CheckDot() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex w-4 h-4 rounded-full bg-good-soft text-good items-center justify-center shrink-0"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" width="10" height="10">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 12l5 5 9-11" />
      </svg>
    </span>
  )
}
