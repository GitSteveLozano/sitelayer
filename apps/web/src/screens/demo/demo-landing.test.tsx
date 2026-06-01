import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// Controllable request mock + a real-shaped ApiError so the screen's
// `instanceof ApiError` + `.status` branches work. The class is defined
// inside the factory because vi.mock is hoisted above top-level decls.
const mockRequest = vi.fn()
vi.mock('@/lib/api/client', () => {
  class ApiError extends Error {
    status: number
    requestId: string | null
    constructor(args: { status: number; path: string; method: string; requestId: string | null; body: unknown }) {
      const bodyError =
        args.body && typeof args.body === 'object' && 'error' in args.body
          ? String((args.body as { error: unknown }).error)
          : `HTTP ${args.status}`
      super(bodyError)
      this.status = args.status
      this.requestId = args.requestId
    }
  }
  return {
    request: (...args: unknown[]) => mockRequest(...args),
    ApiError,
  }
})

import { DemoLanding } from './demo-landing'
import { ApiError } from '@/lib/api/client'

const assignSpy = vi.fn()
const originalLocation = window.location

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, assign: assignSpy },
  })
  assignSpy.mockClear()
  mockRequest.mockReset()
  const meta = document.getElementById('demo-robots-noindex')
  if (meta?.parentNode) meta.parentNode.removeChild(meta)
})
afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
})

function featuresReturns(tier: string | null) {
  mockRequest.mockImplementation((path: string) => {
    if (path === '/api/features') return Promise.resolve({ tier })
    throw new Error(`unexpected request ${path}`)
  })
}

describe('DemoLanding tier gate', () => {
  it('renders a 404 off the demo tier', async () => {
    featuresReturns('preview')
    render(<DemoLanding />)
    await waitFor(() => expect(screen.getByText('404')).toBeTruthy())
    // Access-code field must not exist off the demo tier.
    expect(screen.queryByLabelText('Access code')).toBeNull()
  })

  it('renders a 404 when /api/features fails', async () => {
    mockRequest.mockRejectedValue(new Error('boom'))
    render(<DemoLanding />)
    await waitFor(() => expect(screen.getByText('404')).toBeTruthy())
  })

  it('installs a noindex robots meta tag on mount', async () => {
    featuresReturns('demo')
    render(<DemoLanding />)
    await waitFor(() => expect(screen.getByLabelText('Access code')).toBeTruthy())
    const meta = document.getElementById('demo-robots-noindex') as HTMLMetaElement | null
    expect(meta?.getAttribute('content')).toBe('noindex, nofollow')
  })
})

describe('DemoLanding access code + role flow', () => {
  it('shows the access-code gate first, then role buttons after unlock', async () => {
    featuresReturns('demo')
    render(<DemoLanding />)
    await waitFor(() => expect(screen.getByLabelText('Access code')).toBeTruthy())

    // Roles are hidden until the access code is entered + Continue clicked.
    expect(screen.queryByText(/Owner —/)).toBeNull()

    fireEvent.change(screen.getByLabelText('Access code'), { target: { value: 'open-sesame' } })
    fireEvent.click(screen.getByText('Continue'))

    expect(screen.getByText('Choose a role')).toBeTruthy()
    for (const label of ['Owner', 'Estimator', 'Foreman', 'Crew']) {
      expect(screen.getByText(new RegExp(`${label} —`))).toBeTruthy()
    }
  })

  it('POSTs the role + access code and redirects to the ticket URL', async () => {
    mockRequest.mockImplementation((path: string) => {
      if (path === '/api/features') return Promise.resolve({ tier: 'demo' })
      if (path === '/api/demo/sign-in-link') {
        return Promise.resolve({ redirect_url: 'https://demo.example.com/?__clerk_ticket=tok-owner' })
      }
      throw new Error(`unexpected ${path}`)
    })
    render(<DemoLanding />)
    await waitFor(() => expect(screen.getByLabelText('Access code')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Access code'), { target: { value: 'open-sesame' } })
    fireEvent.click(screen.getByText('Continue'))
    fireEvent.click(screen.getByText(/Owner —/))

    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith('https://demo.example.com/?__clerk_ticket=tok-owner'))
    const call = mockRequest.mock.calls.find((c) => c[0] === '/api/demo/sign-in-link')
    expect(call?.[1]).toMatchObject({
      method: 'POST',
      skipAuth: true,
      json: { role: 'owner', accessCode: 'open-sesame' },
    })
  })

  it('re-locks and warns when the access code is rejected (401)', async () => {
    mockRequest.mockImplementation((path: string) => {
      if (path === '/api/features') return Promise.resolve({ tier: 'demo' })
      if (path === '/api/demo/sign-in-link')
        return Promise.reject(
          new ApiError({
            status: 401,
            path: '/api/demo/sign-in-link',
            method: 'POST',
            requestId: null,
            body: { error: 'invalid access code' },
          }),
        )
      throw new Error(`unexpected ${path}`)
    })
    render(<DemoLanding />)
    await waitFor(() => expect(screen.getByLabelText('Access code')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Access code'), { target: { value: 'stale' } })
    fireEvent.click(screen.getByText('Continue'))
    fireEvent.click(screen.getByText(/Estimator —/))

    await waitFor(() => expect(screen.getByText(/no longer valid/)).toBeTruthy())
    // Back to the access-code gate.
    expect(screen.getByLabelText('Access code')).toBeTruthy()
    expect(assignSpy).not.toHaveBeenCalled()
  })

  it('"Sign in normally" navigates to the real Clerk sign-in', async () => {
    featuresReturns('demo')
    render(<DemoLanding />)
    await waitFor(() => expect(screen.getByLabelText('Access code')).toBeTruthy())
    fireEvent.click(screen.getByText('Sign in normally'))
    expect(assignSpy).toHaveBeenCalledWith('/sign-in')
  })
})
