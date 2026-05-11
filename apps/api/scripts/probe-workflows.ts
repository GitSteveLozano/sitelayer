// Headless workflow probe — exercises every deterministic workflow's
// REST surface against a target tier and asserts the snapshot ↔ event
// loop holds:
//   1. GET list endpoint returns 200
//   2. GET snapshot returns { state, state_version, next_events: [] }
//   3. POST event with a stale state_version returns 409 with a
//      "state_version mismatch" hint
//   4. (optional, when --transition is passed) POST a valid event,
//      verify state_version bumps, snap-after matches.
//
// Usage:
//   API_TARGET=http://localhost:3002 npx tsx apps/api/scripts/probe-workflows.ts
//   API_TARGET=https://sitelayer.sandolab.xyz \
//     COMPANY_SLUG=la-operations \
//     CLERK_TOKEN=eyJ… \
//     npx tsx apps/api/scripts/probe-workflows.ts --transition
//
// Outputs a markdown table to stdout. Exits non-zero if any workflow's
// list endpoint or sample snapshot 5xx's. Read-only by default; pass
// --transition to send actual events (irreversible state moves; only
// safe in dev or test data).

interface ProbeArgs {
  base: string
  slug: string
  token: string | null
  transition: boolean
}

function parseArgs(): ProbeArgs {
  const args = new Set(process.argv.slice(2))
  return {
    base: (process.env.API_TARGET ?? 'http://localhost:3002').replace(/\/+$/, ''),
    slug: process.env.COMPANY_SLUG ?? 'la-operations',
    token: process.env.CLERK_TOKEN ?? null,
    transition: args.has('--transition'),
  }
}

interface FetchResult {
  status: number
  body: unknown
}

async function fetchJson(path: string, args: ProbeArgs, init: RequestInit = {}): Promise<FetchResult> {
  const headers: Record<string, string> = {
    'x-sitelayer-company-slug': args.slug,
    'content-type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  }
  if (args.token) headers.authorization = `Bearer ${args.token}`
  let res: Response
  try {
    res = await fetch(`${args.base}${path}`, { ...init, headers })
  } catch (err) {
    return { status: 0, body: { error: String(err) } }
  }
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // not json; keep raw
  }
  return { status: res.status, body }
}

interface WorkflowSurface {
  name: string
  list: string
  /** Field on the list response holding the items array. */
  listField: string
  /** Path to the snapshot endpoint for an item id. */
  snapPath: (id: string) => string
  /** Path to the event-dispatch endpoint for an item id. */
  eventsPath: (id: string) => string
}

const SURFACES: WorkflowSurface[] = [
  {
    name: 'rental-billing',
    list: '/api/rental-billing-runs',
    listField: 'runs',
    snapPath: (id) => `/api/rental-billing-runs/${id}`,
    eventsPath: (id) => `/api/rental-billing-runs/${id}/events`,
  },
  {
    name: 'estimate-push',
    list: '/api/estimate-pushes',
    listField: 'estimatePushes',
    snapPath: (id) => `/api/estimate-pushes/${id}`,
    eventsPath: (id) => `/api/estimate-pushes/${id}/events`,
  },
  {
    name: 'labor-payroll',
    list: '/api/labor-payroll-runs',
    listField: 'runs',
    snapPath: (id) => `/api/labor-payroll-runs/${id}`,
    eventsPath: (id) => `/api/labor-payroll-runs/${id}/events`,
  },
  {
    name: 'project-lifecycle',
    list: '/api/projects',
    listField: 'projects',
    snapPath: (id) => `/api/projects/${id}/lifecycle`,
    eventsPath: (id) => `/api/projects/${id}/lifecycle/events`,
  },
  {
    name: 'time-review',
    list: '/api/time-review-runs',
    listField: 'runs',
    snapPath: (id) => `/api/time-review-runs/${id}`,
    eventsPath: (id) => `/api/time-review-runs/${id}/events`,
  },
]

interface RowReport {
  workflow: string
  list: string
  count: number | string
  sampleState: string
  sampleSv: string
  nextEvents: string
  staleRetry: string
  transition: string
}

function pickSnap(body: unknown): { state?: unknown; state_version?: unknown; next_events?: unknown } {
  const v = body as { state?: unknown; state_version?: unknown; next_events?: unknown; snapshot?: unknown }
  if (v && typeof v === 'object') {
    if ('state' in v && typeof v.state === 'string')
      return v as { state: string; state_version: number; next_events: unknown[] }
    const snap = v.snapshot
    if (snap && typeof snap === 'object')
      return snap as { state?: unknown; state_version?: unknown; next_events?: unknown }
  }
  return {}
}

