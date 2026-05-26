import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { BootstrapResponse, QboConnectionResponse } from '@/lib/api'

/**
 * Render-smoke tests for the mobile Settings home. The default "home"
 * section renders from the `bootstrap` + `companyRole` props plus the
 * live QBO integration status from `useQboConnection`. We mock that hook
 * to drive the connected / disconnected / pending integration tiles and
 * assert each renders without crashing. The "notifications" sub-section
 * (which mounts the push + notification-prefs screens) is left untested
 * here — see REPORT.
 */

const useQboConnectionMock =
  vi.fn<() => { data: QboConnectionResponse | undefined; isPending: boolean; isError: boolean }>()

vi.mock('@/lib/api', () => ({
  useQboConnection: () => useQboConnectionMock(),
}))

import { MobileSettingsHome } from './settings-home'

afterEach(() => {
  cleanup()
  useQboConnectionMock.mockReset()
})

function wrap(node: ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>)
}

function emptyBootstrap(overrides: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return {
    company: { id: 'c', name: 'Acme Builders', slug: 'acme' },
    template: { slug: 't', name: 'T', description: '' },
    workflowStages: [],
    divisions: [],
    serviceItems: [],
    customers: [],
    projects: [],
    workers: [],
    pricingProfiles: [],
    bonusRules: [],
    integrations: [],
    integrationMappings: [],
    laborEntries: [],
    materialBills: [],
    schedules: [],
    ...overrides,
  }
}

const worker = (id: string, name: string) =>
  ({
    id,
    name,
    role: 'crew',
    version: 1,
    deleted_at: null,
    created_at: '2026-05-01T00:00:00Z',
  }) as BootstrapResponse['workers'][number]

describe('MobileSettingsHome render-smoke', () => {
  it('renders the Settings home with the role label and a pending QBO tile', () => {
    useQboConnectionMock.mockReturnValue({ isPending: true, isError: false, data: undefined })
    wrap(<MobileSettingsHome bootstrap={emptyBootstrap()} companyRole="admin" />)
    expect(screen.getByText('Settings')).toBeTruthy()
    // admin maps to the "Owner / PM" role label in the profile card.
    expect(screen.getByText(/Owner \/ PM/)).toBeTruthy()
    expect(screen.getByText('QuickBooks Online')).toBeTruthy()
    expect(screen.getByText('Checking connection…')).toBeTruthy()
  })

  it('shows the member count and the disconnected QBO status', () => {
    useQboConnectionMock.mockReturnValue({
      isPending: false,
      isError: false,
      data: { connection: null, status: {} as QboConnectionResponse['status'] },
    })
    wrap(
      <MobileSettingsHome
        bootstrap={emptyBootstrap({ workers: [worker('w1', 'Alex'), worker('w2', 'Bo')] })}
        companyRole="foreman"
      />,
    )
    expect(screen.getByText('2 members')).toBeTruthy()
    // Role label is rendered as "Foreman · {company}" in one node.
    expect(screen.getByText(/^Foreman ·/)).toBeTruthy()
    expect(screen.getByText('Not connected')).toBeTruthy()
  })

  it('renders the connected QBO state with a last-sync line', () => {
    useQboConnectionMock.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        connection: {
          id: 'q1',
          provider: 'qbo',
          provider_account_id: 'acct',
          status: 'connected',
          sync_cursor: null,
          last_synced_at: new Date(Date.now() - 5 * 60_000).toISOString(),
          webhook_secret: null,
          version: 1,
          deleted_at: null,
          created_at: '2026-05-01T00:00:00Z',
          updated_at: '2026-05-26T00:00:00Z',
        },
        status: {} as QboConnectionResponse['status'],
      },
    })
    wrap(<MobileSettingsHome bootstrap={emptyBootstrap()} companyRole="admin" />)
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText(/Last sync .*min ago/)).toBeTruthy()
  })
})
