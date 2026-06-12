import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import {
  MBanner,
  MBody,
  MButton,
  MButtonRow,
  MI,
  MListInset,
  MListRow,
  MSectionH,
  MTopBar,
} from '../../components/m/index.js'
import { MSkeletonList } from '../../components/m-states/index.js'
import { WorkRequestSeverityPill, WorkRequestStatusPill } from '../../components/work-requests/status.js'
import { AgentSupervisionPanel } from '../../components/work-requests/AgentSupervisionPanel.js'
import {
  fetchSupportPacket,
  queryKeys,
  useAppIssueCapabilities,
  useAppIssueCostLedger,
  useAppIssueDetail,
  useEscalateAppIssue,
  type AppIssueDiagnosticManifest,
  type AppIssueCostLedgerEntry,
  type AppIssueEscalateTier,
} from '@/lib/api'

/**
 * APP-ISSUE detail (STEP6-UI). Read-only issue view plus two triage affordances
 * for callers who hold the PLATFORM capability `app_issue.triage`:
 *   - a "go deeper" escalation control (POST /api/issues/:id/escalate {tier})
 *     that re-runs tier-2/3 enrichment around the bundle's ALREADY-PINNED
 *     anchors, and
 *   - a per-issue cost ledger projected from support_packet_access_log.
 *
 * Gated server-side by `app_issue.view` (board) + `app_issue.triage` (escalate);
 * the SPA mirrors the gate so a non-triager never sees the "go deeper" button,
 * but the API enforces it regardless.
 */
export function MobileAppIssueDetailGate() {
  const caps = useAppIssueCapabilities()
  const params = useParams<{ issueId: string }>()
  const issueId = params.issueId ?? ''
  if (caps.isPending) {
    return (
      <>
        <MTopBar title="App issue" />
        <MBody>
          <MSkeletonList count={4} />
        </MBody>
      </>
    )
  }
  if (!caps.data?.includes('app_issue.view')) {
    return <Navigate to="/more" replace />
  }
  return <MobileAppIssueDetail issueId={issueId} canTriage={caps.data.includes('app_issue.triage')} />
}

