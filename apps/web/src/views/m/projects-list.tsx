/**
 * Mobile projects index. Search + state-filter chips + stacked project cards.
 *
 * Per Design Overview/estimator/screenshots/prj-list.png — chips at the top
 * (Active / Awaiting client / Closeout / All), then card-style rows with a
 * left-side state stripe + headline + supporting + trailing metadata.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse, ProjectRow } from '../../api.js'
import {
  MBody,
  MChip,
  MChipRow,
  MI,
  MPill,
  MTopBar,
} from '../../components/m/index.js'
import { MEmptyState } from '../../components/m-states/index.js'
import { formatMoney, formatStatusLabel, statusTone } from './format.js'

type FilterKey = 'all' | 'active' | 'awaiting' | 'closeout'

const FILTER_MATCHERS: Record<FilterKey, (p: ProjectRow) => boolean> = {
  all: () => true,
  active: (p) => /progress|active/i.test(p.status),
  awaiting: (p) => /estim|sent|await|draft/i.test(p.status),
  closeout: (p) => /close|done/i.test(p.status),
}

export function MobileProjectsList({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<FilterKey>('active')
  const [query, setQuery] = useState('')

  const projects = bootstrap?.projects ?? []

  const counts = useMemo(() => {
    return {
      all: projects.length,
      active: projects.filter(FILTER_MATCHERS.active).length,
      awaiting: projects.filter(FILTER_MATCHERS.awaiting).length,
      closeout: projects.filter(FILTER_MATCHERS.closeout).length,
    }
  }, [projects])

  const visible = useMemo(() => {
    const filtered = projects.filter(FILTER_MATCHERS[filter])
    if (!query.trim()) return filtered
    const q = query.toLowerCase()
    return filtered.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.customer_name.toLowerCase().includes(q) ||
        p.division_code.toLowerCase().includes(q),
    )
  }, [projects, filter, query])

  return (
    <>
      <MTopBar
        title="Projects"
        actionIcon={<MI.Plus size={20} />}
        actionLabel="New project"
        onAction={() => navigate('/m/projects/new')}
      />
      <MBody>
        <div style={{ padding: '12px 16px 4px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'var(--m-card-soft)',
              borderRadius: 12,
              padding: '0 12px',
              height: 42,
            }}
          >
            <MI.Search size={18} style={{ color: 'var(--m-ink-3)' }} />
            <input
              type="search"
              placeholder="Search projects, clients…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontFamily: 'inherit',
                fontSize: 15,
                color: 'var(--m-ink)',
              }}
            />
          </div>
        </div>
        <MChipRow>
          <MChip active={filter === 'active'} onClick={() => setFilter('active')} count={counts.active}>
            Active
          </MChip>
          <MChip active={filter === 'awaiting'} onClick={() => setFilter('awaiting')} count={counts.awaiting}>
            Awaiting client
          </MChip>
          <MChip active={filter === 'closeout'} onClick={() => setFilter('closeout')} count={counts.closeout}>
            Closeout
          </MChip>
          <MChip active={filter === 'all'} onClick={() => setFilter('all')} count={counts.all}>
            All
          </MChip>
        </MChipRow>
        {projects.length === 0 ? (
          <MEmptyState
            title="No projects yet"
            body="Start with an address or upload drawings — Sitelayer will help you get to a measurement plan in under a minute."
            primaryLabel="New project"
            secondaryLabel="Import from QuickBooks"
            onPrimary={() => navigate('/m/projects/new')}
          />
        ) : visible.length === 0 ? (
          <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--m-ink-3)', fontSize: 13 }}>
            No projects match this filter.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 16px 16px' }}>
            {visible.map((p) => (
              <ProjectCard key={p.id} project={p} onOpen={() => navigate(`/m/projects/${p.id}`)} />
            ))}
          </div>
        )}
      </MBody>
    </>
  )
}

function ProjectCard({ project, onOpen }: { project: ProjectRow; onOpen: () => void }) {
  const tone = statusTone(project.status)
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        background: 'var(--m-card)',
        border: '1px solid var(--m-line)',
        borderLeft: `4px solid var(--m-${tone === 'green' ? 'green' : tone === 'amber' ? 'amber' : tone === 'red' ? 'red' : tone === 'blue' ? 'blue' : 'line-2'})`,
        borderRadius: 12,
        padding: '12px 14px',
        textAlign: 'left',
        font: 'inherit',
        color: 'inherit',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <MPill tone={tone} dot>
          {formatStatusLabel(project.status)}
        </MPill>
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 2 }}>{project.name}</div>
      <div style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>
        {project.customer_name} · {project.division_code}
      </div>
      <div
        style={{
          marginTop: 8,
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 12,
          color: 'var(--m-ink-2)',
        }}
      >
        <span>Bid {formatMoney(project.bid_total)}</span>
        {project.target_sqft_per_hr ? <span>Target {project.target_sqft_per_hr} sf/hr</span> : null}
      </div>
    </button>
  )
}
