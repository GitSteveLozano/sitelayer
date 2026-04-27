import { apiDelete, apiPatch, apiPost, apiUploadBlueprint } from '../api.js'
import type { BlueprintRow } from '../api.js'
import { BlueprintEditor, getBlueprintLineageLabel } from '../components/operations.js'
import { FormRow } from '../components/forms.js'
import { Input } from '../components/ui/input.js'
import type { RunAction } from './types.js'

type BlueprintDocumentsViewProps = {
  selectedProjectId: string
  companySlug: string
  busy: string | null
  blueprints: BlueprintRow[]
  setSelectedBlueprintId: (blueprintId: string) => void
  refreshTakeoff: (projectId: string) => Promise<void>
  runAction: RunAction
}

function pickBlueprintFile(form: FormData): File | null {
  const file = form.get('blueprint_file')
  return file instanceof File && file.size > 0 ? file : null
}

/**
 * Build a multipart payload for blueprint create/version/patch endpoints.
 * The API expects the binary as the `blueprint_file` part and all other
 * metadata as plain text fields with the same names as the JSON path.
 */
function buildBlueprintFormData(
  file: File,
  fields: Record<string, string | number | boolean | null | undefined>,
): FormData {
  const data = new FormData()
  data.append('blueprint_file', file, file.name)
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    data.append(name, String(value))
  }
  return data
}

export function BlueprintDocumentsView({
  selectedProjectId,
  companySlug,
  busy,
  blueprints,
  setSelectedBlueprintId,
  refreshTakeoff,
  runAction,
}: BlueprintDocumentsViewProps) {
  return (
    <article className="panel">
      <h2>Blueprint Documents</h2>
      <FormRow
        actionLabel="Add blueprint"
        busy={busy === 'blueprint'}
        onSubmit={(form) =>
          runAction('blueprint', async () => {
            if (!selectedProjectId) throw new Error('select a project first')
            const file = pickBlueprintFile(form)
            const fields = {
              file_name: String(form.get('file_name') ?? file?.name ?? '').trim(),
              storage_path: String(form.get('storage_path') ?? '').trim(),
              preview_type: String(form.get('preview_type') ?? 'storage_path').trim(),
              calibration_length: Number(form.get('calibration_length') ?? 0) || null,
              calibration_unit: String(form.get('calibration_unit') ?? '').trim() || null,
              sheet_scale: Number(form.get('sheet_scale') ?? 0) || null,
              version: Number(form.get('version') ?? 0) || undefined,
              original_file_name: file?.name,
              mime_type: file?.type || undefined,
            }
            const path = `/api/projects/${selectedProjectId}/blueprints`
            if (file) {
              await apiUploadBlueprint('POST', path, buildBlueprintFormData(file, fields), companySlug)
            } else {
              await apiPost(path, fields, companySlug)
            }
            await refreshTakeoff(selectedProjectId)
          })
        }
      >
        <Input name="file_name" placeholder="Blueprint file name" />
        <Input name="blueprint_file" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/*" />
        <Input name="storage_path" placeholder="storage/path.pdf" />
        <Input name="preview_type" placeholder="Preview type" defaultValue="storage_path" />
        <Input name="calibration_length" placeholder="Calibration length" type="number" step="0.01" />
        <Input name="calibration_unit" placeholder="Calibration unit" />
        <Input name="sheet_scale" placeholder="Sheet scale" type="number" step="0.0001" />
        <Input name="version" placeholder="Version" type="number" step="1" defaultValue="1" />
      </FormRow>
      <ul className="list compact">
        {blueprints.map((blueprint) => (
          <li key={blueprint.id}>
            <BlueprintEditor
              blueprint={blueprint}
              lineage={getBlueprintLineageLabel(blueprints, blueprint.id)}
              busy={busy === `blueprint:${blueprint.id}`}
              onSubmit={(form) =>
                runAction(`blueprint:${blueprint.id}`, async () => {
                  const file = pickBlueprintFile(form)
                  const fields = {
                    file_name: String(form.get('file_name') ?? file?.name ?? '').trim(),
                    storage_path: String(form.get('storage_path') ?? '').trim(),
                    preview_type: String(form.get('preview_type') ?? '').trim(),
                    calibration_length: Number(form.get('calibration_length') ?? 0) || null,
                    calibration_unit: String(form.get('calibration_unit') ?? '').trim() || null,
                    sheet_scale: Number(form.get('sheet_scale') ?? 0) || null,
                    expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                    original_file_name: file?.name,
                    mime_type: file?.type || undefined,
                  }
                  const path = `/api/blueprints/${blueprint.id}`
                  if (file) {
                    await apiUploadBlueprint('PATCH', path, buildBlueprintFormData(file, fields), companySlug)
                  } else {
                    await apiPatch(path, fields, companySlug)
                  }
                  await refreshTakeoff(selectedProjectId)
                })
              }
              onCreateVersion={(form) =>
                runAction(`blueprint-version:${blueprint.id}`, async () => {
                  const file = pickBlueprintFile(form)
                  const fields = {
                    file_name: String(form.get('file_name') ?? file?.name ?? blueprint.file_name).trim(),
                    storage_path: String(form.get('storage_path') ?? '').trim(),
                    preview_type: String(form.get('preview_type') ?? blueprint.preview_type).trim(),
                    calibration_length:
                      Number(form.get('calibration_length') ?? 0) || blueprint.calibration_length || null,
                    calibration_unit:
                      String(form.get('calibration_unit') ?? '').trim() || blueprint.calibration_unit || null,
                    sheet_scale: Number(form.get('sheet_scale') ?? 0) || blueprint.sheet_scale || null,
                    copy_measurements: form.get('copy_measurements') !== 'off',
                    original_file_name: file?.name,
                    mime_type: file?.type || undefined,
                  }
                  const path = `/api/blueprints/${blueprint.id}/versions`
                  const response = file
                    ? await apiUploadBlueprint<BlueprintRow>(
                        'POST',
                        path,
                        buildBlueprintFormData(file, fields),
                        companySlug,
                      )
                    : await apiPost<BlueprintRow>(path, fields, companySlug)
                  await refreshTakeoff(selectedProjectId)
                  setSelectedBlueprintId(response.id)
                })
              }
              onDelete={() =>
                runAction(`blueprint:${blueprint.id}`, async () => {
                  await apiDelete(`/api/blueprints/${blueprint.id}`, companySlug, {
                    expected_version: blueprint.version,
                  })
                  await refreshTakeoff(selectedProjectId)
                })
              }
            />
          </li>
        ))}
      </ul>
    </article>
  )
}
