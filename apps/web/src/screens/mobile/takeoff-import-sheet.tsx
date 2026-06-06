/**
 * `TakeoffImportSheet` — bulk-load measurements from a CSV/TSV export.
 *
 * The estimator's existing tool (Bluebeam / PlanSwift / OST) already produces
 * a quantity table. Rather than hand-key every line into the takeoff screen,
 * they drop the exported file (or paste the rows) here. We parse + preview in
 * the browser, then POST the cleaned rows to
 * `POST /api/projects/:id/takeoff/import` against the active draft's page.
 *
 * Archetype: an import bottom sheet — file/paste input → preview → confirm,
 * built from `components/m/*` + `components/m-states/*`. It mirrors the
 * fixed-bottom dialog pattern used by `foreman-crew.tsx`.
 *
 * Copy tone: direct. No hand-holding — tell the estimator exactly what will
 * land and what's wrong with the file.
 */
import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  parseTakeoffImport,
  useTakeoffImport,
  TAKEOFF_IMPORT_MAX_ROWS,
  type TakeoffImportPreview,
} from '@/lib/api/takeoff-import'
import { ApiError } from '@/lib/api'
import { MBanner, MButton, MI, MTextarea } from '../../components/m/index.js'

export interface TakeoffImportSheetProps {
  open: boolean
  projectId: string
  /** Page to associate imported measurements with; null imports project-level. */
  pageId?: string | null
  /** Human label used to tag imported rows (e.g. draft name or file name). */
  sourceLabel?: string
  onClose: () => void
  /** Called after a successful import with the number of measurements created. */
  onImported?: (count: number) => void
}

