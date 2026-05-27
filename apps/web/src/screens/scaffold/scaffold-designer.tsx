import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { generateScaffoldModel, type ScaffoldDesignSpec, type ScaffoldModel } from '@sitelayer/domain'
import { buildScaffoldScene, colorForRole } from '@/lib/scaffold/scaffold-scene'
import { ScaffoldThreeScene } from './scaffold-3d-scene'

const DEFAULT_SPEC: ScaffoldDesignSpec = {
  baysAlongLength: 4,
  baysAlongWidth: 1,
  bayLengthMm: 2500,
  bayWidthMm: 1000,
  liftHeightMm: 2000,
  lifts: 4,
  options: { basePlates: true, guardrails: true, toeboards: false },
}

const MM_PER_FOOT = 304.8
const fmtFt = (mm: number) => `${(mm / MM_PER_FOOT).toFixed(1)} ft`

export function ScaffoldDesignerScreen() {
  const [spec, setSpec] = useState<ScaffoldDesignSpec>(DEFAULT_SPEC)

  const { model, error } = useMemo<{ model: ScaffoldModel | null; error: string | null }>(() => {
    try {
      return { model: generateScaffoldModel(spec), error: null }
    } catch (err) {
      return { model: null, error: err instanceof Error ? err.message : 'Invalid scaffold spec' }
    }
  }, [spec])

  const scene = useMemo(() => (model ? buildScaffoldScene(model) : null), [model])

  const num =
    (key: keyof ScaffoldDesignSpec) =>
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const value = Number(event.target.value)
      setSpec((prev) => ({ ...prev, [key]: value }))
    }
  const toggle =
    (key: 'basePlates' | 'guardrails' | 'toeboards') =>
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      setSpec((prev) => ({ ...prev, options: { ...prev.options, [key]: event.target.checked } }))
    }

  return (
    <div className="min-h-screen bg-[#0d1117] text-white flex flex-col">
      <header className="shrink-0 border-b border-white/10 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/more/inventory/scaffold-catalog" className="text-[12px] text-white/60 hover:text-white">
            ← Scaffold catalog
          </Link>
          <h1 className="mt-1 text-[20px] font-semibold">Scaffold designer</h1>
        </div>
        {model ? (
          <div className="rounded border border-white/15 px-3 py-2 text-[12px] text-white/70">
            <span className="font-mono tabular-nums text-white">{model.members.length}</span> members ·{' '}
            {fmtFt(model.bounds.lengthMm)} × {fmtFt(model.bounds.widthMm)} × {fmtFt(model.bounds.heightMm)}
          </div>
        ) : null}
      </header>

      <div className="flex flex-1 min-h-[560px] flex-col md:flex-row">
        <aside className="md:w-[320px] shrink-0 overflow-y-auto border-b md:border-b-0 md:border-r border-white/10 p-4 space-y-4">
          <section className="grid grid-cols-2 gap-3">
            <NumberField label="Bays (length)" value={spec.baysAlongLength} onChange={num('baysAlongLength')} min={1} />
            <NumberField label="Bays (width)" value={spec.baysAlongWidth} onChange={num('baysAlongWidth')} min={1} />
            <NumberField label="Bay length (mm)" value={spec.bayLengthMm} onChange={num('bayLengthMm')} min={1} />
            <NumberField label="Bay width (mm)" value={spec.bayWidthMm} onChange={num('bayWidthMm')} min={1} />
            <NumberField label="Lift height (mm)" value={spec.liftHeightMm} onChange={num('liftHeightMm')} min={1} />
            <NumberField label="Lifts" value={spec.lifts} onChange={num('lifts')} min={1} />
          </section>
          <section className="space-y-1.5 text-[13px]">
            <Checkbox label="Base plates" checked={spec.options?.basePlates ?? true} onChange={toggle('basePlates')} />
            <Checkbox
              label="Guardrails (top)"
              checked={spec.options?.guardrails ?? true}
              onChange={toggle('guardrails')}
            />
            <Checkbox
              label="Toeboards (top)"
              checked={spec.options?.toeboards ?? false}
              onChange={toggle('toeboards')}
            />
          </section>

          {error ? (
            <div className="rounded border border-[#c75f75]/40 bg-[#c75f75]/10 px-3 py-2 text-[12px] text-[#f0a6b5]">
              {error}
            </div>
          ) : null}

          {model ? (
            <section>
              <div className="text-[11px] uppercase tracking-[0.06em] text-white/45 mb-1.5">Bill of materials</div>
              <ul className="divide-y divide-white/10">
                {model.partDemand.map((line) => (
                  <li key={`${line.role}:${line.lengthMm}`} className="flex items-center gap-2 py-1.5 text-[12px]">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: colorForRole(line.role) }}
                    />
                    <span className="flex-1 capitalize">{line.role.replace('_', ' ')}</span>
                    {line.lengthMm > 0 ? <span className="text-white/45 font-mono">{fmtFt(line.lengthMm)}</span> : null}
                    <span className="font-mono tabular-nums text-white">×{line.quantity}</span>
                  </li>
                ))}
              </ul>
              {model.warnings.map((w) => (
                <div key={w} className="mt-2 text-[11px] text-[#f2c97d]">
                  {w}
                </div>
              ))}
            </section>
          ) : null}
        </aside>

        <main className="relative flex-1 min-h-[420px]">
          {scene ? <ScaffoldThreeScene scene={scene} /> : null}
          <div className="absolute bottom-3 right-3 rounded border border-white/12 bg-[#0d1117]/75 px-3 py-2 text-[11px] text-white/60 backdrop-blur">
            Drag to rotate · scroll to zoom
          </div>
        </main>
      </div>
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  min,
}: {
  label: string
  value: number
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  min: number
}) {
  return (
    <label className="text-[11px] uppercase tracking-[0.06em] text-white/50">
      {label}
      <input
        type="number"
        min={min}
        value={value}
        onChange={onChange}
        className="mt-1 block w-full rounded border border-white/15 bg-[#161b22] px-2 py-1.5 text-[13px] normal-case tracking-normal text-white"
      />
    </label>
  )
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={checked} onChange={onChange} className="accent-[#d9904a]" />
      {label}
    </label>
  )
}
