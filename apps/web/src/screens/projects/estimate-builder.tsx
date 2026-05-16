import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Card, MobileButton, Pill, Sheet } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { EmptyState } from '@/components/shell/EmptyState'
import { SkeletonRows } from '@/components/shell/LoadingSkeleton'
import { getActiveCompanySlug } from '@/lib/api/client'
import { useProject, useServiceItems, type EstimateLine, type PricingProfile, type ServiceItem } from '@/lib/api'
import { useEstimateBuilder } from '@/machines/estimate-builder'
import { BidAccuracyCard } from './bid-accuracy-card'
import { EstimateLineAssembly } from './estimate-line-assembly'
import { EstimateMarkupBreakdown } from './estimate-markup-breakdown'
import { PricingProfilePicker } from './pricing-profile-picker'

/**
 * Density threshold for the bid-accuracy keystone. Below this line count we
 * collapse the right rail to a single chip in the header (per the design's
 * `estimate-builder` density-aware spec). At/above this we keep the full
 * three-pane layout with the keystone in the right rail.
 */
const COMPACT_KEYSTONE_LINE_THRESHOLD = 10

/**
 * `estimate-builder` — Three-pane editor that took the read-only
 * `estimate-summary` patterns and promoted them to a full editor.
 *
 *   ┌─ Header ────────────────────────────────────────────────┐
 *   │  Project name · lifecycle pill · "Recompute"            │
 *   ├─ left pane ─┬─ center pane ─────────┬─ right pane ──────┤
 *   │ Scope tree  │ Line items table      │ Bid-accuracy      │
 *   │ (groups)    │ (qty / rate / total)  │ keystone (AI)     │
 *   │             │                       │                   │
 *   └─────────────┴───────────────────────┴───────────────────┘
 *   ┌─ Footer ────────────────────────────────────────────────┐
 *   │  "Send to client" → opens estimate-share-sheet (TODO)   │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Patterns inherited from `estimate-summary.tsx`:
 *   - `useScopeVsBid` is the source of truth for `EstimateLine[]`. We wrap
 *     it through the `useEstimateBuilder` xstate machine so save / conflict
 *     / recompute UI states are managed instead of strewn across hooks.
 *   - PhoneScreen-style spacing (`space-y-3`) and `Card` containers.
 *   - Scope-vs-bid pill row promoted into the lifecycle header.
 *
 * Save: edits stage on the machine via `EDIT_LINE`; an 800ms debounced
 * `SAVE` flushes through the recompute path until `PATCH /api/estimate-lines/:id`
 * lands. 409 → reload + conflict toast (handled by the machine).
 */
