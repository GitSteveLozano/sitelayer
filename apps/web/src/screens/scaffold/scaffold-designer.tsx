import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { generateScaffoldModel, type ScaffoldDesignSpec, type ScaffoldModel } from '@sitelayer/domain'
import { Card, Banner, MobileButton } from '@/components/mobile'
import { useProjects } from '@/lib/api/projects'
import { useScaffoldSystems, useCreateScaffoldDesignBom } from '@/lib/api/scaffold-ops'
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
      setSpec((prev) => ({ ...prev, [key]: Number(event.target.value) }))
    }
  const toggle =
    (key: 'basePlates' | 'guardrails' | 'toeboards') =>
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      setSpec((prev) => ({ ...prev, options: { ...prev.options, [key]: event.target.checked } }))
    }

  return (
    <div className="px-5 pt-6 pb-12 max-w-3xl">
      <Link to="/more/inventory/scaffold-catalog" className="text-[12px] text-ink-3">
        ← Scaffold catalog
      </Link>
      <h1 className="mt-2 font-display text-[26px] font-bold tracking-tight leading-tight">Scaffold designer</h1>
      <p className="text-[12px] text-ink-3 mt-1">
        {model
          ? `${model.members.length} members · ${fmtFt(model.bounds.lengthMm)} × ${fmtFt(model.bounds.widthMm)} × ${fmtFt(model.bounds.heightMm)}`
          : 'Set the bay grid and lifts to generate a scaffold + its bill of materials.'}
      </p>

      <div className="mt-5 space-y-4">
        <Card>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <NumberField label="Bays (length)" value={spec.baysAlongLength} onChange={num('baysAlongLength')} />
            <NumberField label="Bays (width)" value={spec.baysAlongWidth} onChange={num('baysAlongWidth')} />
            <NumberField label="Bay length (mm)" value={spec.bayLengthMm} onChange={num('bayLengthMm')} />
            <NumberField label="Bay width (mm)" value={spec.bayWidthMm} onChange={num('bayWidthMm')} />
            <NumberField label="Lift height (mm)" value={spec.liftHeightMm} onChange={num('liftHeightMm')} />
            <NumberField label="Lifts" value={spec.lifts} onChange={num('lifts')} />
          </div>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
            <Checkbox label="Base plates" checked={spec.options?.basePlates ?? true} onChange={toggle('basePlates')} />
            <Checkbox label="Guardrails" checked={spec.options?.guardrails ?? true} onChange={toggle('guardrails')} />
            <Checkbox label="Toeboards" checked={spec.options?.toeboards ?? false} onChange={toggle('toeboards')} />
          </div>
        </Card>

        {error ? <Banner tone="error" title={error} /> : null}

        {scene ? (
          <div className="relative h-[440px] overflow-hidden rounded-xl border border-line bg-[#0d1117]">
            <ScaffoldThreeScene scene={scene} />
            <div className="absolute bottom-2 right-2 rounded-md bg-black/45 px-2 py-1 text-[11px] text-white/70">
              Drag to rotate · scroll to zoom
            </div>
          </div>
        ) : null}

        {model ? (
          <Card>
            <div className="text-[11px] uppercase tracking-[0.06em] text-ink-3 mb-2">Bill of materials</div>
            <ul className="divide-y divide-line">
              {model.partDemand.map((line) => (
                <li key={`${line.role}:${line.lengthMm}`} className="flex items-center gap-2.5 py-2 text-[13px]">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: colorForRole(line.role) }}
                  />
                  <span className="flex-1 capitalize">{line.role.replace('_', ' ')}</span>
                  {line.lengthMm > 0 ? <span className="text-ink-3 num">{fmtFt(line.lengthMm)}</span> : null}
                  <span className="num font-semibold tabular-nums">×{line.quantity}</span>
                </li>
              ))}
            </ul>
            {model.warnings.map((w) => (
              <p key={w} className="mt-2 text-[12px] text-warn">
                {w}
              </p>
            ))}
          </Card>
        ) : null}

        {model ? <SaveBomPanel spec={spec} /> : null}
      </div>
    </div>
  )
}

function SaveBomPanel({ spec }: { spec: ScaffoldDesignSpec }) {
  const projects = useProjects()
  const systems = useScaffoldSystems()
  const [projectId, setProjectId] = useState('')
  const [systemId, setSystemId] = useState('')
  const [name, setName] = useState('Scaffold design')
  const save = useCreateScaffoldDesignBom(projectId)

  const projectRows = projects.data?.projects ?? []
  const systemRows = systems.data?.systems ?? []
  const selectCls =
    'mt-1 w-full text-[15px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent'
  const unresolvedRoles = save.data ? [...new Set(save.data.unresolved.map((u) => u.role))] : []

  return (
    <Card>
      <div className="text-[11px] uppercase tracking-[0.06em] text-ink-3 mb-2">Save as BOM</div>
      <div className="space-y-3">
        <label className="block">
          <span className="text-[12px] text-ink-3">Project</span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={selectCls}>
            <option value="">Select a project…</option>
            {projectRows.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[12px] text-ink-3">Scaffold system (optional)</span>
          <select value={systemId} onChange={(e) => setSystemId(e.target.value)} className={selectCls}>
            <option value="">Any system</option>
            {systemRows.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[12px] text-ink-3">BOM name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full text-[15px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent"
          />
        </label>
        <MobileButton
          variant="primary"
          disabled={!projectId || save.isPending}
          onClick={() =>
            save.mutate({
              name,
              scaffold_system_id: systemId || null,
              spec: spec as unknown as Record<string, unknown>,
            })
          }
        >
          {save.isPending ? 'Saving…' : 'Save as BOM'}
        </MobileButton>

        {save.isError ? <Banner tone="error" title={save.error.message} /> : null}
        {save.data ? (
          <div className="rounded-lg border border-line p-3 text-[12px]">
            <div className="font-semibold">
              Saved “{save.data.bom.name}” — {save.data.bom.total_lines} line(s)
            </div>
            {unresolvedRoles.length ? (
              <div className="mt-1 text-warn">
                {unresolvedRoles.length} role(s) had no catalog part: {unresolvedRoles.join(', ')}. Add catalog parts
                (with <span className="font-mono">attrs.role</span>) for those.
              </div>
            ) : (
              <div className="mt-1 text-good">All demand resolved to catalog parts.</div>
            )}
            <Link to={`/projects/${projectId}/boms`} className="mt-2 inline-block font-medium text-accent">
              View project BOMs →
            </Link>
          </div>
        ) : null}
      </div>
    </Card>
  )
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <label className="block">
      <span className="text-[12px] text-ink-3">{label}</span>
      <input
        type="number"
        min={1}
        value={value}
        onChange={onChange}
        className="mt-1 w-full text-[15px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent"
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
      <input type="checkbox" checked={checked} onChange={onChange} className="accent-accent" />
      {label}
    </label>
  )
}
