/**
 * Daily-log auto-assembly fallback.
 *
 * When the voice-to-log AI agent isn't available (e.g. worker offline,
 * no transcript dictated yet), we still want the foreman to land on a
 * pre-populated draft instead of an empty form. This module is the
 * deterministic, no-LLM fallback that pulls the day's brief steps,
 * labor entries, and field-photo pings into a shape the daily-log
 * editor can spread directly into a PATCH body.
 *
 * Pure data transformation — easy to unit test and easy to call
 * twice without side effects. Hooked into `daily-log.tsx` and
 * `mobile/foreman-log.tsx` via a `useEffect` that fires once per
 * empty draft on mount.
 *
 * Out of scope (deferred):
 *   - weather: needs geocoded zip + OpenWeather call. Stays blank.
 *   - schedule_deviations: synthesized only by the voice-to-log agent.
 */

export interface BriefLike {
  /** Free-form goal for the day; first sentence often reads as the
   * scope opener so we keep it. */
  goal: string
  /** Optional structured steps. Each step's `name` is the canonical
   * piece we surface on the foreman log. */
  steps?: unknown
  /** Inserted by the API; not load-bearing here but passed through for
   * downstream typings. */
  effective_date?: string
}

export interface LaborEntryLike {
  worker_id: string | null
  hours: string | number
  occurred_on: string
  /** Optional — when present we pass it into the crew summary. */
  service_item_code?: string | null
  /** Soft-deleted entries are ignored. */
  deleted_at?: string | null
}

export interface WorkerLike {
  id: string
  name: string
}

export interface PhotoSourceLike {
  /** Storage key from the daily-log row, or a worker_issues photo_log
   * marker. Unique per photo. */
  key: string
  /** ISO timestamp; only photos from `occurredOn` are pulled in. */
  created_at: string
}

export interface AssemblyInput {
  /** All briefs already known for this project on this date. The most
   * recent one (highest `effective_date` then created_at) wins. */
  briefs: readonly BriefLike[]
  /** Labor entries on this project on this date. Soft-deleted entries
   * are filtered out by the assembler. */
  laborEntries: readonly LaborEntryLike[]
  /** Worker roster used to render names; an unknown worker_id falls
   * back to the id itself (still useful for office triage). */
  workers?: readonly WorkerLike[]
  /** Already-attached daily-log photo keys + worker-log photo pings
   * for this date. Deduped on `key`. */
  photos: readonly PhotoSourceLike[]
  /** YYYY-MM-DD; entries outside this date are ignored. */
  occurredOn: string
}

export interface AssemblyDefaults {
  /** Newline-separated brief step names — feeds the daily log's
   * `scope_progress` jsonb (the API stores arbitrary jsonb so a string
   * is acceptable; the foreman edits it before submit). */
  scope_progress: string
  /** "<name>: <hours>h" lines, sorted by hours desc. Empty string when
   * no labor was logged. */
  crew_summary: string
  /** Storage keys to preload onto the daily-log photo grid. */
  photo_keys: string[]
  /** Provenance counts for the "Pre-filled from today's data" pill. */
  source_counts: {
    briefs: number
    labor_entries: number
    photos: number
  }
}

/**
 * Pure assembler — given the day's primitive data, return the prefill
 * payload. Callers are expected to noop when the daily log is already
 * non-empty (see `isEmptyDailyLogDraft` below).
 */
export function assembleDailyLogDefaults(input: AssemblyInput): AssemblyDefaults {
  const { briefs, laborEntries, workers = [], photos, occurredOn } = input

  // Most recent brief wins. We only consume the brief itself (not the
  // full history) — a foreman who patched the brief at lunch should
  // see the patched scope, not the morning version.
  const orderedBriefs = [...briefs].sort((a, b) => {
    const da = a.effective_date ?? ''
    const db = b.effective_date ?? ''
    if (da !== db) return db.localeCompare(da)
    return 0
  })
  const mostRecent = orderedBriefs[0] ?? null

  const stepNames: string[] = []
  if (mostRecent) {
    if (Array.isArray(mostRecent.steps)) {
      for (const step of mostRecent.steps) {
        if (step && typeof step === 'object') {
          // Briefs use `title` (apps/web/src/lib/api/project-briefs.ts)
          // but tolerate `name` so the assembler is reusable for other
          // step-shaped feeds.
          const obj = step as { name?: unknown; title?: unknown }
          const candidate = typeof obj.title === 'string' ? obj.title : typeof obj.name === 'string' ? obj.name : ''
          const trimmed = candidate.trim()
          if (trimmed) stepNames.push(trimmed)
        } else if (typeof step === 'string') {
          const trimmed = step.trim()
          if (trimmed) stepNames.push(trimmed)
        }
      }
    }
    if (stepNames.length === 0 && mostRecent.goal.trim()) {
      // Fallback to the goal sentence when the brief didn't come with
      // structured steps — better than an empty scope_progress field.
      stepNames.push(mostRecent.goal.trim())
    }
  }

  // Crew summary: aggregate hours per worker for THIS date.
  const workerName = new Map(workers.map((w) => [w.id, w.name]))
  const hoursByWorker = new Map<string, number>()
  let validLaborCount = 0
  for (const entry of laborEntries) {
    if (entry.deleted_at) continue
    if (entry.occurred_on !== occurredOn) continue
    const id = entry.worker_id ?? '(unassigned)'
    const hours = Number(entry.hours)
    if (!Number.isFinite(hours)) continue
    hoursByWorker.set(id, (hoursByWorker.get(id) ?? 0) + hours)
    validLaborCount++
  }
  const crewLines: string[] = []
  const crewSorted = [...hoursByWorker.entries()].sort((a, b) => b[1] - a[1])
  for (const [id, hours] of crewSorted) {
    const name = workerName.get(id) ?? id
    crewLines.push(`${name}: ${hours.toFixed(1)}h`)
  }

  // Photos: filter to today's date, dedupe on key, preserve insertion order.
  const seen = new Set<string>()
  const photoKeys: string[] = []
  for (const photo of photos) {
    if (!photo.key) continue
    const day = photo.created_at.slice(0, 10)
    if (day !== occurredOn) continue
    if (seen.has(photo.key)) continue
    seen.add(photo.key)
    photoKeys.push(photo.key)
  }

  return {
    scope_progress: stepNames.join('\n'),
    crew_summary: crewLines.join('\n'),
    photo_keys: photoKeys,
    source_counts: {
      briefs: mostRecent ? 1 : 0,
      labor_entries: validLaborCount,
      photos: photoKeys.length,
    },
  }
}

/**
 * True when the draft has no foreman input yet — narratve, scope,
 * crew, deviations all empty. The auto-assembly hook only fires in
 * this state so we never clobber a foreman's typing.
 *
 * Note: photo_keys can already be non-empty if the foreman uploaded
 * a photo before opening the form; we still pre-fill scope/crew if
 * those are blank. The caller decides what to apply.
 */
export function isEmptyDailyLogDraft(draft: {
  notes: string | null
  scope_progress: unknown
  crew_summary: unknown
  schedule_deviations: unknown
}): boolean {
  if (draft.notes && draft.notes.trim()) return false
  if (isNonEmptyPayload(draft.scope_progress)) return false
  if (isNonEmptyPayload(draft.crew_summary)) return false
  if (isNonEmptyPayload(draft.schedule_deviations)) return false
  return true
}

function isNonEmptyPayload(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0
  return Boolean(value)
}
