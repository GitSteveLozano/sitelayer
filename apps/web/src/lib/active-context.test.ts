import { describe, expect, it } from 'vitest'
import { computeActiveContext } from './active-context.js'

describe('computeActiveContext', () => {
  it('admin always wins regardless of assignments or geofence', () => {
    expect(
      computeActiveContext({
        companyRole: 'admin',
        assignments: [{ project_id: 'p1', role: 'worker' }],
        currentProjectId: 'p1',
      }),
    ).toEqual({ kind: 'admin', projectId: 'p1' })
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

  it('member with no assignments falls back to admin scaffold', () => {
    expect(
      computeActiveContext({
        companyRole: 'member',
        assignments: [],
      }),
    ).toEqual({ kind: 'admin', projectId: null })
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
