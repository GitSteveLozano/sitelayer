// repro-replay.ts — operator-side helpers for viewing a captured reproduction:
// parsing the `repro_bracket` summary + the `rrweb` DOM-replay artifact, and a
// lazily-loaded rrweb Replayer so the heavy player code stays off every other
// page (matching the bundle hygiene in capture-capabilities.ts).
//
// The parsers are deliberately defensive — the JSON is operator/collaborator-
// supplied, so anything missing or oddly-shaped yields null/empty rather than
// throwing inside the triage UI.

export type ReproMarkView = {
  offset_ms: number
  label: string
  at: string | null
}

export type ReproBracketView = {
  started_at: string | null
  ended_at: string | null
  duration_ms: number | null
  route_path: string | null
  start_note: string | null
  end_note: string | null
  marks: ReproMarkView[]
  replay_enabled: boolean
  replay_event_count: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Parse a `capture.repro_bracket` artifact payload into a view model. */
export function parseReproBracketSummary(raw: unknown): ReproBracketView | null {
  if (!isRecord(raw)) return null
  if (raw.artifact_type !== 'capture.repro_bracket') return null
  const start = isRecord(raw.start_condition) ? raw.start_condition : {}
  const end = isRecord(raw.end_condition) ? raw.end_condition : {}
  const replay = isRecord(raw.replay) ? raw.replay : {}
  const marks: ReproMarkView[] = Array.isArray(raw.marks)
    ? raw.marks.flatMap((entry): ReproMarkView[] => {
        if (!isRecord(entry)) return []
        const offset = num(entry.offset_ms)
        if (offset === null) return []
        return [{ offset_ms: offset, label: str(entry.label) ?? 'Mark', at: str(entry.at) }]
      })
    : []
  return {
    started_at: str(raw.started_at),
    ended_at: str(raw.ended_at),
    duration_ms: num(raw.duration_ms),
    route_path: str(raw.route_path),
    start_note: str(start.note),
    end_note: str(end.note),
    marks,
    replay_enabled: replay.enabled === true,
    replay_event_count: num(replay.event_count),
  }
}

/**
 * Pull the rrweb event array out of a `capture.rrweb_replay` artifact. Returns
 * null unless there are at least two events (rrweb needs a full snapshot plus at
 * least one increment to replay anything).
 */
export function parseRrwebReplayEvents(raw: unknown): unknown[] | null {
  if (!isRecord(raw)) return null
  if (raw.artifact_type !== 'capture.rrweb_replay') return null
  const events = raw.events
  if (!Array.isArray(events) || events.length < 2) return null
  return events
}

export function formatReproOffset(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function formatReproDuration(ms: number | null): string {
  if (ms === null) return '—'
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  return formatReproOffset(ms)
}

/** Minimal slice of the rrweb Replayer we drive (so tests can pass a fake). */
export type RrwebReplayerLike = {
  play(timeOffset?: number): void
  pause(): void
  destroy?: () => void
}

/**
 * Lazily import rrweb (and its player stylesheet) and build a Replayer mounted
 * into `root`. Kept out of the eager bundle; only loaded when an operator clicks
 * "Play reproduction".
 */
export async function createRrwebReplayer(events: unknown[], root: HTMLElement): Promise<RrwebReplayerLike> {
  await import('rrweb/dist/style.css').catch(() => undefined)
  const { Replayer } = await import('rrweb')
  const replayer = new Replayer(events as never, {
    root,
    skipInactive: true,
    showWarning: false,
    mouseTail: false,
  })
  return replayer as unknown as RrwebReplayerLike
}
