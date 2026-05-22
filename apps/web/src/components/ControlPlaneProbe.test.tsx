import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlaneProbe } from './ControlPlaneProbe'

describe('ControlPlaneProbe', () => {
  afterEach(() => {
    cleanup()
    delete window.__controlPlaneProbe
  })

  it('installs a workspace capture probe with company and route state', () => {
    render(
      <ControlPlaneProbe
        companySlug="la-ops"
        projectId="project-1"
        currentTab="projects"
        userRole="admin"
        activeProjectName="Riverside"
        projectState="estimating"
        timeReviewState={null}
        billingReviewState={null}
      />,
    )

    expect(window.__controlPlaneProbe?.version).toBe('sitelayer-1.0.0')
    expect(window.__controlPlaneProbe?.capture()).toMatchObject({
      path: {
        entity_kind: 'project',
        entity_id: 'project-1',
        company_slug: 'la-ops',
        project_id: 'project-1',
        current_tab: 'projects',
      },
      page_state: {
        user_role: 'admin',
        active_project_name: 'Riverside',
        project_state: 'estimating',
        time_review_state: null,
        billing_review_state: null,
      },
    })
  })

  it('cleans up only the probe version it installed', () => {
    const view = render(
      <ControlPlaneProbe
        companySlug="la-ops"
        projectId={null}
        currentTab="work"
        userRole="office"
        activeProjectName={null}
      />,
    )
    window.__controlPlaneProbe = {
      version: 'newer-probe',
      capture: () => ({
        path: { entity_kind: 'company', entity_id: 'la-ops' },
      }),
    }

    view.unmount()

    expect(window.__controlPlaneProbe?.version).toBe('newer-probe')
  })
})
