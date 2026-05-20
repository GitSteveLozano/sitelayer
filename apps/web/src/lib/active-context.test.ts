import { describe, expect, it } from 'vitest'
import { availableRoleModes, computeActiveContext, normalizeRoleMode } from './active-context.js'

describe('computeActiveContext', () => {
  it('admin is the default for admin users regardless of assignments or geofence', () => {
    expect(
      computeActiveContext({
        companyRole: 'admin',
        assignments: [{ project_id: 'p1', role: 'worker' }],
        currentProjectId: 'p1',
      }),
    ).toEqual({ kind: 'admin', projectId: 'p1' })
  })

  it('allows an admin user to enter foreman mode when assigned as foreman', () => {
    expect(
      computeActiveContext({
        companyRole: 'admin',
        assignments: [
          { project_id: 'p1', role: 'foreman' },
          { project_id: 'p2', role: 'worker' },
        ],
        modeOverride: 'foreman',
      }),
    ).toEqual({ kind: 'foreman', projectId: null })
  })

  it('ignores unavailable mode overrides', () => {
    expect(
      computeActiveContext({
        companyRole: 'admin',
        assignments: [],
        modeOverride: 'worker',
      }),
    ).toEqual({ kind: 'admin', projectId: null })
  })

  it('aliases legacy office company role to admin', () => {
    expect(
      computeActiveContext({
        companyRole: 'office',
        assignments: [],
      }),
    ).toEqual({ kind: 'admin', projectId: null })
  })

  it('promotes to foreman when assigned on the current project', () => {
    expect(
      computeActiveContext({
        companyRole: 'foreman',
        assignments: [
          { project_id: 'p1', role: 'foreman' },
          { project_id: 'p2', role: 'worker' },
        ],
        currentProjectId: 'p1',
      }),
    ).toEqual({ kind: 'foreman', projectId: 'p1' })
  })

  it('promotes to worker on a project where the user is only a worker', () => {
    expect(
      computeActiveContext({
        companyRole: 'foreman',
        assignments: [
          { project_id: 'p1', role: 'foreman' },
          { project_id: 'p2', role: 'worker' },
        ],
        currentProjectId: 'p2',
      }),
    ).toEqual({ kind: 'worker', projectId: 'p2' })
  })

  it('falls back to default home when no project is selected', () => {
    expect(
      computeActiveContext({
        companyRole: 'foreman',
        assignments: [{ project_id: 'p1', role: 'foreman' }],
      }),
    ).toEqual({ kind: 'foreman', projectId: null })
  })

  it('foreman company role defaults to the foreman shell before project assignment', () => {
    expect(
      computeActiveContext({
        companyRole: 'foreman',
        assignments: [],
      }),
    ).toEqual({ kind: 'foreman', projectId: null })
  })

  it('worker default home when only worker assignments exist', () => {
    expect(
      computeActiveContext({
        companyRole: 'member',
        assignments: [
          { project_id: 'p1', role: 'worker' },
          { project_id: 'p2', role: 'worker' },
        ],
      }),
    ).toEqual({ kind: 'worker', projectId: null })
  })

  it('foreman wins over worker for default home when both exist', () => {
    expect(
      computeActiveContext({
        companyRole: 'member',
        assignments: [
          { project_id: 'p1', role: 'worker' },
          { project_id: 'p2', role: 'foreman' },
        ],
      }),
    ).toEqual({ kind: 'foreman', projectId: null })
  })

  it('member with no assignments stays in the worker shell', () => {
    expect(
      computeActiveContext({
        companyRole: 'member',
        assignments: [],
      }),
    ).toEqual({ kind: 'worker', projectId: null })
  })

  it('non-matching currentProjectId falls back to default home', () => {
    expect(
      computeActiveContext({
        companyRole: 'foreman',
        assignments: [{ project_id: 'p1', role: 'foreman' }],
        currentProjectId: 'p99',
      }),
    ).toEqual({ kind: 'foreman', projectId: null })
  })
})

describe('availableRoleModes', () => {
  it('is admin-first for multi-role admin users', () => {
    expect(
      availableRoleModes({
        companyRole: 'admin',
        assignments: [
          { project_id: 'p1', role: 'worker' },
          { project_id: 'p2', role: 'foreman' },
        ],
      }),
    ).toEqual(['admin', 'foreman', 'worker'])
  })

  it('does not expose admin mode to field-only users', () => {
    expect(
      availableRoleModes({
        companyRole: 'member',
        assignments: [{ project_id: 'p1', role: 'worker' }],
      }),
    ).toEqual(['worker'])
  })

  it('defaults plain members without assignments to worker mode', () => {
    expect(
      availableRoleModes({
        companyRole: 'member',
        assignments: [],
      }),
    ).toEqual(['worker'])
  })
})

describe('normalizeRoleMode', () => {
  it('accepts only shell role modes', () => {
    expect(normalizeRoleMode('admin')).toBe('admin')
    expect(normalizeRoleMode('foreman')).toBe('foreman')
    expect(normalizeRoleMode('worker')).toBe('worker')
    expect(normalizeRoleMode('member')).toBeNull()
    expect(normalizeRoleMode(null)).toBeNull()
  })
})
