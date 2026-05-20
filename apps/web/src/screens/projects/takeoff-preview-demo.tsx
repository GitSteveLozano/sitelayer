import { useMemo, useState } from 'react'
import type { BlueprintPage, TakeoffMeasurement } from '@/lib/api'
import { buildTakeoffPreviewScene } from '@/lib/takeoff/geometry-3d'
import { TakeoffThreeScene } from './takeoff-3d-scene'

const DEMO_BLUEPRINT_ID = 'demo-blueprint'

const DEMO_PAGE: BlueprintPage = {
  id: 'demo-page',
  blueprint_document_id: DEMO_BLUEPRINT_ID,
  page_number: 1,
  storage_path: null,
  calibration_x1: '18',
  calibration_y1: '82',
  calibration_x2: '82',
  calibration_y2: '82',
  calibration_world_distance: '48',
  calibration_world_unit: 'ft',
  calibration_set_at: '2026-05-20T00:00:00.000Z',
  measurement_count: 4,
}

const DEMO_MEASUREMENTS: TakeoffMeasurement[] = [
  {
    id: 'demo-wall-south',
    project_id: 'demo-project',
    blueprint_document_id: DEMO_BLUEPRINT_ID,
    service_item_code: '09 29 00',
    quantity: '240.00',
    unit: 'sqft',
    notes: 'south wall area',
    elevation: 'south',
    image_thumbnail: null,
    geometry: {
      kind: 'polygon',
      points: [
        { x: 20, y: 24 },
        { x: 76, y: 24 },
        { x: 76, y: 38 },
        { x: 20, y: 38 },
      ],
    },
    version: 1,
    created_at: '2026-05-20T00:00:00.000Z',
  },
  {
    id: 'demo-insulation-east',
    project_id: 'demo-project',
    blueprint_document_id: DEMO_BLUEPRINT_ID,
    service_item_code: '07 21 00',
    quantity: '52.00',
    unit: 'lf',
    notes: null,
    elevation: 'east',
    image_thumbnail: null,
    geometry: {
      kind: 'lineal',
      points: [
        { x: 20, y: 70 },
        { x: 42, y: 76 },
        { x: 66, y: 72 },
        { x: 80, y: 62 },
      ],
    },
    version: 1,
    created_at: '2026-05-20T00:00:00.000Z',
  },
  {
    id: 'demo-windows-north',
    project_id: 'demo-project',
    blueprint_document_id: DEMO_BLUEPRINT_ID,
    service_item_code: '08 50 00',
    quantity: '3.00',
    unit: 'ea',
    notes: null,
    elevation: 'north',
    image_thumbnail: null,
    geometry: {
      kind: 'count',
      points: [
        { x: 30, y: 48 },
        { x: 52, y: 48 },
        { x: 74, y: 48 },
      ],
    },
    version: 1,
    created_at: '2026-05-20T00:00:00.000Z',
  },
  {
    id: 'demo-footing',
    project_id: 'demo-project',
    blueprint_document_id: DEMO_BLUEPRINT_ID,
    service_item_code: '03 30 00',
    quantity: '18.00',
    unit: 'cy',
    notes: null,
    elevation: null,
    image_thumbnail: null,
    geometry: {
      kind: 'volume',
      length: 8,
      width: 6,
      height: 4,
    },
    version: 1,
    created_at: '2026-05-20T00:00:00.000Z',
  },
]

export function TakeoffPreviewDemo() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const scene = useMemo(
    () =>
      buildTakeoffPreviewScene(DEMO_MEASUREMENTS, {
        activeBlueprintId: DEMO_BLUEPRINT_ID,
        activePage: DEMO_PAGE,
      }),
    [],
  )
  const selected = scene.items.find((item) => item.id === selectedId) ?? null

  return (
    <div className="min-h-screen bg-[#0d1117] text-white flex flex-col">
      <header className="shrink-0 border-b border-white/10 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12px] text-white/55">Sitelayer</div>
            <h1 className="mt-1 text-[20px] font-semibold tracking-normal truncate">3D takeoff demo</h1>
          </div>
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
            <div className="text-[12px] font-semibold text-white">Fixture house plan</div>
            <div className="mt-0.5 text-[11px] text-white/55">
              Scale: {scene.worldPerBoardUnit.toFixed(3)} ft / board unit
            </div>
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
        </aside>

        <div className="absolute bottom-3 right-3 rounded border border-white/12 bg-[#0d1117]/75 px-3 py-2 text-[11px] text-white/60 backdrop-blur">
          Drag to rotate · scroll to zoom · click to inspect
        </div>
      </main>
    </div>
  )
}
