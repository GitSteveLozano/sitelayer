import { apiDelete, apiPatch, apiPost } from '../api.js'
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

async function fileToBase64(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      resolve(result.includes(',') ? (result.split(',', 2)[1] ?? result) : result)
    }
    reader.readAsDataURL(file)
  })
}

async function readBlueprintUpload(form: FormData) {
  const file = form.get('blueprint_file')
  if (!(file instanceof File) || !file.size) return null
  return {
    file_name: file.name,
    original_file_name: file.name,
    mime_type: file.type || 'application/pdf',
    contents_base64: await fileToBase64(file),
  }
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
            const upload = await readBlueprintUpload(form)
            await apiPost(
              `/api/projects/${selectedProjectId}/blueprints`,
              {
                file_name: String(form.get('file_name') ?? upload?.file_name ?? '').trim(),
                storage_path: String(form.get('storage_path') ?? '').trim(),
                preview_type: String(form.get('preview_type') ?? 'storage_path').trim(),
                calibration_length: Number(form.get('calibration_length') ?? 0) || null,
                calibration_unit: String(form.get('calibration_unit') ?? '').trim() || null,
                sheet_scale: Number(form.get('sheet_scale') ?? 0) || null,
                version: Number(form.get('version') ?? 0) || undefined,
                file_contents_base64: upload?.contents_base64 ?? undefined,
                original_file_name: upload?.original_file_name ?? undefined,
                mime_type: upload?.mime_type ?? undefined,
              },
              companySlug,
            )
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
                  const upload = await readBlueprintUpload(form)
                  await apiPatch(
                    `/api/blueprints/${blueprint.id}`,
                    {
                      file_name: String(form.get('file_name') ?? upload?.file_name ?? '').trim(),
                      storage_path: String(form.get('storage_path') ?? '').trim(),
                      preview_type: String(form.get('preview_type') ?? '').trim(),
                      calibration_length: Number(form.get('calibration_length') ?? 0) || null,
                      calibration_unit: String(form.get('calibration_unit') ?? '').trim() || null,
                      sheet_scale: Number(form.get('sheet_scale') ?? 0) || null,
                      expected_version: Number(form.get('expected_version') ?? 0) || undefined,
                      file_contents_base64: upload?.contents_base64 ?? undefined,
                      original_file_name: upload?.original_file_name ?? undefined,
                      mime_type: upload?.mime_type ?? undefined,
                    },
                    companySlug,
                  )
                  await refreshTakeoff(selectedProjectId)
                })
              }
              onCreateVersion={(form) =>
                runAction(`blueprint-version:${blueprint.id}`, async () => {
                  const upload = await readBlueprintUpload(form)
                  const response = await apiPost<BlueprintRow>(
                    `/api/blueprints/${blueprint.id}/versions`,
                    {
                      file_name: String(form.get('file_name') ?? upload?.file_name ?? blueprint.file_name).trim(),
                      storage_path: String(form.get('storage_path') ?? '').trim(),
                      preview_type: String(form.get('preview_type') ?? blueprint.preview_type).trim(),
                      calibration_length:
                        Number(form.get('calibration_length') ?? 0) || blueprint.calibration_length || null,
                      calibration_unit:
                        String(form.get('calibration_unit') ?? '').trim() || blueprint.calibration_unit || null,
                      sheet_scale: Number(form.get('sheet_scale') ?? 0) || blueprint.sheet_scale || null,
                      copy_measurements: form.get('copy_measurements') !== 'off',
                      file_contents_base64: upload?.contents_base64 ?? undefined,
                      original_file_name: upload?.original_file_name ?? undefined,
                      mime_type: upload?.mime_type ?? undefined,
                    },
                    companySlug,
                  )
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