function MobileAppIssueDetail({ issueId, canTriage }: { issueId: string; canTriage: boolean }) {
  const navigate = useNavigate()
  const detail = useAppIssueDetail(issueId)
  const issue = detail.data?.issue
  const diagnosticManifest = detail.data?.diagnostic_manifest
  const supportPacketId = detail.data?.support_packet?.id ?? issue?.support_packet_id ?? null
  const ledger = useAppIssueCostLedger(supportPacketId)
  const escalate = useEscalateAppIssue(issueId)
  const [tier, setTier] = useState<AppIssueEscalateTier>(2)
  // Full packet (app_issue.view gates the GET) powers the supervision REPLAY view
  // — the deterministic server_context.anchors + in-window timeline. Read-only on
  // this surface: app-issues escalate / triage rather than approve/reject.
  const fullPacket = useQuery({
    queryKey: queryKeys.supportPackets.detail(supportPacketId ?? ''),
    queryFn: () => fetchSupportPacket(supportPacketId as string),
    enabled: Boolean(supportPacketId),
  })

  return (
    <>
      <MTopBar back title="App issue" onBack={() => navigate('/issues')} />
      <MBody>
        {detail.error ? (
          <div style={{ padding: '0 16px 8px' }}>
            <MBanner
              tone="error"
              title="Load failed"
              body={detail.error instanceof Error ? detail.error.message : 'Request failed.'}
            />
          </div>
        ) : null}

        {detail.isPending ? (
          <MSkeletonList count={4} />
        ) : !issue ? (
          <div style={{ padding: '24px 16px', fontSize: 13, color: 'var(--m-ink-3)' }}>Issue not found.</div>
        ) : (
          <div style={{ display: 'grid', gap: 20, paddingBottom: 32 }}>
            <section style={{ padding: '4px 16px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <WorkRequestSeverityPill severity={issue.severity} />
                <WorkRequestStatusPill status={issue.status} />
              </div>
              <div
                style={{
                  marginTop: 10,
                  fontFamily: 'var(--m-font-display)',
                  fontSize: 20,
                  fontWeight: 700,
                  lineHeight: 1.25,
                  color: 'var(--m-ink)',
                }}
              >
                {issue.title}
              </div>
              {issue.summary ? (
                <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.45, color: 'var(--m-ink-2)' }}>
                  {issue.summary}
                </div>
              ) : null}
              <div
                style={{
                  marginTop: 12,
                  fontFamily: 'var(--m-num)',
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--m-ink-3)',
                }}
              >
                {[issue.route, issue.lane && `LANE ${issue.lane}`, issue.capture_session_id ? 'CAPTURED' : null]
                  .filter(Boolean)
                  .join(' · ')
                  .toUpperCase()}
              </div>
            </section>

            {diagnosticManifest ? <AppIssueDiagnosticPanel manifest={diagnosticManifest} /> : null}

            {/* Agent supervision: read-only replay + agent-output-vs-context. The
                app-issue surface escalates rather than approves, so no review row. */}
            <AgentSupervisionPanel
              workItem={issue}
              events={detail.data?.events ?? []}
              supportPacket={detail.data?.support_packet}
              serverContext={fullPacket.data ? fullPacket.data.support_packet.server_context : null}
              agentPrompt={fullPacket.data?.agent_prompt ?? null}
            />

            {/* "Go deeper" escalation — only for triagers. */}
            {canTriage ? (
              <section style={{ padding: '0 16px' }}>
                <MSectionH>Go deeper</MSectionH>
                <div style={{ marginTop: 6, fontSize: 13, color: 'var(--m-ink-2)' }}>
                  Re-run enrichment around the pinned trace / request / event refs. Each pull is metered on the cost
                  ledger below.
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                    Tier
                    <select
                      value={tier}
                      onChange={(e) => setTier(Number(e.target.value) === 3 ? 3 : 2)}
                      aria-label="Escalation tier"
                      style={{
                        fontSize: 13,
                        padding: '6px 8px',
                        borderRadius: 8,
                        border: '1px solid var(--m-line, rgba(0,0,0,0.12))',
                      }}
                    >
                      <option value={2}>Tier 2</option>
                      <option value={3}>Tier 3</option>
                    </select>
                  </label>
                  <MButtonRow>
                    <MButton
                      variant="primary"
                      size="sm"
                      disabled={escalate.isPending}
                      onClick={() => escalate.mutate({ tier })}
                    >
                      {escalate.isPending ? 'Escalating…' : 'Go deeper'}
                    </MButton>
                  </MButtonRow>
                </div>
                {escalate.error ? (
                  <div style={{ marginTop: 10 }}>
                    <MBanner
                      tone="error"
                      title="Escalation failed"
                      body={escalate.error instanceof Error ? escalate.error.message : 'Request failed.'}
                    />
                  </div>
                ) : null}
                {escalate.data ? (
                  <div style={{ marginTop: 12, display: 'grid', gap: 6 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--m-ink-2)' }}>
                      Tier {escalate.data.tier} · {escalate.data.pulls.length} pull
                      {escalate.data.pulls.length === 1 ? '' : 's'}
                    </div>
                    {escalate.data.pulls.map((pull, index) => (
                      <div
                        key={`${pull.source}:${index}`}
                        style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}
                      >
                        <span style={{ color: 'var(--m-ink-2)' }}>
                          {pull.source} · {pull.status}
                        </span>
                        <span style={{ fontFamily: 'var(--m-num)', color: 'var(--m-ink-3)' }}>
                          {formatCents(pull.cost_cents)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}

            {/* Per-issue cost ledger. */}
            <section style={{ padding: '0 16px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                <MSectionH>Cost ledger</MSectionH>
                {ledger.data ? (
                  <span style={{ fontFamily: 'var(--m-num)', fontSize: 13, fontWeight: 700, color: 'var(--m-ink)' }}>
                    {formatCents(ledger.data.total_cost_cents)}
                  </span>
                ) : null}
              </div>
              {ledger.isPending ? (
                <MSkeletonList count={2} />
              ) : ledger.error ? (
                <div style={{ marginTop: 8, fontSize: 13, color: 'var(--m-ink-3)' }}>Cost ledger unavailable.</div>
              ) : !ledger.data || ledger.data.entries.length === 0 ? (
                <div style={{ marginTop: 8, fontSize: 13, color: 'var(--m-ink-3)' }}>
                  No enrichment pulls yet. Tier 0/1 context shipped at finalize — escalate to spend on deeper pulls.
                </div>
              ) : (
                <div style={{ marginTop: 8, borderTop: '2px solid var(--m-ink)' }}>
                  {ledger.data.entries.map((entry) => (
                    <CostLedgerRow key={entry.id} entry={entry} />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </MBody>
    </>
  )
}

function AppIssueDiagnosticPanel({ manifest }: { manifest: AppIssueDiagnosticManifest }) {
  const failedOrPending = manifest.checks.filter(
    (check) => check.status === 'error' || check.status === 'pending' || check.status === 'warn',
  )
  return (
    <section style={{ padding: '0 16px' }}>
      <MSectionH>Diagnostics</MSectionH>
      <MListInset>
        <MListRow
          leading={<MI.AlertTri size={18} />}
          leadingTone={manifest.needs_attention ? 'amber' : 'green'}
          headline="Next step"
          supporting={formatToken(manifest.operator_next_step)}
        />
        <MListRow
          leading={<MI.Camera size={18} />}
          leadingTone={manifest.capture_readiness.capture_session === 'ready' ? 'blue' : 'accent'}
          headline="Capture"
          supporting={[
            `session ${manifest.capture_readiness.capture_session}`,
            `analysis ${manifest.capture_readiness.artifact_analysis}`,
          ].join(' - ')}
        />
        <MListRow
          leading={<MI.FileText size={18} />}
          leadingTone={manifest.capture_readiness.support_packet === 'ready' ? 'green' : 'red'}
          headline="Evidence"
          supporting={`${manifest.evidence_refs.length} ref${manifest.evidence_refs.length === 1 ? '' : 's'} - ${manifest.checks.length} checks`}
        />
      </MListInset>
      {failedOrPending.length > 0 ? (
        <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
          {failedOrPending.slice(0, 3).map((check) => (
            <div key={check.key} style={{ fontSize: 12, color: 'var(--m-ink-2)' }}>
              <strong>{check.label}</strong>: {check.detail ?? check.status}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function CostLedgerRow({ entry }: { entry: AppIssueCostLedgerEntry }) {
  const label = entry.source ?? entry.access_type
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '10px 0',
        borderBottom: '1px solid var(--m-line, rgba(0,0,0,0.08))',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--m-ink)' }}>
          {label}
          {entry.tier != null ? ` · tier ${entry.tier}` : ''}
        </div>
        <div style={{ fontFamily: 'var(--m-num)', fontSize: 11, color: 'var(--m-ink-3)' }}>
          {relativeAge(entry.created_at)}
        </div>
      </div>
      <span style={{ fontFamily: 'var(--m-num)', fontSize: 13, fontWeight: 700, color: 'var(--m-ink-2)' }}>
        {formatCents(entry.cost_cents)}
      </span>
    </div>
  )
}

function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—'
  return `$${(cents / 100).toFixed(2)}`
}

function relativeAge(iso: string): string {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatToken(value: string): string {
  return value
    .split('_')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ')
}
