/**
 * Shared scope-step helpers for the worker screens (`wk-today` summary +
 * `wk-scope` detail). Brief steps are stored as opaque jsonb by the
 * foreman UI (`fm-brief`), so the canonical `ProjectBriefStep` type
 * carries only title/duration/materials/notes. The morning brief may
 * also stamp an optional `status` ("done" | "in_progress" | "upcoming")
 * and a `sqft_done` number on a step once a worker reports progress; we
 * read those defensively here without widening the shared API type.
 *
 * Derivation when no explicit status is present: walk the step list and
 * treat the first step without a `done` flag as in-progress, everything
 * before it as done, and the rest as upcoming. With zero signal we
 * report everything as upcoming so we never over-report completion.
 */
import type { ProjectBriefStep } from '../../lib/api/project-briefs.js'

export type ScopeStepStatus = 'done' | 'in_progress' | 'upcoming'

/** A brief step with the optional progress fields the foreman UI may set. */
export type AnnotatedStep = ProjectBriefStep & {
  status?: string | null
  done?: boolean | null
  sqft_done?: number | string | null
}

function normalizeStatus(raw: unknown): ScopeStepStatus | null {
  if (typeof raw !== 'string') return null
  const s = raw.toLowerCase()
  if (s.includes('done') || s.includes('complete')) return 'done'
  if (s.includes('progress') || s.includes('active') || s === 'now') return 'in_progress'
  if (s.includes('upcoming') || s.includes('todo') || s.includes('pending') || s.includes('next')) return 'upcoming'
  return null
}

/** Status for a single step, honoring an explicit field when present. */
export function stepStatus(step: ProjectBriefStep): ScopeStepStatus {
  const annotated = step as AnnotatedStep
  const explicit = normalizeStatus(annotated.status)
  if (explicit) return explicit
  if (annotated.done === true) return 'done'
  return 'upcoming'
}

/**
 * Status per index across the whole list. Uses explicit per-step status
 * when any step declares one; otherwise derives a single in-progress
 * pointer at the first not-done step so the design's
 * done / in-progress / upcoming treatment renders sensibly.
 */
export function deriveStepStatuses(steps: ReadonlyArray<ProjectBriefStep>): ScopeStepStatus[] {
  const anyExplicit = steps.some((s) => {
    const a = s as AnnotatedStep
    return normalizeStatus(a.status) !== null || a.done === true
  })
  if (anyExplicit) return steps.map((s) => stepStatus(s))

  // No explicit signal anywhere: leave all upcoming. Callers that know a
  // progress percentage (e.g. from sqft) can override the in-progress
  // pointer themselves.
  return steps.map(() => 'upcoming')
}

/** Sum of reported sqft across steps that carry a numeric `sqft_done`. */
export function sumStepSqftDone(steps: ReadonlyArray<ProjectBriefStep>): number | null {
  let total = 0
  let found = false
  for (const s of steps) {
    const raw = (s as AnnotatedStep).sqft_done
    const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN
    if (Number.isFinite(n)) {
      total += n
      found = true
    }
  }
  return found ? total : null
}
