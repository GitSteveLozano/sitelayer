import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Clipboard, Download } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { buildTakeoffPreviewScene } from '@/lib/takeoff/geometry-3d'
import { TakeoffThreeScene } from './takeoff-3d-scene'
import { TAKEOFF_DEMO_FIXTURES } from './takeoff-preview-demo-fixtures'

type CopyState = 'idle' | 'copied' | 'failed'

const DEFAULT_FIXTURE = TAKEOFF_DEMO_FIXTURES[0]!

export function TakeoffPreviewDemo() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const fixtureId = searchParams.get('fixture') ?? DEFAULT_FIXTURE.id
  const fixture = TAKEOFF_DEMO_FIXTURES.find((candidate) => candidate.id === fixtureId) ?? DEFAULT_FIXTURE
  const scene = useMemo(() => {
    return buildTakeoffPreviewScene(fixture.measurements, {
      activeBlueprintId: fixture.blueprintId,
      activePage: fixture.page,
    })
  }, [fixture])
  const selected = scene.items.find((item) => item.id === selectedId) ?? null
  const debugPayload = useMemo(
    () => ({
      payload_version: 1,
      route: '/demo/takeoff-preview-3d',
      fixture: {
        id: fixture.id,
        name: fixture.name,
        description: fixture.description,
        reference_title: fixture.referenceTitle,
        reference_notes: fixture.referenceNotes,
      },
      page: fixture.page,
      measurements: fixture.measurements,
      scene,
    }),
    [fixture, scene],
  )
  const debugJson = useMemo(() => JSON.stringify(debugPayload, null, 2), [debugPayload])

  useEffect(() => {
    setSelectedId(null)
  }, [fixture.id])

  useEffect(() => {
    if (copyState === 'idle') return
    const timeout = window.setTimeout(() => setCopyState('idle'), 1800)
    return () => window.clearTimeout(timeout)
  }, [copyState])

  const onFixtureChange = useCallback(
    (nextFixtureId: string) => {
      const next = new URLSearchParams(searchParams)
      if (nextFixtureId === DEFAULT_FIXTURE.id) {
        next.delete('fixture')
      } else {
        next.set('fixture', nextFixtureId)
      }
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const onCopyDebugPayload = useCallback(async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(debugJson)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }, [debugJson])

  const onDownloadDebugPayload = useCallback(() => {
    const blob = new Blob([debugJson], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `sitelayer-3d-takeoff-${fixture.id}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }, [debugJson, fixture.id])

  return (
    <div className="min-h-screen bg-[#0d1117] text-white flex flex-col">
      <header className="shrink-0 border-b border-white/10 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12px] text-white/55">Sitelayer</div>
            <h1 className="mt-1 text-[20px] font-semibold tracking-normal truncate">3D takeoff demo</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded border border-white/15 px-3 py-2 text-[12px] text-white/70">
              <div className="font-mono tabular-nums text-white">{scene.items.length}</div>
              <div>drawable measurements</div>
            </div>
            <button
              type="button"
              onClick={() => void onCopyDebugPayload()}
              className="inline-flex h-10 items-center gap-2 rounded border border-white/15 px-3 text-[12px] font-semibold text-white/80 transition hover:bg-white/10"
            >
              {copyState === 'copied' ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy JSON'}
            </button>
            <button
              type="button"
              onClick={onDownloadDebugPayload}
              className="inline-flex h-10 items-center gap-2 rounded border border-white/15 px-3 text-[12px] font-semibold text-white/80 transition hover:bg-white/10"
            >
              <Download className="h-4 w-4" />
              Download
            </button>
          </div>
        </div>
      </header>

      <main className="relative flex-1 min-h-[560px] overflow-hidden">
        <TakeoffThreeScene scene={scene} selectedId={selectedId} onSelect={setSelectedId} />

        <aside className="absolute left-3 top-3 w-[min(390px,calc(100vw-24px))] max-h-[calc(100%-24px)] overflow-y-auto rounded border border-white/12 bg-[#0d1117]/90 shadow-2xl backdrop-blur">
          <div className="border-b border-white/10 px-3 py-2">
            <div className="text-[12px] font-semibold text-white">{fixture.name}</div>
            <div className="mt-0.5 text-[11px] text-white/55">
              Scale: {scene.worldPerBoardUnit.toFixed(3)} ft / board unit
            </div>
            <div className="mt-2 grid grid-cols-3 gap-1" role="group" aria-label="Demo fixture">
              {TAKEOFF_DEMO_FIXTURES.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  data-testid={`takeoff-demo-fixture-${candidate.id}`}
                  onClick={() => onFixtureChange(candidate.id)}
                  className={`min-h-9 rounded border px-2 text-[11px] font-semibold transition ${
                    candidate.id === fixture.id
                      ? 'border-white/45 bg-white/15 text-white'
                      : 'border-white/12 text-white/60 hover:bg-white/8'
                  }`}
                >
                  {candidate.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-4 text-white/60">{fixture.description}</p>
          </div>

          <div className="border-b border-white/10 px-3 py-2">
            <div className="text-[11px] uppercase tracking-[0.06em] text-white/45">Reference</div>
            <div className="mt-1 text-[12px] font-semibold text-white">{fixture.referenceTitle}</div>
            <ul className="mt-1 space-y-1 text-[11px] leading-4 text-white/58">
              {fixture.referenceNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>

          {selected ? (
            <div className="border-b border-white/10 px-3 py-2">
              <div className="text-[11px] uppercase tracking-[0.06em] text-white/45">Selected</div>
              <div className="mt-1 text-[13px] font-semibold">{selected.serviceItemCode}</div>
              <div className="mt-1 font-mono tabular-nums text-[18px]">
                {selected.quantity.toFixed(2)} {selected.unit}
              </div>
              <div className="mt-1 text-[11px] text-white/55">
                {selected.kind}
                {selected.elevation ? ` · ${selected.elevation}` : ''}
              </div>
            </div>
          ) : null}

          <div className="divide-y divide-white/10">
            {scene.items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelectedId(item.id)}
                className={`w-full px-3 py-2 text-left transition ${
                  selectedId === item.id ? 'bg-white/12' : 'hover:bg-white/8'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-[12px] font-semibold">{item.serviceItemCode}</span>
                  <span className="shrink-0 font-mono tabular-nums text-[12px] text-white/70">
                    {item.quantity.toFixed(1)} {item.unit}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-white/45">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
                  <span>{item.kind}</span>
                  {item.elevation ? <span>{item.elevation}</span> : null}
                </div>
              </button>
            ))}
          </div>

          <details className="border-t border-white/10 px-3 py-2">
            <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.06em] text-white/50">
              Scene JSON
            </summary>
            <pre
              data-testid="takeoff-demo-debug-json"
              className="mt-2 max-h-56 overflow-auto rounded bg-black/35 p-2 text-[10px] leading-4 text-white/65"
            >
              {debugJson}
            </pre>
          </details>
        </aside>

        <div className="absolute bottom-3 right-3 rounded border border-white/12 bg-[#0d1117]/75 px-3 py-2 text-[11px] text-white/60 backdrop-blur">
          Drag to rotate · scroll to zoom · click to inspect
        </div>
      </main>
    </div>
  )
}
