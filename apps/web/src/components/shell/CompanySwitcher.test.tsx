import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Mock the API client BEFORE importing the SUT so `request` is the
// vi.fn() spy. We also stub `getActiveCompanySlug` so the component's
// "which slug is currently active" read is fully under test control —
// otherwise the function would peek at localStorage / env defaults and
// the membership-selection assertions get fuzzy. vi.hoisted keeps the
// fakes alive across the `vi.mock` hoist so the import-time reference
// from inside the factory resolves.
const mocks = vi.hoisted(() => ({
  requestMock: vi.fn(),
  activeCompanySlugMock: vi.fn<() => string>(),
}))

vi.mock('@/lib/api/client', () => ({
  request: mocks.requestMock,
  getActiveCompanySlug: mocks.activeCompanySlugMock,
  ACTIVE_COMPANY_STORAGE_KEY: 'sitelayer.active-company-slug',
}))

import { CompanySwitcher } from './CompanySwitcher'

// Kept in lockstep with the same constant in `@/lib/api/client.ts` and
// the value in the vi.mock above. Hardcoded here so the test doesn't
// silently pass against an undefined key (the component imports the
// constant from the mocked client module).
const ACTIVE_COMPANY_STORAGE_KEY = 'sitelayer.active-company-slug'

// The component reloads the page after a company switch so cached
// TanStack Query / XState state can't drift from the new tenancy.
// jsdom doesn't allow reassigning `location.reload`, so we replace
// the whole `location` object with a configurable shim (same trick
// the RoleSwitcher test uses).
const reloadSpy = vi.fn()
const originalLocation = window.location

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
  return Wrapper
}

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, reload: reloadSpy },
  })
  window.localStorage.clear()
  reloadSpy.mockClear()
  mocks.requestMock.mockReset()
  mocks.activeCompanySlugMock.mockReset()
  mocks.activeCompanySlugMock.mockReturnValue('acme-co')
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
})

describe('CompanySwitcher', () => {
  it('renders nothing when the user has zero memberships', async () => {
    mocks.requestMock.mockResolvedValue({ memberships: [] })
    const Wrapper = makeWrapper()
    const { container } = render(
      <Wrapper>
        <CompanySwitcher />
      </Wrapper>,
    )
    // Wait for the query to settle so the conditional render runs.
    await waitFor(() => expect(mocks.requestMock).toHaveBeenCalled())
    expect(container.querySelector('[data-testid="company-switcher"]')).toBeNull()
  })

  it('renders nothing when the user has exactly one membership', async () => {
    mocks.requestMock.mockResolvedValue({
      memberships: [{ company_id: 'co-1', company_slug: 'acme-co', company_name: 'Acme Co', role: 'admin' }],
    })
    const Wrapper = makeWrapper()
    const { container } = render(
      <Wrapper>
        <CompanySwitcher />
      </Wrapper>,
    )
    await waitFor(() => expect(mocks.requestMock).toHaveBeenCalled())
    expect(container.querySelector('[data-testid="company-switcher"]')).toBeNull()
  })

  it('renders the dropdown with all options when the user has 2+ memberships', async () => {
    mocks.requestMock.mockResolvedValue({
      memberships: [
        { company_id: 'co-1', company_slug: 'acme-co', company_name: 'Acme Co', role: 'admin' },
        { company_id: 'co-2', company_slug: 'globex', company_name: 'Globex Inc', role: 'foreman' },
      ],
    })
    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <CompanySwitcher />
      </Wrapper>,
    )
    const select = (await screen.findByTestId('company-switcher-select')) as HTMLSelectElement
    expect(select).toBeTruthy()
    // Options surfaced — the test ids are per-slug so we can assert
    // both companies and roles made it through.
    expect(screen.getByTestId('company-switcher-option-acme-co').textContent).toContain('Acme Co')
    expect(screen.getByTestId('company-switcher-option-acme-co').textContent).toContain('admin')
    expect(screen.getByTestId('company-switcher-option-globex').textContent).toContain('Globex Inc')
    expect(screen.getByTestId('company-switcher-option-globex').textContent).toContain('foreman')
    // The active slug from getActiveCompanySlug() is what the select shows.
    expect(select.value).toBe('acme-co')
  })

  it('writes localStorage and reloads when the user selects a different company', async () => {
    mocks.requestMock.mockResolvedValue({
      memberships: [
        { company_id: 'co-1', company_slug: 'acme-co', company_name: 'Acme Co', role: 'admin' },
        { company_id: 'co-2', company_slug: 'globex', company_name: 'Globex Inc', role: 'foreman' },
      ],
    })
    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <CompanySwitcher />
      </Wrapper>,
    )
    const select = (await screen.findByTestId('company-switcher-select')) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'globex' } })
    expect(window.localStorage.getItem(ACTIVE_COMPANY_STORAGE_KEY)).toBe('globex')
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it('does not reload when the user re-picks the already-active company', async () => {
    mocks.requestMock.mockResolvedValue({
      memberships: [
        { company_id: 'co-1', company_slug: 'acme-co', company_name: 'Acme Co', role: 'admin' },
        { company_id: 'co-2', company_slug: 'globex', company_name: 'Globex Inc', role: 'foreman' },
      ],
    })
    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <CompanySwitcher />
      </Wrapper>,
    )
    const select = (await screen.findByTestId('company-switcher-select')) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'acme-co' } })
    expect(reloadSpy).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(ACTIVE_COMPANY_STORAGE_KEY)).toBeNull()
  })

  it('falls back to the first membership when the active slug is not in the list', async () => {
    mocks.activeCompanySlugMock.mockReturnValue('not-a-member-anymore')
    mocks.requestMock.mockResolvedValue({
      memberships: [
        { company_id: 'co-1', company_slug: 'acme-co', company_name: 'Acme Co', role: 'admin' },
        { company_id: 'co-2', company_slug: 'globex', company_name: 'Globex Inc', role: 'foreman' },
      ],
    })
    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <CompanySwitcher />
      </Wrapper>,
    )
    const select = (await screen.findByTestId('company-switcher-select')) as HTMLSelectElement
    expect(select.value).toBe('acme-co')
  })
})
