/**
 * Live crew — `fm-crew`. Per-site stacked groups with avatar + role +
 * status dot. By site / By person / Map chip toggles control grouping.
 *
 * Status (on site / on break / off-clock) is derived from the latest
 * /api/clock/timeline event per worker. For Phase 8 we render from
 * bootstrap labor counts as a proxy until the timeline call is wired.
 */
import { useMemo, useState } from 'react'
import type { BootstrapResponse } from '../../api.js'
import {
  MAvatar,
  MBody,
  MChip,
  MChipRow,
  MI,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTopBar,
  avatarToneFor,
  initialsFor,
} from '../../components/m/index.js'
import { formatDecimalHours, todayIso } from './format.js'

type GroupBy = 'site' | 'person' | 'map'

export function ForemanCrew({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const [grp, setGrp] = useState<GroupBy>('site')
  const projects = bootstrap?.projects ?? []
  const workers = bootstrap?.workers ?? []
  const labor = bootstrap?.laborEntries ?? []
  const today = todayIso()

  const todayHoursByWorker = useMemo(() => {
    const map = new Map<string, number>()
    for (const l of labor) {
      if (l.occurred_on === today && !l.deleted_at && l.worker_id) {
        map.set(l.worker_id, (map.get(l.worker_id) ?? 0) + Number(l.hours ?? 0))
      }
    }
    return map
  }, [labor, today])

  const onSite = workers.filter((w) => (todayHoursByWorker.get(w.id) ?? 0) > 0)
  const offClock = workers.length - onSite.length

  return (
    <>
      <MTopBar title="Crew" actionIcon={<MI.Plus size={20} />} actionLabel="Add" />
      <MBody>
        <div style={{ padding: '8px 16px 0' }}>
          <div
            style={{
              fontSize: 11,
              color: 'var(--m-ink-3)',
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            Crew · today
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>
            {onSite.length} of {workers.length} on site
            {offClock > 0 ? (
              <span style={{ color: 'var(--m-amber)', fontSize: 13, fontWeight: 600, marginLeft: 6 }}>
                · {offClock} off-clock
              </span>
            ) : null}
          </div>
        </div>
        <MChipRow>
          <MChip active={grp === 'site'} onClick={() => setGrp('site')}>
            By site
          </MChip>
          <MChip active={grp === 'person'} onClick={() => setGrp('person')}>
            By person
          </MChip>
          <MChip active={grp === 'map'} onClick={() => setGrp('map')}>
            Map
          </MChip>
        </MChipRow>
        {grp === 'map' ? (
          <div style={{ padding: '0 16px' }}>
            <div
              className="m-card"
              style={{
                height: 220,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--m-ink-3)',
              }}
            >
              Map view coming soon
            </div>
          </div>
        ) : grp === 'person' ? (
          <>
            <MSectionH>All crew</MSectionH>
            <MListInset>
              {workers.map((w) => {
                const hrs = todayHoursByWorker.get(w.id) ?? 0
                const isOn = hrs > 0
                return (
                  <MListRow
                    key={w.id}
                    leading={<MAvatar initials={initialsFor(w.name)} tone={avatarToneFor(w.id)} size="sm" />}
                    headline={w.name}
                    supporting={w.role ?? 'Crew'}
                    trailing={
                      isOn ? (
                        <>
                          <span className="num">{formatDecimalHours(hrs, 1)}</span>
                          <MPill tone="green" dot>
                            on site
                          </MPill>
                        </>
                      ) : (
                        <MPill>off-clock</MPill>
                      )
                    }
                  />
                )
              })}
            </MListInset>
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 16px 16px' }}>
            {projects
              .filter((p) => /progress|active/i.test(p.status))
              .map((p) => {
                const hrs = labor
                  .filter((l) => l.occurred_on === today && !l.deleted_at && l.project_id === p.id)
                  .reduce((sum, l) => sum + Number(l.hours ?? 0), 0)
                const onSiteWorkers = workers.filter((w) =>
                  labor.some(
                    (l) => l.occurred_on === today && !l.deleted_at && l.project_id === p.id && l.worker_id === w.id,
                  ),
                )
                if (onSiteWorkers.length === 0) return null
                return (
                  <div key={p.id} className="m-card" style={{ padding: 0 }}>
                    <div
                      style={{
                        padding: '12px 14px',
                        borderBottom: '1px solid var(--m-line)',
                        display: 'flex',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 15, fontWeight: 600 }}>{p.name}</div>
                        <div className="m-quiet-sm">Briefed by you · {p.division_code}</div>
                      </div>
                      <div className="m-quiet-sm" style={{ alignSelf: 'center' }}>
                        <span className="num">{formatDecimalHours(hrs, 1)}</span>
                      </div>
                    </div>
                    {onSiteWorkers.map((w) => (
                      <div
                        key={w.id}
                        style={{
                          padding: '10px 14px',
                          borderBottom: '1px solid var(--m-line)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                        }}
                      >
                        <MAvatar initials={initialsFor(w.name)} tone={avatarToneFor(w.id)} size="sm" />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14 }}>{w.name}</div>
                          <div className="m-quiet-sm">{w.role ?? 'Crew'}</div>
                        </div>
                        <MPill tone="green" dot>
                          on site
                        </MPill>
                      </div>
                    ))}
                  </div>
                )
              })}
          </div>
        )}
      </MBody>
    </>
  )
}
