import { type BlueprintDocument, type BlueprintPage, type ServiceItem } from '@/lib/api'
import { MButton, MPill } from '@/components/m'
import { DEmptyState } from '@/components/d'
import { floatBox, floatHead } from './desktop-body-styles'

// Small floating canvas-chrome panels — extracted verbatim from desktop-body.tsx
// (behavior preserved). Each is a pure prop-taking render; the render gates stay
// in the parent.

// DCanvasCrossRef · "JUMPED FROM …" panel (dsg__50). Shown after a cross-sheet
// callout jump: explains which callout was clicked and offers a one-click RETURN.
export function JumpedFromPanel({
  label,
  activePage,
  onReturn,
}: {
  label: string
  activePage: BlueprintPage | null
  onReturn: () => void
}) {
  return (
    <div style={floatBox({ top: 232, right: 312, width: 240 })}>
      <div style={floatHead}>● Jumped from {label}</div>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--m-ink)', lineHeight: 1.5 }}>
          You followed a detail callout. This is the referenced sheet
          {activePage ? ` (pg ${activePage.page_number})` : ''}.
        </div>
        <MButton variant="primary" onClick={onReturn}>
          ← Return to {label}
        </MButton>
      </div>
    </div>
  )
}

// DCanvasSheetRef · sheet-reference chip (bottom-left).
export function SheetRefChip({
  activeBlueprint,
  activePage,
}: {
  activeBlueprint: BlueprintDocument | null
  activePage: BlueprintPage | null
}) {
  return (
    <div
      style={floatBox({
        bottom: 16,
        left: 16,
        padding: '8px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      })}
    >
      <span
        style={{
          width: 8,
          height: 8,
          background: activeBlueprint ? 'var(--m-green)' : 'var(--m-ink-3)',
          flexShrink: 0,
        }}
        aria-hidden
      />
      <span
        style={{
          fontFamily: 'var(--m-num)',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--m-ink)',
        }}
      >
        {activeBlueprint
          ? `Sheet · ${activeBlueprint.file_name}${activePage ? ` · pg ${activePage.page_number}` : ''}`
          : 'No sheet · grid only'}
      </span>
      {activeBlueprint?.sheet_scale ? (
        <span style={{ fontFamily: 'var(--m-num)', fontSize: 10, fontWeight: 700, color: 'var(--m-ink-3)' }}>
          {activeBlueprint.sheet_scale}
        </span>
      ) : null}
    </div>
  )
}

// DCanvasEmpty · no-drawing dropzone (uses DEmptyState).
export function EmptyDropzone({
  canUploadBlueprint,
  uploadPending,
  uploadError,
  onPickFile,
}: {
  canUploadBlueprint: boolean
  uploadPending: boolean
  uploadError: string | null
  onPickFile: () => void
}) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          pointerEvents: 'auto',
          background: 'var(--m-card)',
          border: '3px dashed var(--m-ink)',
          maxWidth: 520,
        }}
      >
        <DEmptyState
          mark="↓"
          title="Drop the plan set"
          body="Plan set, drawings, or architect's PDF — up to 200MB, multi-page OK. Sheets, cross-references, and scales read automatically. Or pick a blueprint from the Item palette."
          action={
            canUploadBlueprint ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
                <MButton variant="primary" onClick={onPickFile} disabled={uploadPending}>
                  {uploadPending ? 'Uploading…' : '↑ Upload blueprint'}
                </MButton>
                {uploadError ? <div style={{ fontSize: 12, color: 'var(--m-red)' }}>{uploadError}</div> : null}
              </div>
            ) : undefined
          }
        />
      </div>
    </div>
  )
}

// "/" affordance to open the item palette while drawing.
export function AssignItemAffordance({
  selectedItem,
  onOpen,
}: {
  selectedItem: ServiceItem | null
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Assign item (command palette)"
      style={floatBox({
        bottom: 16,
        right: 16,
        padding: '8px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        cursor: 'pointer',
      })}
    >
      <span
        style={{
          fontFamily: 'var(--m-num)',
          fontWeight: 800,
          fontSize: 12,
          color: 'var(--m-accent-ink)',
          background: 'var(--m-accent)',
          padding: '1px 6px',
        }}
        aria-hidden
      >
        /
      </span>
      <span
        style={{
          fontFamily: 'var(--m-num)',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.06em',
          color: 'var(--m-ink)',
        }}
      >
        ASSIGN ITEM
      </span>
      {selectedItem ? <MPill tone="accent">{selectedItem.code}</MPill> : null}
    </button>
  )
}
