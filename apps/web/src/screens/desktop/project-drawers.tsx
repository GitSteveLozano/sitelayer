/**
 * Owner desktop LIFECYCLE DRAWERS + MODALS (Desktop v2 · 12 / 04 / 03).
 *
 * Faithful ports of Steve's Desktop v2 mockup overlays, composed on the
 * already-built foundation primitives `DDrawer` / `DModal` (which own the
 * scrim / Escape / close-button) and `MButton` (the mockup's `.dt-btn`).
 * Each export is a thin wrapper that receives `{ open, onClose }` and renders
 * only the BODY content.
 *
 * The mockup's `--d-*` token system maps onto this repo's `--m-*` tokens:
 *   --d-ink/-2/-3/-4 → --m-ink/-2/-3/-4 ·  --d-sand → --m-card ·
 *   --d-sand-soft → --m-card-soft ·  --d-line-soft → --m-line-2 ·
 *   --d-accent(-ink) → --m-accent(-ink) ·  --d-good → --m-green ·
 *   --d-bad → --m-red ·  --d-f-tight → --m-font-display ·  --d-f-mono → --m-num.
 *
 * The numbers/labels are the mockup's demo data — these are presentational
 * surfaces; real data wiring is a later pass. Parent owns the open-state and
 * mounts each wrapper alongside its trigger.
 */
import type { CSSProperties, ReactNode } from 'react'
import { DDrawer, DModal } from '@/components/d'
import { MButton } from '@/components/m'

interface OverlayProps {
  open: boolean
  onClose: () => void
}

// ---- shared inline-style helpers -----------------------------------------
const mono = (extra?: CSSProperties): CSSProperties => ({ fontFamily: 'var(--m-num)', ...extra })
const display = (extra?: CSSProperties): CSSProperties => ({ fontFamily: 'var(--m-font-display)', ...extra })
const sectionLabel: CSSProperties = {
  fontFamily: 'var(--m-num)',
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--m-ink-3)',
  letterSpacing: '0.06em',
}

/** Section bar used as the head of the invoice / send / new-* modals (the
 * mockup's `.dt-float-head`). Passed as `DModal`'s `title`. */
