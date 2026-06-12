import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearOpsDiagnosticControl,
  persistOpsDiagnosticControl,
  readOpsDiagnosticControl,
} from './ops-diagnostic-control'
import type { OpsOnsiteDiagnosticSessionRecord } from '@/lib/api'

const SESSION: OpsOnsiteDiagnosticSessionRecord = {
  id: 'opsdiag_1',
  state: 'active',
  created_at: '2026-06-12T16:00:00.000Z',
  expires_at: '2026-06-12T17:00:00.000Z',
  operator_user_id: 'user_1',
  label: 'Mobile ops',
  intent: 'dispatch_agent_review',
  plan: {
    status: 'ready',
    control_level: 'route',
    recommended_entry: 'dispatch_agent_review',
    can_capture_desktop: true,
    can_route_work: true,
    can_dispatch_agent_review: true,
    blockers: [],
    actions: [],
  },
  audit_events: [],
}

describe('ops diagnostic control storage', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('round-trips a one-browser-session control token by company', () => {
    persistOpsDiagnosticControl('acme', SESSION, 'control-token')

    expect(readOpsDiagnosticControl('acme', Date.parse('2026-06-12T16:30:00.000Z'))).toEqual({
      session_id: 'opsdiag_1',
      control_token: 'control-token',
      expires_at: '2026-06-12T17:00:00.000Z',
    })
    expect(readOpsDiagnosticControl('globex', Date.parse('2026-06-12T16:30:00.000Z'))).toBeNull()
    expect(JSON.stringify(window.sessionStorage)).not.toContain('globex')
  })

  it('drops expired control tokens', () => {
    persistOpsDiagnosticControl('acme', SESSION, 'control-token')

    expect(readOpsDiagnosticControl('acme', Date.parse('2026-06-12T17:00:01.000Z'))).toBeNull()
    expect(readOpsDiagnosticControl('acme', Date.parse('2026-06-12T16:30:00.000Z'))).toBeNull()
  })

  it('clears malformed control state instead of throwing', () => {
    window.sessionStorage.setItem('sitelayer.ops-diagnostic-control.v1:acme', '{bad json')

    expect(readOpsDiagnosticControl('acme', Date.parse('2026-06-12T16:30:00.000Z'))).toBeNull()
    expect(window.sessionStorage.getItem('sitelayer.ops-diagnostic-control.v1:acme')).toBeNull()
  })

  it('clears a stored control token explicitly', () => {
    persistOpsDiagnosticControl('acme', SESSION, 'control-token')

    clearOpsDiagnosticControl('acme')

    expect(readOpsDiagnosticControl('acme', Date.parse('2026-06-12T16:30:00.000Z'))).toBeNull()
  })
})
