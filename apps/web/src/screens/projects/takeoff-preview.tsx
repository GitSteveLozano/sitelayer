import { useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  useBlueprintPages,
  useProjectBlueprints,
  useProjectMeasurements,
  useTakeoffDrafts,
  type BlueprintDocument,
  type TakeoffDraft,
} from '@/lib/api'
import { buildTakeoffPreviewScene } from '@/lib/takeoff/geometry-3d'
import { TakeoffThreeScene } from './takeoff-3d-scene'

export function TakeoffPreviewScreen() {
  const { id: projectId } = useParams<{ id: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const blueprints = useProjectBlueprints(projectId)
  const drafts = useTakeoffDrafts(projectId)
  const blueprintParam = searchParams.get('blueprint')
  const draftParam = searchParams.get('draft')

  const blueprintList = blueprints.data?.blueprints ?? []
  const activeBlueprint: BlueprintDocument | null =
    blueprintList.find((blueprint) => blueprint.id === blueprintParam) ?? blueprintList[0] ?? null
  const blueprintPages = useBlueprintPages(activeBlueprint?.id)
  const activePage = blueprintPages.data?.pages[0] ?? null

  const draftList = drafts.data?.drafts ?? []
  const activeDraft: TakeoffDraft | null = draftList.find((draft) => draft.id === draftParam) ?? draftList[0] ?? null
  const activeDraftId = activeDraft?.id ?? null
  const measurements = useProjectMeasurements(projectId, { draftId: activeDraftId })

  const scene = useMemo(
    () =>
      buildTakeoffPreviewScene(measurements.data?.measurements ?? [], {
        activeBlueprintId: activeBlueprint?.id ?? null,
        activePage,
      }),
    [activeBlueprint?.id, activePage, measurements.data?.measurements],
  )

  const selected = scene.items.find((item) => item.id === selectedId) ?? null

  const setParam = (key: 'blueprint' | 'draft', value: string) => {
    const next = new URLSearchParams(searchParams)
    next.set(key, value)
    setSearchParams(next, { replace: true })
    setSelectedId(null)
  }

  if (!projectId) {
    return (
      <div className="px-5 pt-8">
        <Link to="/projects" className="text-accent text-[13px] font-medium">
          ← back
        </Link>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0d1117] text-white flex flex-col">
      <header className="shrink-0 border-b border-white/10 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Link to={`/projects/${projectId}/takeoff-canvas`} className="text-[12px] text-white/60 hover:text-white">
              ← Canvas
            </Link>
            <h1 className="mt-1 text-[20px] font-semibold tracking-normal truncate">3D takeoff view</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <Link to={`/projects/${projectId}/takeoff-summary`} className="px-3 py-2 rounded border border-white/15">
              Summary
            </Link>
            <Link to={`/projects/${projectId}`} className="px-3 py-2 rounded border border-white/15">
              Project
            </Link>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <label className="text-[11px] uppercase tracking-[0.06em] text-white/50">
            Blueprint
            <select
              value={activeBlueprint?.id ?? ''}
              onChange={(event) => setParam('blueprint', event.target.value)}
              className="mt-1 block w-full rounded border border-white/15 bg-[#161b22] px-2 py-2 text-[13px] normal-case tracking-normal text-white"
            >
              {blueprintList.length === 0 ? <option value="">No blueprint</option> : null}
              {blueprintList.map((blueprint) => (
                <option key={blueprint.id} value={blueprint.id}>
                  {blueprint.file_name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] uppercase tracking-[0.06em] text-white/50">
            Draft
            <select
              value={activeDraftId ?? ''}
              onChange={(event) => setParam('draft', event.target.value)}
              className="mt-1 block w-full rounded border border-white/15 bg-[#161b22] px-2 py-2 text-[13px] normal-case tracking-normal text-white"
            >
              {draftList.length === 0 ? <option value="">No draft</option> : null}
              {draftList.map((draft) => (
                <option key={draft.id} value={draft.id}>
                  {draft.name}
                  {draft.source && draft.source !== 'manual' ? ` · ${draft.source}` : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="rounded border border-white/15 px-3 py-2 text-[12px] text-white/70">
            <div className="font-mono tabular-nums text-white">{scene.items.length}</div>
            <div>drawable measurements</div>
          </div>
        </div>
      </header>

      <main className="relative flex-1 min-h-[560px] overflow-hidden">
        <TakeoffThreeScene scene={scene} selectedId={selectedId} onSelect={setSelectedId} />

        <aside className="absolute left-3 top-3 w-[min(360px,calc(100vw-24px))] max-h-[calc(100%-24px)] overflow-y-auto rounded border border-white/12 bg-[#0d1117]/90 shadow-2xl backdrop-blur">
          <div className="border-b border-white/10 px-3 py-2">
            <div className="text-[12px] font-semibold text-white">Scene</div>
            <div className="mt-0.5 text-[11px] text-white/55">
              Scale: {scene.hasCalibration ? `${scene.worldPerBoardUnit.toFixed(3)} ft / board unit` : 'board-space'}
            </div>
          </div>

          {scene.warnings.length > 0 ? (
            <div className="border-b border-white/10 px-3 py-2 text-[11px] text-[#f2c97d]">
              {scene.warnings.map((warning) => (
                <div key={warning}>{warning}</div>
              ))}
            </div>
          ) : null}

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
              <Link
                to={`/projects/${projectId}/takeoff/${selected.id}`}
                className="mt-2 inline-flex rounded bg-white px-3 py-1.5 text-[12px] font-semibold text-[#0d1117]"
              >
                Open measurement
              </Link>
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
        </aside>

        <div className="absolute bottom-3 right-3 rounded border border-white/12 bg-[#0d1117]/75 px-3 py-2 text-[11px] text-white/60 backdrop-blur">
          Drag to rotate · scroll to zoom · click to inspect
        </div>
      </main>
    </div>
  )
}