export function TakeoffImportSheet({
  open,
  projectId,
  pageId,
  sourceLabel,
  onClose,
  onImported,
}: TakeoffImportSheetProps) {
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const importMutation = useTakeoffImport(projectId)

  const preview: TakeoffImportPreview = useMemo(() => parseTakeoffImport(text), [text])
  const hasInput = text.trim().length > 0
  const tooMany = preview.validRows.length > TAKEOFF_IMPORT_MAX_ROWS
  const canImport = !importMutation.isPending && preview.validRows.length > 0 && !tooMany && !importMutation.isSuccess

  const reset = () => {
    setText('')
    setFileName(null)
    importMutation.reset()
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const close = () => {
    if (importMutation.isPending) return
    reset()
    onClose()
  }

  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    importMutation.reset()
    const reader = new FileReader()
    reader.onload = () => setText(typeof reader.result === 'string' ? reader.result : '')
    reader.readAsText(file)
  }

  const onImport = async () => {
    if (!canImport) return
    try {
      const res = await importMutation.mutateAsync({
        rows: preview.validRows,
        source_label: sourceLabel ?? fileName ?? 'csv',
        ...(pageId ? { page_id: pageId } : {}),
      })
      onImported?.(res.imported)
    } catch {
      // importMutation.error renders inline below.
    }
  }

  if (!open) return null

  const err = importMutation.error
  const errRequestId = err instanceof ApiError ? err.requestId : null

  return (
    <div
      role="dialog"
      aria-label="Import takeoff measurements"
      onClick={close}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 480,
          background: 'var(--m-bg)',
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          maxHeight: '88%',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 -4px 24px rgba(0,0,0,0.12)',
        }}
      >
        <div className="m-sheet-grabber" />
        <div className="m-sheet-header">
          <div className="m-sheet-title">Import measurements</div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            disabled={importMutation.isPending}
            className="m-link"
            style={{ display: 'inline-flex', alignItems: 'center' }}
          >
            <MI.X size={20} />
          </button>
        </div>

        <div style={{ overflow: 'auto', flex: 1, padding: '16px 16px calc(env(safe-area-inset-bottom, 0) + 16px)' }}>
          {importMutation.isSuccess ? (
            <SuccessState count={importMutation.data?.imported ?? 0} onImportMore={reset} onDone={close} />
          ) : (
            <>
              <p style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.5, margin: '0 0 14px' }}>
                Drop a CSV or TSV export from Bluebeam, PlanSwift, OST, or a spreadsheet. Needs a header row with{' '}
                <code>service_item_code</code> and <code>quantity</code> columns. <code>unit</code>, <code>rate</code>,
                and <code>notes</code> are optional.
              </p>

              {/* File picker */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
                onChange={onPickFile}
                style={{ display: 'none' }}
              />
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <MButton variant="ghost" onClick={() => fileInputRef.current?.click()}>
                  <MI.FileText size={16} /> {fileName ? 'Choose another file' : 'Choose CSV / TSV file'}
                </MButton>
              </div>
              {fileName ? (
                <div style={{ fontSize: 12, color: 'var(--m-ink-3)', marginBottom: 12 }}>Loaded: {fileName}</div>
              ) : null}

              {/* Paste */}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--m-ink-3)',
                  }}
                >
                  …or paste rows
                </span>
                <MTextarea
                  value={text}
                  onChange={(e) => {
                    setText(e.currentTarget.value)
                    setFileName(null)
                    importMutation.reset()
                  }}
                  placeholder={'service_item_code,quantity,unit,rate,notes\nDRYWALL-1,1200,sqft,2.15,north wall'}
                  rows={5}
                  spellCheck={false}
                  style={{ minHeight: 110, fontFamily: 'var(--m-mono, ui-monospace, monospace)', fontSize: 12 }}
                />
              </label>

              {/* Preview / validation */}
              {hasInput ? <PreviewBlock preview={preview} tooMany={tooMany} /> : null}

              {/* Error from the commit */}
              {err ? (
                <div style={{ marginBottom: 12 }}>
                  <MBanner tone="error" title="Import failed" body={err.message} requestId={errRequestId} />
                </div>
              ) : null}

              {/* Confirm */}
              <MButton variant="primary" onClick={() => void onImport()} disabled={!canImport}>
                {importMutation.isPending
                  ? 'Importing…'
                  : preview.validRows.length > 0
                    ? `Import ${preview.validRows.length} measurement${preview.validRows.length === 1 ? '' : 's'}`
                    : 'Import measurements'}
              </MButton>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function PreviewBlock({ preview, tooMany }: { preview: TakeoffImportPreview; tooMany: boolean }) {
  const errorRows = preview.rows.filter((r) => r.error !== null)
  const valid = preview.validRows.length
  const sample = preview.rows.slice(0, 8)

  if (preview.rows.length === 0) {
    return (
      <div style={{ marginBottom: 12 }}>
        <MBanner tone="warn" title="No data rows" body="Add a header row plus at least one row of measurements." />
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 12,
          color: 'var(--m-ink-3)',
          marginBottom: 8,
        }}
      >
        <span>
          {valid} ready · {preview.invalidCount} skipped · {preview.rows.length} total
        </span>
      </div>

      {tooMany ? (
        <div style={{ marginBottom: 10 }}>
          <MBanner
            tone="error"
            title={`Over the ${TAKEOFF_IMPORT_MAX_ROWS}-row limit`}
            body={`This file has ${valid} valid rows. Split it into batches of ${TAKEOFF_IMPORT_MAX_ROWS} or fewer.`}
          />
        </div>
      ) : null}

      {/* Compact preview table — the parsed rows, so the estimator can eyeball the column mapping. */}
      <div
        style={{
          border: '1px solid var(--m-line)',
          borderRadius: 'var(--m-r)',
          overflow: 'hidden',
          fontSize: 12,
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.4fr 0.8fr 0.6fr 0.7fr',
            gap: 0,
            background: 'var(--m-card-soft)',
            padding: '6px 10px',
            fontWeight: 600,
            color: 'var(--m-ink-2)',
            borderBottom: '1px solid var(--m-line)',
          }}
        >
          <span>Code</span>
          <span style={{ textAlign: 'right' }}>Qty</span>
          <span style={{ textAlign: 'right' }}>Unit</span>
          <span style={{ textAlign: 'right' }}>Rate</span>
        </div>
        {sample.map((r) => (
          <div
            key={r.line}
            style={{
              display: 'grid',
              gridTemplateColumns: '1.4fr 0.8fr 0.6fr 0.7fr',
              gap: 0,
              padding: '6px 10px',
              borderBottom: '1px solid var(--m-line)',
              color: r.error ? 'var(--m-red)' : 'var(--m-ink)',
              opacity: r.error ? 0.85 : 1,
            }}
            title={r.error ?? undefined}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.error ? <MI.Alert size={12} /> : null} {r.row.service_item_code || '—'}
            </span>
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.row.quantity}</span>
            <span style={{ textAlign: 'right', color: 'var(--m-ink-3)' }}>{r.row.unit ?? '—'}</span>
            <span style={{ textAlign: 'right', color: 'var(--m-ink-3)', fontVariantNumeric: 'tabular-nums' }}>
              {r.row.rate ?? '—'}
            </span>
          </div>
        ))}
        {preview.rows.length > sample.length ? (
          <div style={{ padding: '6px 10px', color: 'var(--m-ink-3)', fontSize: 11 }}>
            +{preview.rows.length - sample.length} more
          </div>
        ) : null}
      </div>

      {preview.invalidCount > 0 ? (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--m-ink-3)' }}>
          {errorRows.length === 1
            ? `Row ${errorRows[0]!.line}: ${errorRows[0]!.error}`
            : `${preview.invalidCount} rows will be skipped — first: row ${errorRows[0]!.line}, ${errorRows[0]!.error}`}
        </div>
      ) : null}
    </div>
  )
}

function SuccessState({
  count,
  onImportMore,
  onDone,
}: {
  count: number
  onImportMore: () => void
  onDone: () => void
}) {
  return (
    <div style={{ padding: '24px 8px', textAlign: 'center' }}>
      <div
        style={{
          width: 56,
          height: 56,
          margin: '0 auto 16px',
          borderRadius: 14,
          background: 'var(--m-green-soft, var(--m-accent-soft))',
          color: 'var(--m-green)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <MI.Check size={26} />
      </div>
      <div style={{ fontSize: 19, fontWeight: 600, marginBottom: 6 }}>
        Imported {count} measurement{count === 1 ? '' : 's'}
      </div>
      <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.5, marginBottom: 18 }}>
        They're on the active draft now, tagged as imported. Review them in the running quantities.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <MButton variant="primary" onClick={onDone}>
          Done
        </MButton>
        <MButton variant="ghost" onClick={onImportMore}>
          Import another file
        </MButton>
      </div>
    </div>
  )
}
