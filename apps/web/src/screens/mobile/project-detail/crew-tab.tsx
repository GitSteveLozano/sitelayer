import { useMemo } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import {
  MAvatarGroup,
  MListInset,
  MListRow,
  MSectionH,
  avatarToneFor,
  initialsFor,
} from '../../../components/m/index.js'
import { formatDecimalHours } from '../format.js'

export function CrewTab({
  labor,
  workers,
}: {
  labor: BootstrapResponse['laborEntries']
  workers: BootstrapResponse['workers']
}) {
  const byWorker = useMemo(() => {
    const map = new Map<string, { hours: number; name: string }>()
    for (const l of labor) {
      const wid = l.worker_id ?? 'unassigned'
      const name = workers.find((w) => w.id === wid)?.name ?? 'Unassigned'
      const cur = map.get(wid) ?? { hours: 0, name }
      cur.hours += Number(l.hours ?? 0)
      map.set(wid, cur)
    }
    return Array.from(map.entries())
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.hours - a.hours)
  }, [labor, workers])

  if (byWorker.length === 0) {
    return (
      <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--m-ink-3)', fontSize: 13 }}>
        No labor entries logged yet.
      </div>
    )
  }

  return (
    <div style={{ paddingTop: 8 }}>
      <div style={{ padding: '0 16px 12px' }}>
        <MAvatarGroup
          avatars={byWorker.slice(0, 6).map((w) => ({
            initials: initialsFor(w.name),
            tone: avatarToneFor(w.id),
          }))}
          max={6}
        />
      </div>
      <MSectionH>Hours by crew member</MSectionH>
      <MListInset>
        {byWorker.map((w) => (
          <MListRow
            key={w.id}
            headline={w.name}
            trailing={<span className="num">{formatDecimalHours(w.hours, 1)}</span>}
          />
        ))}
      </MListInset>
    </div>
  )
}
