import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { InstallPromptSheet, INSTALL_SHEET_DISMISS_KEY } from '../install-prompt-sheet'
import { PostInstallSplash, POST_INSTALL_SPLASH_KEY } from '../post-install-splash'
import { SafariLandingScreen } from '../safari-landing'
import { LocationPrimeScreen } from '../location-prime'
import { NotificationsPrimeScreen } from '../notifications-prime'

// Sanity tests covering the five PWA onboarding surfaces. The screens
// don't depend on the API layer, so isolated render + interaction
// coverage is enough to catch regressions in the install / permission
// copy and the localStorage gating.

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SafariLandingScreen', () => {
  test('renders the install copy and the 3-step share-sheet walkthrough', () => {
    const onSkip = vi.fn()
    render(<SafariLandingScreen onSkip={onSkip} />)
    expect(screen.getByText(/Run the day from your pocket/i)).toBeTruthy()
    expect(screen.getByRole('list', { name: /Add to Home Screen instructions/i })).toBeTruthy()
    expect(screen.getByText(/Tap the Share button/i)).toBeTruthy()
    expect(screen.getByText(/Choose/i)).toBeTruthy()
    expect(screen.getByText(/open Sitelayer from your home screen/i)).toBeTruthy()
  })

  test('Skip button stamps localStorage and calls onSkip', () => {
    const onSkip = vi.fn()
    render(<SafariLandingScreen onSkip={onSkip} />)
    fireEvent.click(screen.getByRole('button', { name: /Skip — I'll install later/i }))
    expect(onSkip).toHaveBeenCalledOnce()
    expect(window.localStorage.getItem('sitelayer.v2.safari-landing-dismissed-at')).not.toBeNull()
  })
})

describe('InstallPromptSheet', () => {
  test('renders nothing when no beforeinstallprompt has fired', () => {
    const { container } = render(<InstallPromptSheet />)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  test('renders the dialog when an event is forced + dismiss writes localStorage', async () => {
    const fakeEvent = {
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: 'dismissed' as const, platform: 'web' }),
      preventDefault: vi.fn(),
    } as unknown as Event & {
      prompt: () => Promise<void>
      userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
    }
    render(<InstallPromptSheet forcedEvent={fakeEvent} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(/Install Sitelayer/i)).toBeTruthy()
    expect(screen.getByText(/Works offline at the job site/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Not now/i }))
    expect(window.localStorage.getItem(INSTALL_SHEET_DISMISS_KEY)).not.toBeNull()
  })

  test('respects the dismiss TTL — does not render when previously dismissed', () => {
    window.localStorage.setItem(INSTALL_SHEET_DISMISS_KEY, String(Date.now()))
    const { container } = render(<InstallPromptSheet />)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('LocationPrimeScreen', () => {
  test('renders the prime card with reason copy', () => {
    render(
      <MemoryRouter initialEntries={['/permissions/location']}>
        <Routes>
          <Route path="/permissions/location" element={<LocationPrimeScreen />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText(/Allow "Sitelayer" to use your location/i)).toBeTruthy()
    expect(screen.getByText(/clock you in when you arrive at a job site/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Allow While Using App/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Don't Allow/i })).toBeTruthy()
  })
})

describe('NotificationsPrimeScreen', () => {
  test('renders the category list and the Allow CTA', () => {
    render(
      <MemoryRouter initialEntries={['/permissions/notifications']}>
        <Routes>
          <Route path="/permissions/notifications" element={<NotificationsPrimeScreen />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText(/Get notified when work changes/i)).toBeTruthy()
    expect(screen.getByText(/Tomorrow's assignment/i)).toBeTruthy()
    expect(screen.getByText(/Schedule changes/i)).toBeTruthy()
    expect(screen.getByText(/Approval requests/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Allow notifications/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Maybe later/i })).toBeTruthy()
  })
})

describe('PostInstallSplash', () => {
  test('renders when forced + clicking Get started persists the seen flag', () => {
    render(<PostInstallSplash forceShow />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Sitelayer')).toBeTruthy()
    expect(screen.getByText(/You're installed/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Get started/i }))
    expect(window.localStorage.getItem(POST_INSTALL_SPLASH_KEY)).not.toBeNull()
  })

  test('auto-dismisses after the timer fires', () => {
    vi.useFakeTimers()
    try {
      const onDismiss = vi.fn()
      render(<PostInstallSplash forceShow onDismiss={onDismiss} />)
      expect(screen.getByRole('dialog')).toBeTruthy()
      act(() => {
        vi.advanceTimersByTime(2500)
      })
      expect(onDismiss).toHaveBeenCalled()
      expect(window.localStorage.getItem(POST_INSTALL_SPLASH_KEY)).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  test('stays hidden when the seen flag is already set + not standalone', () => {
    window.localStorage.setItem(POST_INSTALL_SPLASH_KEY, String(Date.now()))
    const { container } = render(<PostInstallSplash />)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })
})
