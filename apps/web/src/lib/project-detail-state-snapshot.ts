import type { CompanyRole } from '@sitelayer/domain'
import type { ProjectRow } from './api'
import type { CaptureStateProviderSnapshot, CaptureStateSnapshotReason } from './capture-state-providers'

export type ProjectDetailTabKey = 'overview' | 'estimate' | 'crew' | 'materials' | 'budget' | 'log' | 'files'

export type BuildProjectDetailStateSnapshotInput = {
  project: ProjectRow
  activeTab: ProjectDetailTabKey
  companyRole: CompanyRole
  routePath: string
  reason: CaptureStateSnapshotReason
  totalHours: number
  bid: number
  spent: number
  pctSpent: number
  onTrack: boolean
  scheduleCount: number
  laborEntryCount: number
  materialBillCount: number
}

export function buildProjectDetailStateSnapshot(
  input: BuildProjectDetailStateSnapshotInput,
): CaptureStateProviderSnapshot {
  const { project } = input
  return {
    schema: 'sitelayer.project-detail.state.v1',
    piiLevel: 'internal',
    metadata: {
      route_state: true,
      surface: 'mobile_project_detail',
      project_id: project.id,
      active_tab: input.activeTab,
      reason: input.reason,
    },
    payload: {
      route_path: normalizeRoutePath(input.routePath),
      active_tab: input.activeTab,
      actor: {
        company_role: input.companyRole,
      },
      project: {
        id: project.id,
        name: project.name,
        status: project.status,
        lifecycle_state: project.lifecycle_state ?? null,
        lifecycle_state_version: project.lifecycle_state_version ?? null,
        customer_name: project.customer_name,
        division_code: project.division_code,
        bid_total: input.bid,
        labor_rate: Number(project.labor_rate ?? 0),
        version: project.version,
        updated_at: project.updated_at,
      },
      budget: {
        total_hours: round(input.totalHours, 2),
        spent: round(input.spent, 2),
        bid_total: round(input.bid, 2),
        percent_spent: input.pctSpent,
        on_track: input.onTrack,
      },
      related_counts: {
        schedules: input.scheduleCount,
        labor_entries: input.laborEntryCount,
        material_bills: input.materialBillCount,
      },
    },
  }
}

function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function normalizeRoutePath(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value, 'https://sitelayer.local').pathname
  } catch {
    return value.split('?')[0] || null
  }
}