export function EstimateBuilderScreen() {
  const params = useParams<{ id: string }>()
  const projectId = params.id ?? ''

  const project = useProject(projectId || null)
  const builder = useEstimateBuilder(projectId, getActiveCompanySlug())
  const items = useServiceItems()

  // Scope-tree filter: clicking a group name in the left pane filters the
  // center table. `null` = show all groups.
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)

  // Auto-save debounce (800ms) — kicks any time pendingEdits is non-empty.
  // The screen owns the timer so the machine's SAVE event stays edge-triggered.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!builder.hasDirtyEdits) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      builder.save()
    }, 800)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [builder])

  if (!projectId) {
    return (
      <div className="px-5 pt-8">
        <Link to="/projects" className="text-accent text-[13px] font-medium">
          ← Projects
        </Link>
        <h1 className="font-display text-[22px] font-bold tracking-tight mt-2">Project not found</h1>
      </div>
    )
  }

  const lines = builder.lines
  const scopeTotal = builder.snapshot?.scope_total ?? 0
  const bidTotal = builder.snapshot?.bid_total ?? 0
  const status = builder.snapshot?.status ?? 'ok'
  const lifecycle = project.data?.project.status ?? 'draft'

  // Active pricing profile feeds the per-line markup breakdown panel.
  // The PricingProfilePicker owns the localStorage pin; this screen just
  // captures the resolved row so every line-row can render its breakdown
  // without re-running the profiles query.
  const [activeProfile, setActiveProfile] = useState<PricingProfile | null>(null)
  const handleProfileResolved = useCallback((p: PricingProfile | null) => setActiveProfile(p), [])
  const activeProfileConfig = activeProfile?.config ?? null

  // Density rule (`estimator/README.md` § estimate-builder): collapse the
  // right rail's bid-accuracy keystone to a single chip when the estimate
  // has fewer than 10 lines. The chip lives in the header strip and
  // expands a Sheet with the full keystone when tapped.
  const isCompactKeystone = lines.length > 0 && lines.length < COMPACT_KEYSTONE_LINE_THRESHOLD
  const [keystoneSheetOpen, setKeystoneSheetOpen] = useState(false)

  return (
    <div className="px-5 pt-6 pb-12 max-w-[1280px] mx-auto">
      {/* Header. */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <Link to={`/projects/${projectId}?tab=estimate`} className="text-[12px] text-ink-3">
            ← Back to project
          </Link>
          <h1 className="font-display text-[22px] font-bold tracking-tight leading-tight mt-1 truncate">
            {project.data?.project.name ?? 'Project estimate'}
          </h1>
          <div className="text-[11px] text-ink-3 mt-0.5 flex items-center gap-2">
            <Pill tone="default">{lifecycle}</Pill>
            <span>·</span>
            <span>
              {lines.length} line{lines.length === 1 ? '' : 's'}
            </span>
            <span>·</span>
            <span className="num">
              ${scopeTotal.toLocaleString()} scope / ${bidTotal.toLocaleString()} bid
            </span>
            {builder.isSaving ? (
              <>
                <span>·</span>
                <span className="text-accent">saving…</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <PricingProfilePicker onProfileResolved={handleProfileResolved} />
          {isCompactKeystone ? (
            // Density-aware: when the estimate is small (<10 lines) the right
            // rail's keystone collapses into this single header chip. Tap to
            // open the full keystone in a sheet — see `keystoneSheetOpen`.
            <BidAccuracyCard projectId={projectId} compact onCompactClick={() => setKeystoneSheetOpen(true)} />
          ) : null}
          <MobileButton
            variant="ghost"
            size="sm"
            disabled={builder.isRecomputing || builder.isLoading}
            onClick={() => builder.recompute()}
          >
            {builder.isRecomputing ? 'Recomputing…' : 'Recompute from takeoff'}
          </MobileButton>
        </div>
      </div>

      {builder.error ? (
        <Card tight className="mb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">
                {builder.conflict ? 'Out of date' : 'Error'}
              </div>
              <div className="text-[12px] text-ink-2 mt-0.5">
                {builder.conflict
                  ? 'Another device wrote to this estimate while you were editing — your view has been refreshed.'
                  : builder.error}
              </div>
            </div>
            <MobileButton variant="ghost" size="sm" onClick={() => builder.dismissError()}>
              Dismiss
            </MobileButton>
          </div>
        </Card>
      ) : null}

      {builder.isLoading ? (
        <SkeletonRows count={6} className="px-0" />
      ) : lines.length === 0 ? (
        <EmptyState
          title="No estimate yet"
          body="Add takeoff measurements or scope items, then run Recompute to populate this builder."
          primaryAction={
            <Link
              to={`/projects/${projectId}/takeoff-canvas`}
              className="w-full h-[50px] rounded-[14px] bg-accent text-white text-[16px] font-semibold inline-flex items-center justify-center"
            >
              Open takeoff
            </Link>
          }
        />
      ) : (
        <div
          className={
            isCompactKeystone
              ? 'grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4'
              : 'grid grid-cols-1 lg:grid-cols-[220px_1fr_320px] gap-4'
          }
        >
          <ScopeTreePane
            lines={lines}
            items={items.data?.serviceItems ?? []}
            selectedCategory={selectedCategory}
            onSelect={setSelectedCategory}
          />
          <LineItemsPane
            lines={lines}
            items={items.data?.serviceItems ?? []}
            selectedCategory={selectedCategory}
            onEdit={builder.editLine}
            pending={builder.pendingEdits}
            status={status}
            pricingProfileConfig={activeProfileConfig}
          />
          {isCompactKeystone ? null : (
            <div className="space-y-3">
              <BidAccuracyCard projectId={projectId} />
              <Card tight>
                <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-1">Totals</div>
                <div className="flex items-baseline justify-between mb-1">
                  <span className="text-[12px] text-ink-2">Scope</span>
                  <span className="num text-[14px] font-semibold">${scopeTotal.toLocaleString()}</span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-[12px] text-ink-2">Bid</span>
                  <span className="num text-[14px] font-semibold">${bidTotal.toLocaleString()}</span>
                </div>
                <div className="text-[10px] text-ink-3 mt-2">
                  {status === 'ok'
                    ? 'Scope matches bid — sign-off ready.'
                    : status === 'warn'
                      ? 'Small drift — review before sending.'
                      : 'Mismatch — resolve before sending.'}
                </div>
              </Card>
              <Attribution source={`Live from /api/projects/${projectId.slice(0, 8)}…/estimate/scope-vs-bid`} />
            </div>
          )}
        </div>
      )}

      {/*
       * Compact-keystone expansion sheet. When the chip is tapped we open
       * the full BidAccuracyCard in a bottom sheet so the user gets the
       * comparables / attribution / dismiss affordance without committing
       * the right-rail real-estate full-time.
       */}
      <Sheet
        open={keystoneSheetOpen}
        onClose={() => setKeystoneSheetOpen(false)}
        title="Bid accuracy"
        ariaLabel="Bid accuracy keystone"
      >
        <BidAccuracyCard projectId={projectId} onDismiss={() => setKeystoneSheetOpen(false)} />
      </Sheet>

      {/* Footer. */}
      <div className="mt-6 flex items-center justify-end gap-2 pt-4 border-t border-line">
        <MobileButton
          variant="primary"
          disabled={lines.length === 0}
          onClick={() => {
            // INTEGRATION TODO: open the `estimate-share-sheet` from the
            // sales-loop slice. The Phase 2C share sheet currently lives
            // inside `estimate-summary.tsx` (`ShareSheet`). When the
            // sales-loop slice extracts it into a standalone component,
            // import + render here. For now the user can still send via
            // the Estimate sub-tab on project detail.
            window.location.href = `/projects/${projectId}?tab=estimate`
          }}
        >
          Send to client
        </MobileButton>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Left pane — scope tree
// ---------------------------------------------------------------------------

interface ScopeTreePaneProps {
  lines: EstimateLine[]
  items: ServiceItem[]
  selectedCategory: string | null
  onSelect: (category: string | null) => void
}

function ScopeTreePane({ lines, items, selectedCategory, onSelect }: ScopeTreePaneProps) {
  const grouped = useMemo(() => groupLinesByCategory(lines, items), [lines, items])
  const allTotal = grouped.reduce((sum, g) => sum + g.total, 0)

  return (
    <Card tight className="lg:sticky lg:top-4 self-start">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 mb-2">Scope</div>
      <ul className="space-y-1">
        <li>
          <ScopeTreeRow
            label="All scope"
            total={allTotal}
            count={lines.length}
            selected={selectedCategory === null}
            onClick={() => onSelect(null)}
          />
        </li>
        {grouped.map((group) => (
          <li key={group.category}>
            <ScopeTreeRow
              label={group.category}
              total={group.total}
              count={group.count}
              selected={selectedCategory === group.category}
              onClick={() => onSelect(group.category === selectedCategory ? null : group.category)}
            />
          </li>
        ))}
      </ul>
      <div className="mt-2 pt-2 border-t border-line">
        <button
          type="button"
          className="text-[11px] text-accent font-medium"
          onClick={() => {
            // INTEGRATION TODO: open a service-item picker sheet to add a
            // brand-new estimate line that doesn't have a corresponding
            // takeoff measurement. The sheet uses `useServiceItems` for
            // the catalog and POSTs into the takeoff/measurement path
            // (or the future estimate-line-create endpoint) so the next
            // recompute keeps the line.
          }}
        >
          + Add scope item
        </button>
      </div>
    </Card>
  )
}

function ScopeTreeRow({
  label,
  total,
  count,
  selected,
  onClick,
}: {
  label: string
  total: number
  count: number
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-baseline justify-between gap-2 px-2 py-1.5 rounded text-left ${
        selected ? 'bg-accent/10 text-accent-ink' : 'text-ink-2 hover:bg-card-soft'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">
        <span className="text-[12px] font-medium">{label}</span>
        <span className="text-[10px] text-ink-3 ml-1">
          ({count} line{count === 1 ? '' : 's'})
        </span>
      </span>
      <span className="num text-[11.5px] font-semibold shrink-0">${total.toLocaleString()}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Center pane — line items table
// ---------------------------------------------------------------------------

interface LineItemsPaneProps {
  lines: EstimateLine[]
  items: ServiceItem[]
  selectedCategory: string | null
  onEdit: (edit: { service_item_code: string; quantity?: number; override_rate?: number | null }) => void
  pending: Record<string, { quantity?: number; override_rate?: number | null }>
  status: string
  pricingProfileConfig: unknown
}

function LineItemsPane({ lines, items, selectedCategory, onEdit, pending, pricingProfileConfig }: LineItemsPaneProps) {
  const itemIndex = useMemo(() => {
    const map = new Map<string, ServiceItem>()
    for (const i of items) map.set(i.code, i)
    return map
  }, [items])

  const filtered = useMemo(() => {
    if (!selectedCategory) return lines
    return lines.filter((l) => (itemIndex.get(l.service_item_code)?.category ?? 'uncategorised') === selectedCategory)
  }, [lines, selectedCategory, itemIndex])

  const subtotal = filtered.reduce((sum, l) => sum + Number(l.amount), 0)

  return (
    <Card>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-[13px] font-semibold">{selectedCategory ?? 'All line items'}</div>
        <div className="text-[10px] text-ink-3 num">
          {filtered.length} line{filtered.length === 1 ? '' : 's'} · ${subtotal.toLocaleString()}
        </div>
      </div>
      {filtered.length === 0 ? (
        <div className="text-[12px] text-ink-3 py-3">No lines in this group.</div>
      ) : (
        <ul className="divide-y divide-line">
          {filtered.map((line) => (
            <li key={`${line.service_item_code}-${line.created_at}`}>
              <LineItemRow
                line={line}
                item={itemIndex.get(line.service_item_code) ?? null}
                pending={pending[line.service_item_code] ?? null}
                onEdit={onEdit}
                pricingProfileConfig={pricingProfileConfig}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

interface LineItemRowProps {
  line: EstimateLine
  item: ServiceItem | null
  pending: { quantity?: number; override_rate?: number | null } | null
  onEdit: (edit: { service_item_code: string; quantity?: number; override_rate?: number | null }) => void
  pricingProfileConfig: unknown
}

function LineItemRow({ line, item, pending, onEdit, pricingProfileConfig }: LineItemRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [qtyDraft, setQtyDraft] = useState<string>(() => formatQty(line.quantity))
  const [rateDraft, setRateDraft] = useState<string>(() => formatRate(line.rate))

  // Re-sync drafts when the underlying snapshot changes (e.g. a recompute
  // landed). Pending edits keep their local values so the user doesn't
  // lose typing while a debounced save fires.
  useEffect(() => {
    if (!pending) {
      setQtyDraft(formatQty(line.quantity))
      setRateDraft(formatRate(line.rate))
    }
  }, [line.quantity, line.rate, pending])

  const qty = pending?.quantity ?? Number(line.quantity)
  const rate = pending?.override_rate ?? Number(line.rate)
  const amount = qty * rate

  return (
    <div className="py-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium truncate">{line.service_item_code}</div>
          <div className="text-[10.5px] text-ink-3 truncate">
            {item?.name ?? 'Unmapped service item'}
            {item?.category ? ` · ${item.category}` : ''}
          </div>
        </div>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          aria-label={`quantity for ${line.service_item_code}`}
          value={qtyDraft}
          onChange={(e) => {
            setQtyDraft(e.target.value)
            const next = Number(e.target.value)
            if (Number.isFinite(next)) onEdit({ service_item_code: line.service_item_code, quantity: next })
          }}
          className="w-20 text-right num text-[12.5px] font-medium px-1.5 py-1 rounded border border-line bg-card focus:outline-none focus:border-accent"
        />
        <span className="text-[10.5px] text-ink-3 shrink-0">{line.unit}</span>
        <span className="text-[10.5px] text-ink-3 shrink-0">×</span>
        <div className="flex items-center gap-0.5">
          <span className="text-[10.5px] text-ink-3">$</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            aria-label={`rate for ${line.service_item_code}`}
            value={rateDraft}
            onChange={(e) => {
              setRateDraft(e.target.value)
              const next = Number(e.target.value)
              if (Number.isFinite(next)) onEdit({ service_item_code: line.service_item_code, override_rate: next })
            }}
            className="w-20 text-right num text-[12.5px] font-medium px-1.5 py-1 rounded border border-line bg-card focus:outline-none focus:border-accent"
          />
        </div>
        <div className="num text-[13px] font-semibold w-24 text-right shrink-0">
          ${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </div>
        <button
          type="button"
          aria-label={expanded ? 'Hide assembly' : 'Show assembly'}
          onClick={() => setExpanded((v) => !v)}
          className="text-[12px] text-ink-3 hover:text-accent w-5 text-center shrink-0"
        >
          {expanded ? '−' : '+'}
        </button>
      </div>
      {pending ? <div className="text-[10px] text-accent mt-1">Edited · saving on next debounce</div> : null}
      {expanded ? (
        <div className="mt-2 pl-3 border-l-2 border-accent/30">
          <EstimateLineAssembly
            serviceItemCode={line.service_item_code}
            {...(item?.name ? { lineLabel: item.name } : {})}
          />
        </div>
      ) : null}
      {/*
       * Transparent markup breakdown — collapsed by default. Uses native
       * <details> so it adds zero visual noise for users who don't care
       * about the math. Opening reveals the labor/material × multiplier
       * → final-amount table from `applyMarkup` against the active
       * pricing profile.
       */}
      <details className="mt-1.5 group">
        <summary className="list-none cursor-pointer text-[10.5px] text-ink-3 hover:text-accent select-none flex items-center gap-1">
          <span aria-hidden="true" className="group-open:rotate-90 inline-block transition-transform">
            ▸
          </span>
          <span>Markup breakdown</span>
        </summary>
        <div className="mt-1.5 pl-3 border-l-2 border-line">
          <EstimateMarkupBreakdown
            serviceItemCode={line.service_item_code}
            lineAmount={amount}
            pricingProfileConfig={pricingProfileConfig}
          />
        </div>
      </details>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CategoryGroup {
  category: string
  total: number
  count: number
}

function groupLinesByCategory(lines: EstimateLine[], items: ServiceItem[]): CategoryGroup[] {
  const itemIndex = new Map<string, ServiceItem>()
  for (const i of items) itemIndex.set(i.code, i)

  const groups = new Map<string, CategoryGroup>()
  for (const line of lines) {
    const cat = itemIndex.get(line.service_item_code)?.category ?? 'uncategorised'
    const existing = groups.get(cat)
    const amount = Number(line.amount)
    if (existing) {
      existing.total += amount
      existing.count += 1
    } else {
      groups.set(cat, { category: cat, total: amount, count: 1 })
    }
  }
  return [...groups.values()].sort((a, b) => b.total - a.total)
}

function formatQty(raw: string | number): string {
  const n = Number(raw)
  if (!Number.isFinite(n)) return '0'
  return String(n)
}

function formatRate(raw: string | number): string {
  const n = Number(raw)
  if (!Number.isFinite(n)) return '0'
  return n.toFixed(2)
}
