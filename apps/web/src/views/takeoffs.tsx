import { apiDelete, apiPatch, apiPost } from '../api.js'
import type {
  BlueprintRow,
  BootstrapResponse,
  MaterialBillRow,
  MeasurementRow,
  ProjectSummary,
  ScheduleRow,
  WorkerRow,
} from '../api.js'
import { LaborEditor, MaterialBillEditor, MeasurementEditor, TakeoffWorkspace } from '../components/operations.js'
import { TakeoffPanOverlay } from '../components/takeoff-pan-overlay.js'
import { FormRow, parseMeasurementRows } from '../components/forms.js'
import { Input } from '../components/ui/input.js'
import { Select } from '../components/ui/select.js'
import { Textarea } from '../components/ui/textarea.js'
import { BlueprintDocumentsView } from './blueprints.js'
import type { RunAction } from './types.js'

type TakeoffsViewProps = {
  bootstrap: BootstrapResponse | null
  selectedProjectId: string
  selectedBlueprintId: string
  companySlug: string
  busy: string | null
  blueprints: BlueprintRow[]
  measurements: MeasurementRow[]
  schedules: ScheduleRow[]
  materialBills: MaterialBillRow[]
  workers: WorkerRow[]
  measurableServiceItems: BootstrapResponse['serviceItems']
  summary: ProjectSummary | null
  setSelectedProjectId: (projectId: string) => void
  setSelectedBlueprintId: (blueprintId: string) => void
  refreshTakeoff: (projectId: string) => Promise<void>
  runAction: RunAction
}

