import { useEffect, useState } from 'react'

/**
 * BeforeInstallPromptEvent banner. Captures the browser's deferred
 * install prompt and surfaces a one-row banner the user can tap to
 * install the PWA. Dismissed-state persists in localStorage so the
 * banner doesn't nag — once dismissed it stays gone for 14 days.
 *
 * Chrome / Edge / Android raise the event. iOS Safari doesn't expose
 * BeforeInstallPromptEvent at all (Apple uses Add-to-Home-Screen via
 * the share sheet) so the banner stays hidden there — that's the
 * right behaviour, since prompting iOS users with a button that does
 * nothing would be worse than no banner.
 */
const DISMISS_KEY = 'sitelayer.v2.install-banner-dismissed-at'
const DISMISS_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export function InstallPromptBanner() {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const dismissedAt = Number(window.localStorage.getItem(DISMISS_KEY) ?? 0)
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_TTL_MS) return

    const onPrompt = (e: Event) => {
      // Chrome fires this on first visit when the PWA criteria match.
      // Stash the event so .prompt() can be called from a user gesture.
      e.preventDefault()
      setEvent(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  if (!event) return null

  const onInstall = async () => {
    if (installing) return
    setInstalling(true)
    try {
      await event.prompt()
      const choice = await event.userChoice
      if (choice.outcome === 'dismissed') {
        window.localStorage.setItem(DISMISS_KEY, String(Date.now()))
      }
    } catch {
      // User-agent blocked the prompt or the event already consumed.
    } finally {
      setEvent(null)
      setInstalling(false)
    }
  }

  const onDismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now()))
    setEvent(null)
  }

  return (
    <div className="flex items-center justify-between gap-2 px-4 py-2 bg-card-soft border-b border-line text-[12px]">
      <div className="text-ink-2">Install Sitelayer for faster loads + push notifications.</div>
      <div className="flex items-center gap-2 shrink-0">
        <button type="button" onClick={onDismiss} className="text-ink-3 px-2 py-1" aria-label="Dismiss install prompt">
          Not now
        </button>
        <button type="button" onClick={onInstall} disabled={installing} className="text-accent font-semibold px-2 py-1">
          {installing ? 'Installing…' : 'Install'}
        </button>
      </div>
    </div>
  )
}
