import { describe, expect, it } from 'vitest'
import { canCreateWorkRequests, canTriageWorkRequests } from './work-request-permissions.js'
import type { CompanyRole } from '@sitelayer/domain'

describe('work request permissions', () => {
  it.each<CompanyRole>(['admin', 'foreman', 'office', 'member', 'bookkeeper'])(
    'allows %s to create work requests',
    (role) => {
      expect(canCreateWorkRequests(role)).toBe(true)
    },
  )

  it.each<CompanyRole>(['admin', 'foreman', 'office', 'bookkeeper'])('allows %s to triage work requests', (role) => {
    expect(canTriageWorkRequests(role)).toBe(true)
  })

  it('keeps members out of triage actions', () => {
    expect(canTriageWorkRequests('member')).toBe(false)
  })
})
