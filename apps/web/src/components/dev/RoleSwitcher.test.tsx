import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RoleSwitcher } from './RoleSwitcher'
import { ACT_AS_STORAGE_KEY } from '@/lib/api/client'

// After a role-flip the component navigates to the site root via
// location.assign('/') (each persona has a different home surface); the
// clear button reloads in place. jsdom doesn't allow reassigning
// location.reload/assign, so we replace the whole `location` object with a
// configurable shim exposing both spies.
const reloadSpy = vi.fn()
const assignSpy = vi.fn()
const originalLocation = window.location
beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, reload: reloadSpy, assign: assignSpy },
  })
  window.localStorage.clear()
  reloadSpy.mockClear()
  assignSpy.mockClear()
})
afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
})

describe('RoleSwitcher', () => {
  it('writes the act-as id to localStorage and navigates to root on role click', () => {
    render(<RoleSwitcher />)
    fireEvent.click(screen.getByTestId('role-switcher-foreman'))
    expect(window.localStorage.getItem(ACT_AS_STORAGE_KEY)).toBe('e2e-foreman')
    expect(assignSpy).toHaveBeenCalledWith('/')
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
