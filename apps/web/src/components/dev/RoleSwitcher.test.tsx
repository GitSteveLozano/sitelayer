import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RoleSwitcher } from './RoleSwitcher'
import { ACT_AS_STORAGE_KEY } from '@/lib/api/client'

// The component reloads the page after a role-flip so cached
// TanStack Query / XState state can't drift from the new identity.
// jsdom doesn't allow reassigning `location.reload`, so we replace
// the whole `location` object with a configurable shim.
const reloadSpy = vi.fn()
const originalLocation = window.location
beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, reload: reloadSpy },
  })
  window.localStorage.clear()
  reloadSpy.mockClear()
})
afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
})

describe('RoleSwitcher', () => {
  it('writes the act-as id to localStorage and reloads on role click', () => {
    render(<RoleSwitcher />)
    fireEvent.click(screen.getByTestId('role-switcher-foreman'))
    expect(window.localStorage.getItem(ACT_AS_STORAGE_KEY)).toBe('e2e-foreman')
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it('highlights the currently-active role on mount', () => {
    window.localStorage.setItem(ACT_AS_STORAGE_KEY, 'e2e-admin')
    render(<RoleSwitcher />)
    const admin = screen.getByTestId('role-switcher-admin')
    expect(admin.getAttribute('aria-pressed')).toBe('true')
    const foreman = screen.getByTestId('role-switcher-foreman')
    expect(foreman.getAttribute('aria-pressed')).toBe('false')
  })

  it('renders all five role buttons', () => {
    render(<RoleSwitcher />)
    for (const role of ['admin', 'foreman', 'office', 'member', 'bookkeeper']) {
      expect(screen.getByTestId(`role-switcher-${role}`)).toBeTruthy()
    }
  })

  it('clears the override and reloads when the clear button is pressed', () => {
    window.localStorage.setItem(ACT_AS_STORAGE_KEY, 'e2e-office')
    render(<RoleSwitcher />)
    fireEvent.click(screen.getByTestId('role-switcher-clear'))
    expect(window.localStorage.getItem(ACT_AS_STORAGE_KEY)).toBeNull()
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it('collapses to a handle and re-expands', () => {
    render(<RoleSwitcher />)
    fireEvent.click(screen.getByLabelText('Collapse role switcher'))
    const handle = screen.getByTestId('role-switcher-handle')
    expect(handle.textContent).toMatch(/role:/)
    fireEvent.click(handle)
    expect(screen.getByTestId('role-switcher')).toBeTruthy()
  })
})