export function TakeoffsView({
  bootstrap,
  selectedProjectId,
  selectedBlueprintId,
  companySlug,
  busy,
  blueprints,
  measurements,
  schedules,
  materialBills,
  workers,
  measurableServiceItems,
  summary,
  setSelectedProjectId,
  setSelectedBlueprintId,
  refreshTakeoff,
  runAction,
}: TakeoffsViewProps) {
  return (
    <>
      <section className="panel">
        <h2>Project Selection</h2>
        <div className="toolbar">
          <label className="selectWrap">
            <span>Selected project</span>
            <Select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>
              <option value="">Choose a project</option>
              {bootstrap?.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} · {project.customer_name} · {project.division_code} · {project.status}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </section>

      <section className="panel">
        <h2>Takeoff Workspace</h2>
        {selectedProjectId ? (
          <>
            <TakeoffPanOverlay />
            <TakeoffWorkspace
              projectId={selectedProjectId}
              companySlug={companySlug}
              blueprints={blueprints}
              measurements={measurements}
              serviceItems={measurableServiceItems}
              selectedBlueprintId={selectedBlueprintId}
              onSelectBlueprint={setSelectedBlueprintId}
              onSaved={() => void refreshTakeoff(selectedProjectId)}
            />
          </>
        ) : (
          <p className="muted">Pick a project to open the takeoff board.</p>
        )}
      </section>

      <section className="grid">
        <BlueprintDocumentsView
          selectedProjectId={selectedProjectId}
          companySlug={companySlug}
          busy={busy}
          blueprints={blueprints}
          setSelectedBlueprintId={setSelectedBlueprintId}
          refreshTakeoff={refreshTakeoff}
          runAction={runAction}
        />

        <article className="panel">
          <h2>Takeoff Measurements</h2>
          <FormRow
            actionLabel="Save takeoff"
            busy={busy === 'takeoff'}
            onSubmit={(form) =>
              runAction('takeoff', async () => {
                if (!selectedProjectId) throw new Error('select a project first')
                const measurementRows = parseMeasurementRows(form)
                await apiPost(
                  `/api/projects/${selectedProjectId}/takeoff/measurements`,
                  {
                    measurements: measurementRows,
                    expected_version: summary?.project.version ?? undefined,
                  },
                  companySlug,
                )
                await refreshTakeoff(selectedProjectId)
              })
            }
          >
            <Textarea
              name="measurements"
              placeholder={`One per line: service_item_code, quantity, unit, notes\nEPS, 1250, sqft, front elevation`}
              rows={7}
            />
            <small>Use measurable items only. Example: EPS, 1250, sqft, front elevation</small>
          </FormRow>
          <ul className="list compact">
            {measurements.map((measurement) => (
              <li key={measurement.id}>
                <MeasurementEditor
                  measurement={measurement}
                  busy={busy === `measurement:${measurement.id}`}
                  serviceItems={measurableServiceItems}
                  onSubmit={(form) =>
                    runAction(`measurement:${measurement.id}`, async () => {
                      await apiPatch(
                        `/api/takeoff/measurements/${measurement.id}`,
                        {
                          service_item_code: String(form.get('service_item_code') ?? '').trim(),
                          quantity: Number(form.get('quantity') ?? 0),
                          unit: String(form.get('unit') ?? '').trim(),
                          notes: String(form.get('notes') ?? '').trim() || null,
                          expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                        },
                        companySlug,
                      )
                      await refreshTakeoff(selectedProjectId)
                    })
                  }
                  onDelete={() =>
                    runAction(`measurement:${measurement.id}`, async () => {
                      await apiDelete(`/api/takeoff/measurements/${measurement.id}`, companySlug, {
                        expected_version: measurement.version,
                      })
                      await refreshTakeoff(selectedProjectId)
                    })
                  }
                />
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>Time Capture</h2>
          <FormRow
            actionLabel="Add labor"
            busy={busy === 'labor'}
            onSubmit={(form) =>
              runAction('labor', async () => {
                if (!selectedProjectId) throw new Error('select a project first')
                await apiPost(
                  '/api/labor-entries',
                  {
                    project_id: selectedProjectId,
                    worker_id: String(form.get('worker_id') ?? '').trim() || null,
                    service_item_code: String(form.get('service_item_code') ?? '').trim(),
                    hours: Number(form.get('hours') ?? 0),
                    sqft_done: Number(form.get('sqft_done') ?? 0),
                    occurred_on: String(form.get('occurred_on') ?? ''),
                    status: 'confirmed',
                    expected_version: summary?.project.version ?? undefined,
                  },
                  companySlug,
                )
              })
            }
          >
            <Select name="worker_id" defaultValue="">
              <option value="">Choose worker</option>
              {workers.map((worker) => (
                <option key={worker.id} value={worker.id}>
                  {worker.name}
                </option>
              ))}
            </Select>
            <Select name="service_item_code" defaultValue="">
              <option value="">Service item</option>
              {measurableServiceItems.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.code} - {item.name}
                </option>
              ))}
            </Select>
            <Input name="hours" placeholder="Hours" type="number" step="0.25" defaultValue="8" />
            <Input name="sqft_done" placeholder="Sqft done" type="number" step="0.1" defaultValue="0" />
            <Input name="occurred_on" placeholder="2026-04-23" defaultValue={new Date().toISOString().slice(0, 10)} />
          </FormRow>
        </article>

        <article className="panel">
          <h2>Material Bills</h2>
          <FormRow
            actionLabel="Add bill"
            busy={busy === 'material-bill'}
            onSubmit={(form) =>
              runAction('material-bill', async () => {
                if (!selectedProjectId) throw new Error('select a project first')
                await apiPost(
                  `/api/projects/${selectedProjectId}/material-bills`,
                  {
                    vendor: String(form.get('vendor') ?? '').trim(),
                    amount: Number(form.get('amount') ?? 0),
                    bill_type: String(form.get('bill_type') ?? 'material').trim() || 'material',
                    description: String(form.get('description') ?? '').trim() || null,
                    occurred_on: String(form.get('occurred_on') ?? '').trim() || null,
                    expected_version: summary?.project.version ?? undefined,
                  },
                  companySlug,
                )
                await refreshTakeoff(selectedProjectId)
              })
            }
          >
            <Input name="vendor" placeholder="Vendor" />
            <Input name="amount" placeholder="Amount" type="number" step="0.01" />
            <Input name="bill_type" placeholder="Type" defaultValue="material" />
            <Input name="description" placeholder="Description" />
            <Input name="occurred_on" placeholder="2026-04-23" defaultValue={new Date().toISOString().slice(0, 10)} />
          </FormRow>
          <ul className="list compact">
            {materialBills.map((bill) => (
              <li key={bill.id}>
                <MaterialBillEditor
                  bill={bill}
                  busy={busy === `material-bill:${bill.id}`}
                  onSubmit={(form) =>
                    runAction(`material-bill:${bill.id}`, async () => {
                      await apiPatch(
                        `/api/material-bills/${bill.id}`,
                        {
                          vendor: String(form.get('vendor') ?? '').trim(),
                          amount: Number(form.get('amount') ?? 0),
                          bill_type: String(form.get('bill_type') ?? '').trim(),
                          description: String(form.get('description') ?? '').trim() || null,
                          occurred_on: String(form.get('occurred_on') ?? '').trim() || null,
                          expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                        },
                        companySlug,
                      )
                      await refreshTakeoff(selectedProjectId)
                    })
                  }
                  onDelete={() =>
                    runAction(`material-bill:${bill.id}`, async () => {
                      await apiDelete(`/api/material-bills/${bill.id}`, companySlug, { expected_version: bill.version })
                      await refreshTakeoff(selectedProjectId)
                    })
                  }
                />
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>Daily Confirm</h2>
          <FormRow
            actionLabel="Confirm day"
            busy={busy === 'confirm-day'}
            onSubmit={(form) =>
              runAction('confirm-day', async () => {
                if (!selectedProjectId) throw new Error('select a project first')
                const scheduleId = String(form.get('schedule_id') ?? '').trim()
                if (!scheduleId) throw new Error('schedule is required')
                const scheduleVersion = schedules.find((schedule) => schedule.id === scheduleId)?.version
                const entries = parseMeasurementRows(form).map((row) => ({
                  worker_id: String(form.get('worker_id') ?? '').trim() || null,
                  service_item_code: row.service_item_code,
                  hours: row.quantity,
                  sqft_done: row.quantity,
                  occurred_on: String(form.get('occurred_on') ?? ''),
                }))
                await apiPost(
                  `/api/schedules/${scheduleId}/confirm`,
                  { entries, expected_version: scheduleVersion ?? undefined },
                  companySlug,
                )
                await refreshTakeoff(selectedProjectId)
              })
            }
          >
            <Select name="schedule_id" defaultValue="">
              <option value="">Choose schedule</option>
              {schedules.map((schedule) => (
                <option key={schedule.id} value={schedule.id}>
                  {schedule.scheduled_for} · {schedule.status}
                </option>
              ))}
            </Select>
            <Select name="worker_id" defaultValue="">
              <option value="">Worker for all entries</option>
              {workers.map((worker) => (
                <option key={worker.id} value={worker.id}>
                  {worker.name}
                </option>
              ))}
            </Select>
            <Input name="occurred_on" defaultValue={new Date().toISOString().slice(0, 10)} />
            <Textarea
              name="measurements"
              placeholder={`service_item_code, quantity, unit, notes\nEPS, 8, hr, daily confirm shorthand`}
              rows={5}
            />
            <small>Use the same shorthand parser as takeoff to create confirmed labor entries.</small>
          </FormRow>
        </article>
      </section>

      <section className="panel">
        <h2>Schedule</h2>
        <FormRow
          actionLabel="Add schedule"
          busy={busy === 'schedule'}
          onSubmit={(form) =>
            runAction('schedule', async () => {
              if (!selectedProjectId) throw new Error('select a project first')
              const crewInput = String(form.get('crew') ?? '')
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean)

              await apiPost(
                '/api/schedules',
                {
                  project_id: selectedProjectId,
                  scheduled_for: String(form.get('scheduled_for') ?? ''),
                  crew: crewInput,
                  status: 'draft',
                },
                companySlug,
              )
              await refreshTakeoff(selectedProjectId)
            })
          }
        >
          <Input name="scheduled_for" defaultValue={new Date().toISOString().slice(0, 10)} />
          <Input name="crew" placeholder="Crew names, comma separated" />
        </FormRow>
      </section>

      <section className="panel">
        <h2>Labor Entries</h2>
        <ul className="list compact">
          {(bootstrap?.laborEntries ?? [])
            .filter((entry) => !selectedProjectId || entry.project_id === selectedProjectId)
            .map((entry) => (
              <li key={entry.id}>
                <LaborEditor
                  laborEntry={entry}
                  workers={workers}
                  serviceItems={measurableServiceItems}
                  busy={busy === `labor-entry:${entry.id}`}
                  onSubmit={(form) =>
                    runAction(`labor-entry:${entry.id}`, async () => {
                      await apiPatch(
                        `/api/labor-entries/${entry.id}`,
                        {
                          worker_id: String(form.get('worker_id') ?? '').trim() || null,
                          service_item_code: String(form.get('service_item_code') ?? '').trim(),
                          hours: Number(form.get('hours') ?? 0),
                          sqft_done: Number(form.get('sqft_done') ?? 0),
                          status: String(form.get('status') ?? '').trim(),
                          occurred_on: String(form.get('occurred_on') ?? '').trim(),
                          expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                        },
                        companySlug,
                      )
                    })
                  }
                  onDelete={() =>
                    runAction(`labor-entry:${entry.id}`, async () => {
                      await apiDelete(`/api/labor-entries/${entry.id}`, companySlug, {
                        expected_version: entry.version,
                      })
                    })
                  }
                />
              </li>
            ))}
        </ul>
      </section>
    </>
  )
}
