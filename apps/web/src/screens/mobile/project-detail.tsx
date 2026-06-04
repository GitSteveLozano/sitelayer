/**
 * Mobile project detail. The most-used screen in the system per the
 * estimator README. Shows project hero + tab nav + per-tab content.
 *
 * Data is sourced from bootstrap (projects, laborEntries, schedules,
 * materialBills filtered by project_id) plus per-tab TanStack Query hooks:
 *   - Materials  → bootstrap materialBills (vendor bills + share-of-bid)
 *   - Budget     → closeout-summary + labor-variance (bid vs actual)
 *   - Crew       → bootstrap laborEntries grouped by worker
 *   - Log        → useDailyLogs (foreman fm-log outputs for this project)
 *   - Files      → useProjectBlueprints (drawings + scale state)
 * Estimate still opens its dedicated full-screen review route, which owns
 * line items + send-to-client.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import type { CompanyRole } from '@sitelayer/domain'
import { currentCaptureRoutePath } from '@/lib/capture-session'
import { registerCaptureStateProvider } from '@/lib/capture-state-providers'
import { buildProjectDetailStateSnapshot } from '@/lib/project-detail-state-snapshot'
import { MBody, MTopBar } from '../../components/m/index.js'
import { MEmptyState } from '../../components/m-states/index.js'
import { WorkRequestAction } from '../../components/work-requests/WorkRequestAction.js'
import { WorkRequestEntityStatus } from '../../components/work-requests/WorkRequestEntityStatus.js'
import { ProjectHero } from './project-detail/project-hero.js'
import { TabBar } from './project-detail/tab-bar.js'
import { Overview } from './project-detail/overview-tab.js'
import { EstimateTab } from './project-detail/estimate-tab.js'
import { CrewTab } from './project-detail/crew-tab.js'
import { MaterialsTab } from './project-detail/materials-tab.js'
import { BudgetTab } from './project-detail/budget-tab.js'
import { LogTab } from './project-detail/log-tab.js'
import { FilesTab } from './project-detail/files-tab.js'

export type TabKey = 'overview' | 'estimate' | 'crew' | 'materials' | 'budget' | 'log' | 'files'

export const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'estimate', label: 'Estimate' },
  { key: 'crew', label: 'Crew' },
  { key: 'materials', label: 'Materials' },
  { key: 'budget', label: 'Budget' },
  { key: 'log', label: 'Log' },
  { key: 'files', label: 'Files' },
]

export function MobileProjectDetail({
  bootstrap,
  companyRole,
}: {
  bootstrap: BootstrapResponse | null
  companyRole: CompanyRole
}) {
  const params = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [tab, setTab] = useState<TabKey>('overview')

  const project = bootstrap?.projects.find((p) => p.id === params.projectId)
  const labor = useMemo(
    () => (bootstrap?.laborEntries ?? []).filter((l) => l.project_id === params.projectId && !l.deleted_at),
    [bootstrap?.laborEntries, params.projectId],
  )
  const schedules = useMemo(
    () => (bootstrap?.schedules ?? []).filter((s) => s.project_id === params.projectId),
    [bootstrap?.schedules, params.projectId],
  )
  const materialBills = useMemo(
    () => (bootstrap?.materialBills ?? []).filter((m) => m.project_id === params.projectId),
    [bootstrap?.materialBills, params.projectId],
  )

  if (!project) {
    return (
      <>
        <MTopBar back title="Project" onBack={() => navigate('/projects')} />
        <MEmptyState
          title="Project not found"
          body="It may have been archived or you may not have access. Try the projects list."
          primaryLabel="Back to projects"
          onPrimary={() => navigate('/projects')}
        />
      </>
    )
  }

  const totalHours = labor.reduce((sum, l) => sum + Number(l.hours ?? 0), 0)
  const laborRate = Number(project.labor_rate ?? 0)
  const spent = totalHours * laborRate
  const bid = Number(project.bid_total ?? 0)
  const pctSpent = bid > 0 ? Math.round((spent / bid) * 100) : 0
  const onTrack = pctSpent <= 75

  useEffect(() => {
    return registerCaptureStateProvider(`project-detail:${project.id}`, ({ reason }) =>
      buildProjectDetailStateSnapshot({
        project,
        activeTab: tab,
        companyRole,
        routePath: currentCaptureRoutePath(),
        reason,
        totalHours,
        bid,
        spent,
        pctSpent,
        onTrack,
        scheduleCount: schedules.length,
        laborEntryCount: labor.length,
        materialBillCount: materialBills.length,
      }),
    )
  }, [
    bid,
    companyRole,
    labor.length,
    materialBills.length,
    onTrack,
    pctSpent,
    project,
    schedules.length,
    spent,
    tab,
    totalHours,
  ])

  return (
    <>
      <MTopBar
        back
        title="Project"
        sub={schedules.length > 0 ? `Day ${schedules.length} of ${Math.max(schedules.length, 14)}` : undefined}
        onBack={() => navigate('/projects')}
      />
      <MBody>
        <ProjectHero
          project={project}
          pctSpent={pctSpent}
          onTrack={onTrack}
          spent={spent}
          bid={bid}
          scheduleCount={schedules.length}
          scheduleTotal={Math.max(schedules.length, 32)}
        />
        <WorkRequestEntityStatus entityType="project" entityId={project.id} />
        <WorkRequestAction
          companyRole={companyRole}
          defaultTitle="Project issue"
          category="project"
          route={`/projects/${project.id}`}
          client={{
            source: 'project_detail_mobile',
            page: {
              path: `/projects/${project.id}`,
              route: `/projects/${project.id}`,
              tab,
            },
            entity: {
              entity_type: 'project',
              entity_id: project.id,
            },
            project: {
              id: project.id,
              name: project.name,
              status: project.status,
              customer_name: project.customer_name,
              division_code: project.division_code,
            },
            state: {
              total_hours: totalHours,
              bid_total: bid,
              spent,
              percent_spent: pctSpent,
              schedule_count: schedules.length,
              material_bill_count: materialBills.length,
            },
          }}
        />
        <TabBar active={tab} onChange={setTab} />
        <div style={{ paddingTop: 4 }}>
          {tab === 'overview' && (
            <Overview
              project={project}
              totalHours={totalHours}
              bid={bid}
              spent={spent}
              pctSpent={pctSpent}
              navigate={navigate}
            />
          )}
          {tab === 'estimate' && <EstimateTab project={project} navigate={navigate} />}
          {tab === 'crew' && <CrewTab labor={labor} workers={bootstrap?.workers ?? []} />}
          {tab === 'materials' && <MaterialsTab bills={materialBills} project={project} />}
          {tab === 'budget' && (
            <BudgetTab project={project} totalHours={totalHours} spent={spent} bid={bid} pctSpent={pctSpent} />
          )}
          {tab === 'log' && <LogTab project={project} navigate={navigate} />}
          {tab === 'files' && <FilesTab project={project} navigate={navigate} />}
        </div>
      </MBody>
    </>
  )
}
