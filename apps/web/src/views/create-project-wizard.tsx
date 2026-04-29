import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiPost, apiUploadBlueprint } from '../api.js'
import type { BlueprintRow, BootstrapResponse } from '../api.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Select } from '../components/ui/select.js'
import { toastError, toastSuccess } from '../components/ui/toast.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../components/ui/dialog.js'

/**
 * 3-step Create Project wizard.
 *
 * Closes Steve's "Create-then-upload wizard: Details → Blueprint upload
 * → Summary" claim from the README. Reuses POST /api/projects and
 * apiUploadBlueprint — no new endpoints. The project is created at the
 * end of step 1 so a partial wizard doesn't lose the user's typing.
 *
 * Skipping the blueprint step is allowed (the office often creates a
 * project before the blueprint is back from the GC).
 */

type WizardStep = 'details' | 'blueprint' | 'summary'

type Props = {
  companySlug: string
  divisions: BootstrapResponse['divisions']
  primaryDivision: string
  onCreated: () => Promise<void> | void
}

type DetailsForm = {
  name: string
  customer_name: string
  division_code: string
  bid_total: string
  labor_rate: string
  target_sqft_per_hr: string
  bonus_pool: string
  site_lat: string
  site_lng: string
  site_radius_m: string
}

function emptyDetails(primaryDivision: string): DetailsForm {
  return {
    name: '',
    customer_name: '',
    division_code: primaryDivision,
    bid_total: '',
    labor_rate: '38',
    target_sqft_per_hr: '',
    bonus_pool: '',
    site_lat: '',
    site_lng: '',
    site_radius_m: '100',
  }
}

