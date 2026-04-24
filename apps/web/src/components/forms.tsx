import type { ReactNode } from 'react'
import { Button } from './ui/button.js'

export type MeasurementDraftRow = {
  service_item_code: string
  quantity: number
  unit: string
  notes: string | null
}

export function FormRow({
  children,
  onSubmit,
  actionLabel,
  busy,
}: {
  children: ReactNode
  onSubmit: (formData: FormData) => Promise<void>
  actionLabel: string
  busy: boolean
}) {
  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault()
        void onSubmit(new FormData(event.currentTarget))
      }}
    >
      <div className="formGrid">{children}</div>
      <Button type="submit" disabled={busy}>
        {busy ? 'Working...' : actionLabel}
      </Button>
    </form>
  )
}

export function parseMeasurementRows(form: FormData): MeasurementDraftRow[] {
  const raw = String(form.get('measurements') ?? '')
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serviceItemCode = '', quantity = '0', unit = '', ...rest] = line.split(',').map((value) => value.trim())
      return {
        service_item_code: serviceItemCode,
        quantity: Number(quantity),
        unit,
        notes: rest.join(',').trim() || null,
      }
    })
}
