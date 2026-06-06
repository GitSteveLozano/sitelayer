import type { ProjectSummary } from './api'
import type { CaptureStateProviderSnapshot, CaptureStateSnapshotReason } from './capture-state-providers'
import type { EstimateLine, ScopeVsBidResponse } from './api/estimate'

type EstimateReviewLineSummaryInput = Pick<EstimateLine, 'service_item_code' | 'amount'> &
  Partial<Pick<EstimateLine, 'kind' | 'division_code'>>

export type EstimateReviewBuilderState = {
  snapshot: ScopeVsBidResponse | null
  lines: readonly EstimateLine[]
  pendingEdits: Record<string, unknown>
  hasDirtyEdits: boolean
  isLoading: boolean
  isSaving: boolean
  conflict: boolean
  error: string | null
}

export type EstimateReviewUiState = {
  creatingPush: boolean
  createError: string | null
  shareCreated: boolean
  marginOverride: number | null
  marginSaving: boolean
  showSendSheet: boolean
  sendNoteLength: number
  sendEmailPresent: boolean
}

export type BuildEstimateReviewStateSnapshotInput = {
  projectId: string
  routePath: string
  reason: CaptureStateSnapshotReason
  summary: ProjectSummary
  builder: EstimateReviewBuilderState
  ui: EstimateReviewUiState
  totals: {
    liveTotal: number
    costBasis: number
    sellTotal: number
    profit: number
    margin: number
    roundingDelta: number
  }
}

export function buildEstimateReviewStateSnapshot(
  input: BuildEstimateReviewStateSnapshotInput,
): CaptureStateProviderSnapshot {
  const summaryLines = summarizeLines(input.summary.estimateLines)
  const builderLines = summarizeLines(input.builder.lines)
  return {
    schema: 'sitelayer.estimate-review.state.v1',
    piiLevel: 'internal',
    metadata: {
      route_state: true,
      surface: 'mobile_estimate_review',
      project_id: input.projectId,
      summary_line_count: summaryLines.line_count,
      builder_line_count: builderLines.line_count,
      pending_edit_count: Object.keys(input.builder.pendingEdits).length,
    },
    payload: {
      route_path: normalizeRoutePath(input.routePath),
      reason: input.reason,
      project: {
        id: input.summary.project.id,
        name: input.summary.project.name,
        status: input.summary.project.status,
        customer_id_present: Boolean(input.summary.project.customer_id),
        customer_name: input.summary.project.customer_name ?? null,
      },
      totals: {
        live_total: round(input.totals.liveTotal, 2),
        cost_basis: round(input.totals.costBasis, 2),
        sell_total: round(input.totals.sellTotal, 2),
        profit: round(input.totals.profit, 2),
        margin: round(input.totals.margin, 4),
        rounding_delta: round(input.totals.roundingDelta, 2),
        summary_estimate_total: round(input.summary.metrics.estimateTotal, 2),
        summary_total_cost: round(input.summary.metrics.totalCost, 2),
      },
      builder: {
        status: input.builder.isLoading
          ? 'loading'
          : input.builder.isSaving
            ? 'saving'
            : input.builder.conflict
              ? 'conflict'
              : input.builder.error
                ? 'error'
                : input.builder.hasDirtyEdits
                  ? 'dirty'
                  : 'idle',
        has_dirty_edits: input.builder.hasDirtyEdits,
        is_loading: input.builder.isLoading,
        is_saving: input.builder.isSaving,
        conflict: input.builder.conflict,
        error: input.builder.error,
        pending_edit_count: Object.keys(input.builder.pendingEdits).length,
        snapshot_status: input.builder.snapshot?.status ?? null,
        snapshot_stale: input.builder.snapshot?.is_stale ?? null,
      },
      send_sheet: {
        open: input.ui.showSendSheet,
        creating: input.ui.creatingPush,
        error: input.ui.createError,
        share_created: input.ui.shareCreated,
        send_note_length: input.ui.sendNoteLength,
        send_email_present: input.ui.sendEmailPresent,
        margin_override: input.ui.marginOverride,
        margin_saving: input.ui.marginSaving,
      },
      lines: {
        summary: summaryLines,
        builder: builderLines,
      },
    },
  }
}

function summarizeLines(lines: readonly EstimateReviewLineSummaryInput[]) {
  const byKind: Record<string, number> = {}
  const byDivision: Record<string, number> = {}
  let amount = 0
  for (const line of lines) {
    byKind[line.kind || 'flat'] = (byKind[line.kind || 'flat'] ?? 0) + 1
    byDivision[line.division_code || 'uncategorized'] = (byDivision[line.division_code || 'uncategorized'] ?? 0) + 1
    amount += normalizeNumber(line.amount)
  }
  return {
    line_count: lines.length,
    amount: round(amount, 2),
    by_kind: byKind,
    by_division: byDivision,
  }
}

function normalizeNumber(value: string | number | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
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