export function CreateProjectWizard({ companySlug, divisions, primaryDivision, onCreated }: Props) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<WizardStep>('details')
  const [details, setDetails] = useState<DetailsForm>(() => emptyDetails(primaryDivision))
  const [busy, setBusy] = useState(false)
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null)
  const [createdProjectName, setCreatedProjectName] = useState<string | null>(null)
  const [blueprint, setBlueprint] = useState<BlueprintRow | null>(null)

  function reset() {
    setStep('details')
    setDetails(emptyDetails(primaryDivision))
    setCreatedProjectId(null)
    setCreatedProjectName(null)
    setBlueprint(null)
  }

  function close() {
    setOpen(false)
    setTimeout(reset, 300)
  }

  async function handleDetailsNext() {
    if (!details.name.trim() || !details.customer_name.trim()) {
      toastError('Missing fields', 'Project name and customer are required.')
      return
    }
    setBusy(true)
    try {
      const result = await apiPost<{ id: string; name: string }>(
        '/api/projects',
        {
          name: details.name.trim(),
          customer_name: details.customer_name.trim(),
          division_code: details.division_code || primaryDivision,
          status: 'lead',
          bid_total: Number(details.bid_total) || 0,
          labor_rate: Number(details.labor_rate) || 38,
          target_sqft_per_hr: Number(details.target_sqft_per_hr) || null,
          bonus_pool: Number(details.bonus_pool) || 0,
          site_lat: details.site_lat ? Number(details.site_lat) : null,
          site_lng: details.site_lng ? Number(details.site_lng) : null,
          site_radius_m: details.site_radius_m ? Number(details.site_radius_m) : 100,
        },
        companySlug,
      )
      setCreatedProjectId(result.id)
      setCreatedProjectName(result.name)
      toastSuccess(`Project "${result.name}" created`)
      setStep('blueprint')
      await onCreated()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'create failed'
      toastError('Failed to create project', message)
    } finally {
      setBusy(false)
    }
  }

  async function handleBlueprintUpload(file: File) {
    if (!createdProjectId) return
    setBusy(true)
    try {
      const formData = new FormData()
      formData.append('blueprint_file', file)
      formData.append('file_name', file.name)
      const result = await apiUploadBlueprint<{ blueprint: BlueprintRow }>(
        'POST',
        `/api/projects/${createdProjectId}/blueprints`,
        formData,
        companySlug,
      )
      setBlueprint(result.blueprint)
      toastSuccess('Blueprint uploaded')
      setStep('summary')
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'upload failed'
      toastError('Blueprint upload failed', message)
    } finally {
      setBusy(false)
    }
  }

  function handleSkipBlueprint() {
    setStep('summary')
  }

  function handleOpenProject() {
    if (createdProjectId) navigate(`/projects/${createdProjectId}`)
    close()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        <Button variant="default">New project (wizard)</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>
            Step {step === 'details' ? 1 : step === 'blueprint' ? 2 : 3} of 3 ·{' '}
            {step === 'details' && 'Project details'}
            {step === 'blueprint' && 'Upload blueprint (optional)'}
            {step === 'summary' && 'Review and finish'}
          </DialogDescription>
        </DialogHeader>

        {step === 'details' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Project name *</span>
              <Input value={details.name} onChange={(e) => setDetails({ ...details, name: e.target.value })} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Customer / builder *</span>
              <Input
                value={details.customer_name}
                onChange={(e) => setDetails({ ...details, customer_name: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Division</span>
              <Select
                value={details.division_code}
                onChange={(e) => setDetails({ ...details, division_code: e.target.value })}
              >
                {divisions.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.code} — {d.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Bid total ($)</span>
              <Input
                type="number"
                step="0.01"
                value={details.bid_total}
                onChange={(e) => setDetails({ ...details, bid_total: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Labor rate ($/hr)</span>
              <Input
                type="number"
                step="0.01"
                value={details.labor_rate}
                onChange={(e) => setDetails({ ...details, labor_rate: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Target sqft/hr</span>
              <Input
                type="number"
                step="0.01"
                value={details.target_sqft_per_hr}
                onChange={(e) => setDetails({ ...details, target_sqft_per_hr: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Bonus pool ($)</span>
              <Input
                type="number"
                step="0.01"
                value={details.bonus_pool}
                onChange={(e) => setDetails({ ...details, bonus_pool: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Geofence radius (m)</span>
              <Input
                type="number"
                step="1"
                value={details.site_radius_m}
                onChange={(e) => setDetails({ ...details, site_radius_m: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Site latitude</span>
              <Input
                type="number"
                step="0.000001"
                value={details.site_lat}
                onChange={(e) => setDetails({ ...details, site_lat: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-700">Site longitude</span>
              <Input
                type="number"
                step="0.000001"
                value={details.site_lng}
                onChange={(e) => setDetails({ ...details, site_lng: e.target.value })}
              />
            </label>
          </div>
        )}

        {step === 'blueprint' && createdProjectId && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Project <strong>{createdProjectName}</strong> created. Optionally upload a blueprint now to start
              measuring on the next step. You can also skip and add it later from the project page.
            </p>
            <Input
              type="file"
              accept="application/pdf,image/*"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleBlueprintUpload(file)
              }}
              disabled={busy}
            />
            {busy && <p className="text-xs text-slate-500">Uploading…</p>}
          </div>
        )}

        {step === 'summary' && (
          <div className="space-y-3 text-sm">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="font-semibold">{createdProjectName}</h3>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <dt className="text-slate-500">Customer</dt>
                <dd>{details.customer_name}</dd>
                <dt className="text-slate-500">Division</dt>
                <dd>{details.division_code}</dd>
                <dt className="text-slate-500">Bid</dt>
                <dd>${details.bid_total || 0}</dd>
                <dt className="text-slate-500">Blueprint</dt>
                <dd>{blueprint ? blueprint.file_name : 'Not uploaded'}</dd>
              </dl>
            </div>
            <p className="text-sm text-slate-600">
              Ready to start measuring? Open the project to view the dashboard, manage rentals, and (if you uploaded a
              blueprint) start takeoff.
            </p>
          </div>
        )}

        <DialogFooter>
          {step === 'details' && (
            <>
              <Button variant="outline" type="button" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button variant="default" type="button" onClick={handleDetailsNext} disabled={busy}>
                {busy ? 'Creating…' : 'Create & continue'}
              </Button>
            </>
          )}
          {step === 'blueprint' && (
            <>
              <Button variant="outline" type="button" onClick={handleSkipBlueprint} disabled={busy}>
                Skip blueprint
              </Button>
              <Button variant="default" type="button" disabled>
                {blueprint ? 'Uploaded' : 'Pick a file…'}
              </Button>
            </>
          )}
          {step === 'summary' && (
            <>
              <Button variant="outline" type="button" onClick={close}>
                Close
              </Button>
              <Button variant="default" type="button" onClick={handleOpenProject}>
                Open project
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