function FloatHead({ children }: { children: ReactNode }) {
  return (
    <span
      className="num"
      style={mono({ fontWeight: 800, fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase' })}
    >
      {children}
    </span>
  )
}

// ============================================================
// Lifecycle drawers (12_app.js · DRecoveryDrawer / DChangeOrderDrawer /
// DPostMortemDrawer)
// ============================================================

interface RecoveryAction {
  n: number
  label: string
  sub: string
  margin: string
}

const RECOVERY_ACTIONS: RecoveryAction[] = [
  { n: 1, label: 'Cap OT this week', sub: 'Save $1,840', margin: '+7%' },
  { n: 2, label: 'Reassign Carlos to Hillcrest', sub: 'Overstaffed', margin: '+3%' },
  { n: 3, label: 'Renegotiate stone w/ Calvera', sub: 'CO-003 opportunity', margin: '+8%' },
]

/** F1a · AI-ranked recovery actions, opened off an at-risk margin guardrail. */
export function RecoveryDrawer({ open, onClose }: OverlayProps) {
  return (
    <DDrawer open={open} onClose={onClose} tone="bad" title="● RECOVERY PLAN · LABOR -18%">
      <div style={display({ fontWeight: 800, fontSize: 24, lineHeight: 1, letterSpacing: '-0.02em' })}>
        AI ranked 3 actions.
      </div>
      <div style={mono({ fontSize: 11, color: 'var(--m-ink-3)', marginTop: 8, fontWeight: 600 })}>
        23 DAYS LEFT · MARGIN RECOVERABLE
      </div>
      <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {RECOVERY_ACTIONS.map((a) => (
          <div
            key={a.n}
            style={{
              padding: 14,
              border: '2px solid var(--m-ink)',
              display: 'flex',
              gap: 12,
              alignItems: 'flex-start',
            }}
          >
            <div
              style={display({
                width: 32,
                height: 32,
                background: 'var(--m-accent)',
                color: 'var(--m-accent-ink)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: 14,
                flexShrink: 0,
              })}
            >
              {a.n}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{a.label}</div>
              <div style={mono({ fontSize: 10, color: 'var(--m-ink-3)', marginTop: 3, fontWeight: 600 })}>{a.sub}</div>
              <div style={mono({ fontSize: 11, color: 'var(--m-green)', marginTop: 5, fontWeight: 800 })}>
                MARGIN {a.margin}
              </div>
            </div>
          </div>
        ))}
      </div>
      <MButton variant="primary" style={{ width: '100%', marginTop: 20 }}>
        ACCEPT PLAN · TRACK
      </MButton>
    </DDrawer>
  )
}

const CHANGE_ORDER_STATES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED'] as const

/** F1b · Change-order value delta + DRAFT/SENT/ACCEPTED/REJECTED state strip. */
export function ChangeOrderDrawer({ open, onClose }: OverlayProps) {
  return (
    <DDrawer open={open} onClose={onClose} title="+ CHANGE ORDER · CO-003">
      <div style={sectionLabel}>WHAT CHANGED</div>
      <div
        style={{
          marginTop: 8,
          padding: 14,
          border: '2px solid var(--m-ink)',
          background: 'var(--m-card-soft)',
          minHeight: 70,
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        Added stone veneer on south wall — 320 SF · client request.
      </div>

      <div style={{ ...sectionLabel, marginTop: 18 }}>VALUE DELTA</div>
      <div style={display({ fontWeight: 800, fontSize: 44, marginTop: 6, color: 'var(--m-green)' })}>+$5,280</div>
      <div style={mono({ fontSize: 10, color: 'var(--m-ink-3)', marginTop: 4, fontWeight: 600 })}>
        320 SF × $16.50 · INCL 34% MARGIN
      </div>

      {/* state machine strip — first state (DRAFT) is current */}
      <div style={{ display: 'flex', border: '2px solid var(--m-ink)', marginTop: 20 }}>
        {CHANGE_ORDER_STATES.map((s, i, arr) => {
          const current = i === 0
          return (
            <div
              key={s}
              style={mono({
                flex: 1,
                padding: '8px 0',
                textAlign: 'center',
                background: current ? 'var(--m-accent)' : 'transparent',
                color: current ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                borderRight: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                fontSize: 8,
                fontWeight: 800,
              })}
            >
              {s}
            </div>
          )
        })}
      </div>
      <MButton variant="primary" style={{ width: '100%', marginTop: 20 }}>
        SEND TO JOHN
      </MButton>
    </DDrawer>
  )
}

interface PostMortemLine {
  label: string
  pct: string
  bad?: boolean
}

const POST_MORTEM_LINES: PostMortemLine[] = [
  { label: 'Labor', pct: '+15%', bad: true },
  { label: 'EPS board', pct: '+4%', bad: true },
  { label: 'Basecoat', pct: '-6%' },
  { label: 'Stone', pct: '+3%' },
  { label: 'Rentals', pct: '-20%' },
]

/** F1c · Final-margin + per-division variance lines + AI "next time" callout. */
export function PostMortemDrawer({ open, onClose }: OverlayProps) {
  return (
    <DDrawer open={open} onClose={onClose} title="● POST-MORTEM · CLOSED">
      <div style={sectionLabel}>FINAL MARGIN</div>
      <div style={display({ fontWeight: 800, fontSize: 52, marginTop: 6, color: 'var(--m-green)', lineHeight: 1 })}>
        34%
      </div>
      <div style={mono({ fontSize: 11, color: 'var(--m-ink-2)', marginTop: 8, fontWeight: 600 })}>
        BID 34% · DELIVERED 34% · DEAD ON
      </div>
      <div style={{ marginTop: 20 }}>
        {POST_MORTEM_LINES.map((l) => (
          <div
            key={l.label}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '10px 0',
              borderBottom: '1px solid var(--m-line-2)',
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700 }}>{l.label}</span>
            <span className="num" style={{ fontSize: 14, color: l.bad ? 'var(--m-red)' : 'var(--m-green)' }}>
              {l.pct}
            </span>
          </div>
        ))}
      </div>
      <div style={{ padding: 14, background: 'var(--m-accent)', marginTop: 18 }}>
        <div style={mono({ fontSize: 10, fontWeight: 700, color: 'var(--m-accent-ink)' })}>● AI · NEXT TIME</div>
        <div
          style={mono({ fontSize: 11, color: 'var(--m-accent-ink)', marginTop: 8, fontWeight: 600, lineHeight: 1.5 })}
        >
          EPS LABOR RAN 15% OVER. ADD +12% BUFFER ON SIMILAR HILLCREST JOBS.
        </div>
      </div>
    </DDrawer>
  )
}

// ============================================================
// Invoice modal (12_app.js · DInvoiceModal)
// ============================================================

interface Milestone {
  label: string
  value: string
  paid?: boolean
  billing?: boolean
}

const INVOICE_MILESTONES: Milestone[] = [
  { label: 'Deposit · 30%', value: '$43,827', paid: true },
  { label: 'Progress · 50% @ EPS done', value: '$73,045', billing: true },
  { label: 'Final · 20% at close', value: '$29,218' },
]

/** G5 · Milestone billing list + NET 30 + send button. */
export function InvoiceModal({ open, onClose }: OverlayProps) {
  return (
    <DModal
      open={open}
      onClose={onClose}
      title={<FloatHead>INVOICE #113 · HILLCREST PH 4</FloatHead>}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <MButton variant="ghost" onClick={onClose}>
            PREVIEW
          </MButton>
          <MButton variant="primary">SEND · $73,045</MButton>
        </div>
      }
    >
      <div style={sectionLabel}>MILESTONE</div>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {INVOICE_MILESTONES.map((m) => {
          const onMilestone = Boolean(m.billing)
          return (
            <div
              key={m.label}
              style={{
                padding: '12px 14px',
                border: '2px solid var(--m-ink)',
                background: onMilestone ? 'var(--m-accent)' : 'transparent',
                color: onMilestone ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{m.label}</div>
                <div style={mono({ fontSize: 9, marginTop: 3, fontWeight: 700, opacity: 0.7 })}>
                  {m.paid ? '✓ PAID' : m.billing ? '● BILLING NOW' : '○ NOT YET'}
                </div>
              </div>
              <span className="num" style={{ fontSize: 15, fontWeight: 700 }}>
                {m.value}
              </span>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
        <div style={{ width: 18, height: 18, background: 'var(--m-accent)', border: '2px solid var(--m-ink)' }} />
        <span style={mono({ fontSize: 11, fontWeight: 600 })}>NET 30 · STRIPE LINK INCLUDED</span>
      </div>
    </DModal>
  )
}

// ============================================================
// Send + PDF-preview modals (04_app.js · DSendModal / DPdfPreviewModal)
// ============================================================

/** C1b · Send the bid to the client, with recipient + message + tracked link. */
export function SendModal({ open, onClose }: OverlayProps) {
  return (
    <DModal
      open={open}
      onClose={onClose}
      width={520}
      title={<FloatHead>SEND BID · $146,090</FloatHead>}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <MButton variant="ghost" onClick={onClose}>
            CANCEL
          </MButton>
          <MButton variant="primary">SEND · NOTIFY JOHN</MButton>
        </div>
      }
    >
      <div style={sectionLabel}>TO</div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginTop: 8,
          padding: '12px 14px',
          border: '2px solid var(--m-ink)',
          background: 'var(--m-card-soft)',
        }}
      >
        <div
          style={display({
            width: 38,
            height: 38,
            background: 'var(--m-ink)',
            color: 'var(--m-card)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 800,
            fontSize: 13,
          })}
        >
          JM
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>John Marchetti</div>
          <div style={mono({ fontSize: 10, color: 'var(--m-ink-3)', marginTop: 2, fontWeight: 600 })}>
            john@hillcresthomes.co
          </div>
        </div>
      </div>

      <div style={{ ...sectionLabel, marginTop: 18 }}>MESSAGE</div>
      <div
        style={{
          marginTop: 8,
          padding: 14,
          border: '2px solid var(--m-ink)',
          background: 'var(--m-card-soft)',
          minHeight: 80,
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        John — bid attached for Phase 4. $146K, 7 line items. Happy to walk through.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
        <div style={{ width: 18, height: 18, background: 'var(--m-accent)', border: '2px solid var(--m-ink)' }} />
        <span style={mono({ fontSize: 11, fontWeight: 600 })}>INCLUDE SIGNED LINK · TRACK OPEN</span>
      </div>
    </DModal>
  )
}

const PDF_CONTENT_MODES: Array<{ label: string; on?: boolean }> = [
  { label: 'PLAN ONLY' },
  { label: 'WITH TAKEOFF', on: true },
  { label: 'CURRENT VIEW' },
]

/** C1a · PDF preview modal — content-mode rail + sheet list + page preview. */
export function PdfPreviewModal({ open, onClose }: OverlayProps) {
  return (
    <DModal
      open={open}
      onClose={onClose}
      width={880}
      title={<FloatHead>PDF PREVIEW · HILLCREST PH 4 · QUANTITIES</FloatHead>}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <MButton variant="ghost">DOWNLOAD</MButton>
          <MButton variant="primary">SEND TO CLIENT</MButton>
        </div>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', minHeight: 460 }}>
        <div style={{ borderRight: '2px solid var(--m-ink)', background: 'var(--m-card-soft)', padding: 20 }}>
          <div style={{ ...sectionLabel, color: 'var(--m-ink-3)' }}>CONTENT</div>
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {PDF_CONTENT_MODES.map((t) => (
              <MButton
                key={t.label}
                variant={t.on ? 'primary' : 'ghost'}
                style={{ width: '100%', height: 40, fontSize: 12, justifyContent: 'flex-start' }}
              >
                {t.label}
              </MButton>
            ))}
          </div>
          <div style={{ ...sectionLabel, color: 'var(--m-ink-3)', marginTop: 24 }}>SHEETS · 22</div>
          <div style={mono({ fontSize: 10, color: 'var(--m-ink-3)', marginTop: 8, fontWeight: 600, lineHeight: 1.6 })}>
            ALL INCLUDED
            <br />
            A-101 · A-201..204
            <br />
            M-101..104 · …
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              flex: 1,
              background: 'var(--m-ink-2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 40,
            }}
          >
            <div style={{ width: 240, height: 320, background: '#fff', border: '2px solid var(--m-ink)', padding: 16 }}>
              <div style={mono({ fontSize: 8, fontWeight: 700, color: 'var(--m-ink)' })}>HILLCREST PH 4 · TAKEOFF</div>
              <div style={display({ fontWeight: 800, fontSize: 14, marginTop: 4, color: 'var(--m-ink)' })}>
                QUANTITIES
              </div>
              <div style={{ marginTop: 14 }}>
                {['EPS · 4,785 SF', 'BASECOAT · 4,785 SF', 'STONE · 420 SF'].map((r) => (
                  <div
                    key={r}
                    style={mono({
                      fontSize: 8,
                      padding: '4px 0',
                      borderBottom: '1px dashed var(--m-line-2)',
                      color: 'var(--m-ink)',
                    })}
                  >
                    {r}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </DModal>
  )
}

// ============================================================
// New project + new assignment modals (03_app.js · DNewProjectModal /
// DNewAssignmentModal)
// ============================================================

const PROJECT_STARTING_STATES: Array<{ label: string; on?: boolean }> = [
  { label: 'BID', on: true },
  { label: 'PROJECT' },
  { label: 'LEAD' },
]

/** C1 · New-project kickoff modal — name, client, starting state, takeoff attach. */
export function NewProjectModal({ open, onClose }: OverlayProps) {
  return (
    <DModal
      open={open}
      onClose={onClose}
      title={<FloatHead>NEW PROJECT</FloatHead>}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <MButton variant="ghost" onClick={onClose}>
            CANCEL
          </MButton>
          <MButton variant="primary">CREATE PROJECT</MButton>
        </div>
      }
    >
      <div style={sectionLabel}>PROJECT NAME</div>
      <div
        style={display({
          marginTop: 8,
          padding: '12px 14px',
          border: '2px solid var(--m-ink)',
          background: 'var(--m-card-soft)',
          fontWeight: 700,
          fontSize: 16,
        })}
      >
        Crestline North Annex
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 16 }}>
        <div>
          <div style={sectionLabel}>CLIENT</div>
          <div
            style={{
              marginTop: 8,
              padding: '12px 14px',
              border: '2px solid var(--m-ink)',
              background: 'var(--m-card-soft)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700 }}>John Marchetti</span>
            <span style={display({ fontWeight: 800 })}>▾</span>
          </div>
          <div style={mono({ fontSize: 9, color: 'var(--m-green)', marginTop: 5, fontWeight: 700 })}>
            ✓ MATCHED IN QBO · NO DUPE
          </div>
        </div>
        <div>
          <div style={sectionLabel}>STARTING STATE</div>
          <div style={{ marginTop: 8, display: 'flex', border: '2px solid var(--m-ink)' }}>
            {PROJECT_STARTING_STATES.map((t, i, arr) => (
              <div
                key={t.label}
                style={mono({
                  flex: 1,
                  padding: '12px 0',
                  textAlign: 'center',
                  background: t.on ? 'var(--m-accent)' : 'transparent',
                  color: t.on ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                  borderRight: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                  fontSize: 9,
                  fontWeight: 700,
                })}
              >
                {t.label}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ ...sectionLabel, marginTop: 16 }}>BID FROM A TAKEOFF · OPTIONAL</div>
      <div
        style={{
          marginTop: 8,
          padding: '12px 14px',
          border: '2px solid var(--m-ink)',
          background: 'var(--m-accent)',
          color: 'var(--m-accent-ink)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Crestline takeoff · 4,210 SF</div>
          <div style={mono({ fontSize: 9, marginTop: 2, fontWeight: 600 })}>SARAH · 2 DAYS AGO · $138K</div>
        </div>
        <span style={mono({ fontSize: 9, fontWeight: 800, border: '1.5px solid var(--m-ink)', padding: '3px 7px' })}>
          ATTACH
        </span>
      </div>
    </DModal>
  )
}

const ASSIGNMENT_CREW: Array<{ label: string; on?: boolean }> = [
  { label: 'Ana C.', on: true },
  { label: 'Marcus L.', on: true },
  { label: 'Tomás R.', on: true },
  { label: '+ ADD' },
]

/** C3 · New-assignment modal — project, dates, multi-select crew, scope, weather flag. */
export function NewAssignmentModal({ open, onClose }: OverlayProps) {
  return (
    <DModal
      open={open}
      onClose={onClose}
      title={<FloatHead>NEW ASSIGNMENT · DRAGGED MAY 7–9</FloatHead>}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <MButton variant="ghost" onClick={onClose}>
            CANCEL
          </MButton>
          <MButton variant="primary">SAVE · NOTIFY CREW</MButton>
        </div>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div>
          <div style={sectionLabel}>PROJECT</div>
          <div
            style={{
              marginTop: 8,
              padding: '12px 14px',
              border: '2px solid var(--m-ink)',
              background: 'var(--m-card-soft)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700 }}>Hillcrest Ph 4</span>
            <span style={display({ fontWeight: 800 })}>▾</span>
          </div>
        </div>
        <div>
          <div style={sectionLabel}>DATES</div>
          <div
            style={display({
              marginTop: 8,
              padding: '12px 14px',
              border: '2px solid var(--m-ink)',
              background: 'var(--m-card-soft)',
              fontWeight: 800,
              fontSize: 15,
            })}
          >
            MAY 7–9
          </div>
        </div>
      </div>

      <div style={{ ...sectionLabel, marginTop: 16 }}>CREW · MULTI-SELECT</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        {ASSIGNMENT_CREW.map((p) => (
          <span
            key={p.label}
            style={mono({
              padding: '10px 14px',
              background: p.on ? 'var(--m-ink)' : 'transparent',
              color: p.on ? 'var(--m-card)' : 'var(--m-ink-3)',
              border: '2px solid var(--m-ink)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.04em',
            })}
          >
            {p.label}
          </span>
        ))}
      </div>

      <div style={{ ...sectionLabel, marginTop: 16 }}>SCOPE</div>
      <div
        style={{
          marginTop: 8,
          padding: '12px 14px',
          border: '2px solid var(--m-ink)',
          background: 'var(--m-card-soft)',
          fontSize: 14,
        }}
      >
        EPS East — anchor + plate
      </div>

      <div
        style={mono({
          padding: '12px 14px',
          background: 'var(--m-red)',
          color: '#fff',
          marginTop: 16,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.04em',
        })}
      >
        ● WED MAY 7 RAIN FORECAST — CONSIDER SHIFTING
      </div>
    </DModal>
  )
}
