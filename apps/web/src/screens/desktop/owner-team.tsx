/**
 * Owner desktop team roster — the crew command view (Desktop v2 · OWNER · TEAM).
 * Reuses the same bootstrap payload as the mobile owner home; renders the
 * company roster (bootstrap.workers) joined against this-week labor
 * (bootstrap.laborEntries) as a dense desktop table. See
 * docs/V2_DESKTOP_AND_REMAINING_PLAN.md.
 */
import { useMemo, useState } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MAvatar, MChip, MChipRow, MPill, avatarToneFor, initialsFor } from '@/components/m'
import { formatDecimalHours, formatMoney, todayIso } from '../mobile/format.js'

type CrewRow = {
  id: string
  name: string
  role: string
  rate: number | null
  weekHours: number
  onClock: boolean
}

type Filter = 'all' | 'foremen' | 'crew'

function isForeman(role: string): boolean {
  return /foreman|lead|super/i.test(role)
}

function weekStartIso(): string {
  // Monday-based week start in local time, as YYYY-MM-DD to compare against
  // laborEntries.occurred_on (which is a local-date string).
  const now = new Date()
  const day = (now.getDay() + 6) % 7 // 0 = Monday
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day)
  const y = monday.getFullYear()
  const m = String(monday.getMonth() + 1).padStart(2, '0')
  const d = String(monday.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function OwnerTeam({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const [filter, setFilter] = useState<Filter>('all')

  const workers = useMemo(() => bootstrap?.workers ?? [], [bootstrap?.workers])
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])

  const { rows, activeCount, onClockCount, foremenCount, weekTotal } = useMemo(() => {
    const active = workers.filter((w) => !w.deleted_at)
    const weekStart = weekStartIso()
    const today = todayIso()

    const weekHoursByWorker = new Map<string, number>()
    const onClockToday = new Set<string>()
    for (const l of labor) {
      if (l.deleted_at || !l.worker_id) continue
      if (l.occurred_on < weekStart) continue
      const hrs = Number(l.hours ?? 0)
      if (!Number.isFinite(hrs)) continue
      weekHoursByWorker.set(l.worker_id, (weekHoursByWorker.get(l.worker_id) ?? 0) + hrs)
      if (l.occurred_on === today && hrs > 0) onClockToday.add(l.worker_id)
    }

    const rows: CrewRow[] = active.map((w) => ({
      id: w.id,
      name: w.name,
      role: w.role,
      rate: null, // hourly rate is not carried on the worker roster
      weekHours: weekHoursByWorker.get(w.id) ?? 0,
      onClock: onClockToday.has(w.id),
    }))

    let weekTotal = 0
    for (const v of weekHoursByWorker.values()) weekTotal += v

    return {
      rows,
      activeCount: active.length,
      onClockCount: onClockToday.size,
      foremenCount: active.filter((w) => isForeman(w.role)).length,
      weekTotal,
    }
  }, [workers, labor])

  const visibleRows = useMemo(() => {
    if (filter === 'foremen') return rows.filter((r) => isForeman(r.role))
    if (filter === 'crew') return rows.filter((r) => !isForeman(r.role))
    return rows
  }, [rows, filter])

  const columns: Array<DColumn<CrewRow>> = [
    {
      key: 'name',
      header: 'Name',
      render: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <MAvatar initials={initialsFor(r.name) || '—'} tone={avatarToneFor(r.id)} size="sm" />
          <span className="d-table-cell-strong">{r.name}</span>
        </span>
      ),
    },
    { key: 'role', header: 'Role', render: (r) => r.role || '—' },
    { key: 'rate', header: 'Rate', numeric: true, render: (r) => (r.rate == null ? '—' : `${formatMoney(r.rate)}/h`) },
    {
      key: 'week',
      header: 'This week',
      numeric: true,
      render: (r) => (r.weekHours > 0 ? formatDecimalHours(r.weekHours, 1) : '—'),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <MPill tone={r.onClock ? 'green' : undefined} dot>
          {r.onClock ? 'On clock' : 'Off'}
        </MPill>
      ),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Owner · Team</DEyebrow>
          <DH1>
            {activeCount} {activeCount === 1 ? 'worker' : 'workers'} active
            {onClockCount > 0 ? `, ${onClockCount} on the clock.` : '.'}
          </DH1>
        </div>

        <DKpiStrip>
          <DKpi label="Active crew" value={String(activeCount)} meta="On the roster" />
          <DKpi
            label="On clock now"
            value={String(onClockCount)}
            tone={onClockCount > 0 ? 'accent' : undefined}
            meta={onClockCount > 0 ? 'Logged today' : 'Nobody clocked in'}
            metaTone={onClockCount > 0 ? 'good' : undefined}
          />
          <DKpi label="Foremen" value={String(foremenCount)} meta="Crew leads" />
          <DKpi
            label="This-week hours"
            value={formatDecimalHours(weekTotal, 1).replace('h', '')}
            unit="h"
            meta={weekTotal > 0 ? 'Across the crew' : 'No hours yet'}
            metaTone={weekTotal > 0 ? 'good' : undefined}
          />
        </DKpiStrip>

        <MChipRow>
          <MChip active={filter === 'all'} onClick={() => setFilter('all')} count={rows.length}>
            All
          </MChip>
          <MChip
            active={filter === 'foremen'}
            onClick={() => setFilter('foremen')}
            count={rows.filter((r) => isForeman(r.role)).length}
          >
            Foremen
          </MChip>
          <MChip
            active={filter === 'crew'}
            onClick={() => setFilter('crew')}
            count={rows.filter((r) => !isForeman(r.role)).length}
          >
            Crew
          </MChip>
        </MChipRow>

        <DataTable<CrewRow>
          title="Crew roster"
          columns={columns}
          rows={visibleRows}
          rowKey={(r) => r.id}
          empty={
            filter === 'all'
              ? 'No crew yet. Workers land here once they’re added to the company.'
              : 'No workers match this filter.'
          }
        />
      </div>
    </div>
  )
}
