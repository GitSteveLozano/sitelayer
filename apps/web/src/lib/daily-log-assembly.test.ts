import { describe, expect, it } from 'vitest'
import { assembleDailyLogDefaults, isEmptyDailyLogDraft } from './daily-log-assembly.js'

describe('assembleDailyLogDefaults', () => {
  const occurredOn = '2026-05-09'

  it('returns empty defaults when no data is supplied', () => {
    const out = assembleDailyLogDefaults({
      briefs: [],
      laborEntries: [],
      photos: [],
      occurredOn,
    })
    expect(out.scope_progress).toBe('')
    expect(out.crew_summary).toBe('')
    expect(out.photo_keys).toEqual([])
    expect(out.source_counts).toEqual({ briefs: 0, labor_entries: 0, photos: 0 })
  })

  it('uses brief steps as the scope_progress when present', () => {
    const out = assembleDailyLogDefaults({
      briefs: [
        {
          goal: 'Continue rough framing',
          steps: [{ name: 'North wall' }, { name: 'South wall' }, { name: 'Header above garage' }],
          effective_date: occurredOn,
        },
      ],
      laborEntries: [],
      photos: [],
      occurredOn,
    })
    expect(out.scope_progress).toBe('North wall\nSouth wall\nHeader above garage')
    expect(out.source_counts.briefs).toBe(1)
  })

  it('falls back to the brief goal when steps are missing', () => {
    const out = assembleDailyLogDefaults({
      briefs: [
        {
          goal: 'Pour back-side footings',
          effective_date: occurredOn,
        },
      ],
      laborEntries: [],
      photos: [],
      occurredOn,
    })
    expect(out.scope_progress).toBe('Pour back-side footings')
  })

  it('picks the most recent brief by effective_date', () => {
    const out = assembleDailyLogDefaults({
      briefs: [
        { goal: 'old', steps: ['Old step'], effective_date: '2026-05-08' },
        { goal: 'new', steps: ['New step'], effective_date: occurredOn },
      ],
      laborEntries: [],
      photos: [],
      occurredOn,
    })
    expect(out.scope_progress).toBe('New step')
  })

  it('aggregates labor hours per worker, sorted desc', () => {
    const out = assembleDailyLogDefaults({
      briefs: [],
      laborEntries: [
        { worker_id: 'w1', hours: '4.0', occurred_on: occurredOn },
        { worker_id: 'w2', hours: '8.5', occurred_on: occurredOn },
        { worker_id: 'w1', hours: '2.5', occurred_on: occurredOn },
      ],
      workers: [
        { id: 'w1', name: 'Alex' },
        { id: 'w2', name: 'Sam' },
      ],
      photos: [],
      occurredOn,
    })
    expect(out.crew_summary).toBe('Sam: 8.5h\nAlex: 6.5h')
    expect(out.source_counts.labor_entries).toBe(3)
  })

  it('skips deleted labor entries and entries on other dates', () => {
    const out = assembleDailyLogDefaults({
      briefs: [],
      laborEntries: [
        { worker_id: 'w1', hours: '8', occurred_on: occurredOn, deleted_at: '2026-05-09T10:00:00Z' },
        { worker_id: 'w1', hours: '4', occurred_on: '2026-05-08' },
        { worker_id: 'w1', hours: '6', occurred_on: occurredOn },
      ],
      workers: [{ id: 'w1', name: 'Alex' }],
      photos: [],
      occurredOn,
    })
    expect(out.crew_summary).toBe('Alex: 6.0h')
    expect(out.source_counts.labor_entries).toBe(1)
  })

  it('falls back to the worker_id when the worker roster is missing one', () => {
    const out = assembleDailyLogDefaults({
      briefs: [],
      laborEntries: [{ worker_id: 'unknown-worker', hours: '3', occurred_on: occurredOn }],
      workers: [],
      photos: [],
      occurredOn,
    })
    expect(out.crew_summary).toBe('unknown-worker: 3.0h')
  })

  it('groups null worker_id under (unassigned)', () => {
    const out = assembleDailyLogDefaults({
      briefs: [],
      laborEntries: [{ worker_id: null, hours: '5', occurred_on: occurredOn }],
      workers: [],
      photos: [],
      occurredOn,
    })
    expect(out.crew_summary).toBe('(unassigned): 5.0h')
  })

  it('keeps photos for the day, filters out other dates, dedupes on key', () => {
    const out = assembleDailyLogDefaults({
      briefs: [],
      laborEntries: [],
      photos: [
        { key: 'co/dl/a.jpg', created_at: `${occurredOn}T08:30:00Z` },
        { key: 'co/dl/b.jpg', created_at: `${occurredOn}T11:15:00Z` },
        { key: 'co/dl/a.jpg', created_at: `${occurredOn}T11:20:00Z` }, // dupe
        { key: 'co/dl/yesterday.jpg', created_at: '2026-05-08T15:00:00Z' },
      ],
      occurredOn,
    })
    expect(out.photo_keys).toEqual(['co/dl/a.jpg', 'co/dl/b.jpg'])
    expect(out.source_counts.photos).toBe(2)
  })

  it('ignores non-finite hours rather than blowing up the totals', () => {
    const out = assembleDailyLogDefaults({
      briefs: [],
      laborEntries: [
        { worker_id: 'w1', hours: 'NaN', occurred_on: occurredOn },
        { worker_id: 'w1', hours: '4', occurred_on: occurredOn },
      ],
      workers: [{ id: 'w1', name: 'Alex' }],
      photos: [],
      occurredOn,
    })
    expect(out.crew_summary).toBe('Alex: 4.0h')
    expect(out.source_counts.labor_entries).toBe(1)
  })
})

describe('isEmptyDailyLogDraft', () => {
  it('treats an all-blank draft as empty', () => {
    expect(
      isEmptyDailyLogDraft({
        notes: null,
        scope_progress: [],
        crew_summary: [],
        schedule_deviations: [],
      }),
    ).toBe(true)
  })

  it('treats whitespace-only notes as empty', () => {
    expect(
      isEmptyDailyLogDraft({
        notes: '   \n  ',
        scope_progress: null,
        crew_summary: null,
        schedule_deviations: null,
      }),
    ).toBe(true)
  })

  it('returns false when notes have content', () => {
    expect(
      isEmptyDailyLogDraft({
        notes: 'Wrapped the south wall.',
        scope_progress: [],
        crew_summary: [],
        schedule_deviations: [],
      }),
    ).toBe(false)
  })

  it('returns false when scope_progress is a non-empty string', () => {
    expect(
      isEmptyDailyLogDraft({
        notes: null,
        scope_progress: 'North wall',
        crew_summary: null,
        schedule_deviations: null,
      }),
    ).toBe(false)
  })

  it('returns false when schedule_deviations has entries', () => {
    expect(
      isEmptyDailyLogDraft({
        notes: null,
        scope_progress: null,
        crew_summary: null,
        schedule_deviations: ['Behind on cornice'],
      }),
    ).toBe(false)
  })
})