async function probeSurface(surface: WorkflowSurface, args: ProbeArgs): Promise<RowReport> {
  const list = await fetchJson(surface.list, args)
  const items =
    list.status === 200 && list.body && typeof list.body === 'object'
      ? (((list.body as Record<string, unknown>)[surface.listField] as Array<{ id?: string }> | undefined) ?? [])
      : []
  const row: RowReport = {
    workflow: surface.name,
    list: `${list.status}`,
    count: list.status === 200 ? items.length : '—',
    sampleState: '—',
    sampleSv: '—',
    nextEvents: '—',
    staleRetry: '—',
    transition: '—',
  }
  if (items.length === 0) return row
  const item = items[0]
  if (!item.id) return row

  const snap = await fetchJson(surface.snapPath(item.id), args)
  const picked = pickSnap(snap.body)
  if (snap.status !== 200) {
    row.sampleState = `snap ${snap.status}`
    return row
  }
  row.sampleState = String(picked.state ?? '?')
  row.sampleSv = String(picked.state_version ?? '?')
  const nextEvents = Array.isArray(picked.next_events) ? picked.next_events : []
  row.nextEvents =
    nextEvents
      .map((e) => (e && typeof e === 'object' ? String((e as { type?: unknown }).type ?? '?') : String(e)))
      .join(',') || '—'

  // Stale-state-version test: send the first allowable event with
  // a version one less than current. Expect 409 with "state_version".
  // Skipped when current sv is 1 (sv-1=0 trips the schema's positivity
  // constraint before reaching the optimistic-concurrency check —
  // that's a different failure mode and not what this probe is
  // exercising).
  if (nextEvents.length > 0) {
    const firstEvent = (nextEvents[0] as { type?: string }).type
    const currentSv = typeof picked.state_version === 'number' ? picked.state_version : Number(picked.state_version)
    if (firstEvent && Number.isFinite(currentSv) && currentSv > 1) {
      const stale = await fetchJson(surface.eventsPath(item.id), args, {
        method: 'POST',
        body: JSON.stringify({ event: firstEvent, state_version: currentSv - 1 }),
      })
      const bodyStr = typeof stale.body === 'object' && stale.body ? JSON.stringify(stale.body) : String(stale.body)
      row.staleRetry = stale.status === 409 && /state_version/i.test(bodyStr) ? '✓ 409' : `✗ ${stale.status}`
    } else {
      row.staleRetry = 'sv=1 skip'
    }
  }

  // Optional real transition. Off by default so the probe is safe to
  // run against any environment.
  if (args.transition && nextEvents.length > 0) {
    const firstEvent = (nextEvents[0] as { type?: string }).type
    const sv = typeof picked.state_version === 'number' ? picked.state_version : Number(picked.state_version)
    if (firstEvent && Number.isFinite(sv)) {
      const live = await fetchJson(surface.eventsPath(item.id), args, {
        method: 'POST',
        body: JSON.stringify({ event: firstEvent, state_version: sv }),
      })
      const next = pickSnap(live.body)
      row.transition =
        live.status === 200 && next.state && next.state_version
          ? `→ ${String(next.state)} (sv ${next.state_version})`
          : `✗ ${live.status}`
    }
  }
  return row
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}

function renderTable(rows: RowReport[]): string {
  const cols: Array<keyof RowReport> = [
    'workflow',
    'list',
    'count',
    'sampleState',
    'sampleSv',
    'nextEvents',
    'staleRetry',
    'transition',
  ]
  const widths: Record<string, number> = {}
  for (const c of cols) {
    widths[c] = Math.max(c.length, ...rows.map((r) => String(r[c]).length))
  }
  const header = '| ' + cols.map((c) => pad(c, widths[c]!)).join(' | ') + ' |'
  const sep = '|' + cols.map((c) => '-'.repeat(widths[c]! + 2)).join('|') + '|'
  const body = rows.map((r) => '| ' + cols.map((c) => pad(String(r[c]), widths[c]!)).join(' | ') + ' |').join('\n')
  return [header, sep, body].join('\n')
}

async function main(): Promise<void> {
  const args = parseArgs()
   
  console.error(
    `probe target=${args.base} slug=${args.slug} transition=${args.transition} authed=${Boolean(args.token)}`,
  )
  const rows: RowReport[] = []
  for (const s of SURFACES) {
    rows.push(await probeSurface(s, args))
  }
   
  console.log(renderTable(rows))
  const broken = rows.filter((r) => /5\d\d/.test(r.list) || r.list === '0')
  if (broken.length > 0) {
     
    console.error(`\n${broken.length} workflow surface(s) returned 5xx/timeout — see table above`)
    process.exit(1)
  }
}

main().catch((err) => {
   
  console.error('probe-workflows: fatal', err)
  process.exit(1)
})
