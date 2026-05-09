import { useEffect, useMemo, useState } from 'react'
import { Banner, Card, MobileButton, Sheet } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { API_URL, useProjectBlueprints, type BlueprintDocument } from '@/lib/api'

/**
 * `prj-revision-compare-stub` — plan revision compare overlay.
 *
 * P1 deferral: the actual visual diff (image-diff worker output → red /
 * blue overlay) hasn't shipped yet. Migration `037_blueprint_revisions`
 * already has `blueprint_page_diffs`; this UI lands the picker + data
 * fetching so the diff renderer can plug in cleanly later.
 *
 * What's wired today:
 *   - revision dropdown (any two `blueprint_documents` within the same
 *     project — the lineage column `replaces_blueprint_document_id`
 *     surfaces the intended pairing but the user can pick any pair).
 *   - "before" + "after" PDF/image URLs computed from
 *     `/api/blueprints/:id/file` so the diff worker, when shipped, has
 *     a stable input pair.
 *   - Coming-soon banner explaining the deferral.
 */
export interface RevisionCompareStubProps {
  open: boolean
  onClose: () => void
  projectId: string
  /** Optional preselected "after" blueprint (the one currently on canvas). */
  initialAfterId?: string | null
}

export function RevisionCompareStub({ open, onClose, projectId, initialAfterId }: RevisionCompareStubProps) {
  const blueprints = useProjectBlueprints(projectId)
  const list: BlueprintDocument[] = useMemo(
    () => [...(blueprints.data?.blueprints ?? [])].sort((a, b) => b.version - a.version),
    [blueprints.data],
  )

  const [afterId, setAfterId] = useState<string>(initialAfterId ?? '')
  const [beforeId, setBeforeId] = useState<string>('')

  // Default the dropdown to the latest pair (current vs. its
  // replaces-target) once the list lands.
  useEffect(() => {
    if (!open || list.length === 0) return
    const after = initialAfterId ? list.find((b) => b.id === initialAfterId) : list[0]
    if (!after) return
    setAfterId((prev) => prev || after.id)
    const before = after.replaces_blueprint_document_id
      ? list.find((b) => b.id === after.replaces_blueprint_document_id)
      : list.find((b) => b.id !== after.id)
    if (before) setBeforeId((prev) => prev || before.id)
  }, [open, initialAfterId, list])

  const after = list.find((b) => b.id === afterId)
  const before = list.find((b) => b.id === beforeId)

  return (
    <Sheet open={open} onClose={onClose} title="Compare revisions">
      <div className="space-y-3">
        <Banner tone="info" title="Coming soon: visual diff">
          The image-diff worker that turns these two PDFs into red/blue change regions hasn't shipped yet. Pick a pair
          and the data layer will be ready when the renderer lands.
        </Banner>

        {blueprints.isPending ? (
          <div className="text-[12px] text-ink-3">Loading revisions…</div>
        ) : list.length < 2 ? (
          <Card>
            <div className="text-[13px] font-semibold">Only one revision uploaded</div>
            <div className="text-[12px] text-ink-3 mt-1">
              Compare needs at least two blueprint versions on this project. Upload a re-issued plan to enable side-by-
              side diffing.
            </div>
          </Card>
        ) : (
          <Card tight>
            <label className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Before</label>
            <select
              value={beforeId}
              onChange={(e) => setBeforeId(e.target.value)}
              className="mt-1 w-full text-[14px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
            >
              <option value="">— pick a revision —</option>
              {list.map((b) => (
                <option key={b.id} value={b.id}>
                  v{b.version} · {b.file_name}
                </option>
              ))}
            </select>

            <label className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3 mt-3">After</label>
            <select
              value={afterId}
              onChange={(e) => setAfterId(e.target.value)}
              className="mt-1 w-full text-[14px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
            >
              <option value="">— pick a revision —</option>
              {list.map((b) => (
                <option key={b.id} value={b.id}>
                  v{b.version} · {b.file_name}
                </option>
              ))}
            </select>
          </Card>
        )}

        <div className="grid grid-cols-2 gap-2">
          <RevisionPreview label="Before" doc={before} />
          <RevisionPreview label="After" doc={after} />
        </div>

        <div className="grid grid-cols-2 gap-2 pt-1">
          <MobileButton variant="ghost" onClick={onClose}>
            Close
          </MobileButton>
          <MobileButton variant="primary" disabled>
            Run diff (coming soon)
          </MobileButton>
        </div>

        <Attribution source="GET /api/projects/:id/blueprints · GET /api/blueprints/:id/file · 037 blueprint_page_diffs" />
      </div>
    </Sheet>
  )
}

interface RevisionPreviewProps {
  label: string
  doc: BlueprintDocument | undefined
}

function RevisionPreview({ label, doc }: RevisionPreviewProps) {
  return (
    <Card tight>
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</div>
      {doc ? (
        <div className="mt-1">
          <div className="text-[13px] font-semibold truncate">v{doc.version}</div>
          <div className="text-[11px] text-ink-3 truncate">{doc.file_name}</div>
          <a
            href={`${API_URL}/api/blueprints/${encodeURIComponent(doc.id)}/file`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-[12px] font-semibold text-accent"
          >
            Open file →
          </a>
        </div>
      ) : (
        <div className="mt-1 text-[12px] text-ink-3">No revision selected.</div>
      )}
    </Card>
  )
}
