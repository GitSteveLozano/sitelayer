// incident — turn a (possibly vague) incident report into an LLM-debuggable
// bundle: the error, the timeline of events that led up to it, the request_id /
// trace_id, and the Sentry trace links. Works from a request_id, a trace_id, or
// just {company/email + time window (+ route + error text)} — which is all an
// emailed report usually has.
//
//   DATABASE_URL=... npx tsx scripts/incident.ts --request-id <uuid>
//   DATABASE_URL=... npx tsx scripts/incident.ts --trace-id <hex>
//   DATABASE_URL=... npx tsx scripts/incident.ts --email a@co.com --since "2026-06-06T14:00" --until "2026-06-06T15:00" --route /estimate
//   DATABASE_URL=... npx tsx scripts/incident.ts --company la-operations --around "2026-06-06T14:30" --window 30
//
// Optional Sentry enrichment: set SENTRY_ORG + SENTRY_AUTH_TOKEN (+ SENTRY_HOST).
// Output is markdown on stdout — pipe to a file or paste straight to an LLM.
import { Client } from 'pg'

type Args = Record<string, string | boolean>
function parseArgs(argv: string[]): Args {
  const a: Args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (t?.startsWith('--')) {
      const k = t.slice(2)
      const v = argv[i + 1]
      if (v && !v.startsWith('--')) {
        a[k] = v
        i += 1
      } else a[k] = true
    }
  }
  return a
}

const args = parseArgs(process.argv.slice(2))
const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('set DATABASE_URL (read access to the target tier DB)')
  process.exit(1)
}

function isoOr(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString()
}

// resolve the time window
function resolveWindow(): { since: string; until: string } {
  if (args.around) {
    const c = new Date(String(args.around))
    const w = Number(args.window ?? 30) * 60_000
    return { since: new Date(c.getTime() - w).toISOString(), until: new Date(c.getTime() + w).toISOString() }
  }
  const until = isoOr(args.until, new Date().toISOString())
  const since = isoOr(args.since, new Date(new Date(until).getTime() - 2 * 3600_000).toISOString())
  return { since, until }
}

type Row = Record<string, unknown>
type Ev = {
  at: string
  source: string
  line: string
  error?: string | undefined
  request_id?: string | undefined
  trace?: string | undefined
}

const fmt = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const tt = (iso: unknown): string => {
  const d = new Date(String(iso))
  return Number.isNaN(d.getTime()) ? fmt(iso) : d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
}
const traceOf = (sentry_trace: unknown): string | undefined => {
  const s = fmt(sentry_trace)
  return s ? s.split('-')[0] || undefined : undefined
}

async function main(): Promise<void> {
  const db = new Client({ connectionString: DATABASE_URL })
  await db.connect()
  const out: string[] = []
  const log = (s = '') => out.push(s)

  // 1) resolve company
  let companyId: string | null = (typeof args['company-id'] === 'string' && args['company-id']) || null
  let companySlug = ''
  if (!companyId && typeof args.company === 'string') {
    const r = await db.query('SELECT id, slug FROM companies WHERE slug = $1', [args.company])
    companyId = r.rows[0]?.id ?? null
    companySlug = r.rows[0]?.slug ?? String(args.company)
  }
  if (!companyId && typeof args.email === 'string') {
    const r = await db.query(
      `SELECT c.id, c.slug FROM clerk_users u
       JOIN company_memberships m ON m.clerk_user_id = u.clerk_user_id
       JOIN companies c ON c.id = m.company_id
       WHERE LOWER(u.email) = LOWER($1) AND u.deleted_at IS NULL`,
      [args.email],
    )
    if (r.rows.length === 1) {
      companyId = r.rows[0].id
      companySlug = r.rows[0].slug
    } else if (r.rows.length > 1) {
      log(
        `> email ${args.email} maps to ${r.rows.length} companies: ${r.rows.map((x) => x.slug).join(', ')} — pass --company <slug>`,
      )
    }
  }

  const reqId = typeof args['request-id'] === 'string' ? args['request-id'] : null
  let traceId = typeof args['trace-id'] === 'string' ? args['trace-id'] : null
  const { since, until } = resolveWindow()
  const routeLike = typeof args.route === 'string' ? `%${args.route}%` : null
  const errLike = typeof args.error === 'string' ? `%${args.error}%` : null

  log(`# Incident bundle`)
  log('')
  log(`- generated: ${isoOr(args._now, new Date().toISOString())}`)
  log(
    `- input: ${JSON.stringify({ requestId: reqId, traceId, company: companySlug || args.company || args.email, since, until, route: args.route, error: args.error })}`,
  )
  if (companyId) log(`- company: ${companySlug} (${companyId})`)
  else log(`- company: UNRESOLVED (queries below run global within the window — narrow with --company/--email)`)
  log('')

  // helper: run a query, return rows, never throw the whole bundle
  const q = async (sql: string, params: unknown[]): Promise<Row[]> => {
    try {
      return (await db.query(sql, params)).rows
    } catch (e) {
      log(`> (query skipped: ${(e as Error).message})`)
      return []
    }
  }

  // 2) gather rows. Two modes: by-id (direct), or window.
  const cWhere = companyId ? 'company_id = $1' : 'TRUE'
  const cp = companyId ? [companyId] : []
  const events: Ev[] = []
  const errors: Ev[] = []
  const candidates = new Map<string, { errors: number; routes: Set<string>; trace?: string }>()

  const addCand = (rid: unknown, tr: unknown, isErr: boolean, route?: unknown) => {
    const id = fmt(rid)
    if (!id) return
    const c = candidates.get(id) ?? { errors: 0, routes: new Set<string>() }
    if (isErr) c.errors += 1
    if (route) c.routes.add(fmt(route))
    const t = traceOf(tr)
    if (t) c.trace = t
    candidates.set(id, c)
  }

  if (reqId || traceId) {
    // direct: pull rows matching the id, derive window from them
    const idCol = reqId ? 'request_id' : 'sentry_trace'
    const idVal = reqId ? reqId : `${traceId}%`
    const op = reqId ? '=' : 'LIKE'
    for (const [tbl, cols] of [
      ['audit_events', 'created_at, action, entity_type, entity_id, actor_user_id, request_id, sentry_trace'],
      ['mutation_outbox', 'created_at, status, entity_type, entity_id, mutation_type, error, request_id, sentry_trace'],
      ['sync_events', 'created_at, status, direction, entity_type, entity_id, error, request_id, sentry_trace'],
    ] as const) {
      const rows = await q(`SELECT ${cols} FROM ${tbl} WHERE ${idCol} ${op} $1 ORDER BY created_at ASC LIMIT 500`, [
        idVal,
      ])
      for (const r of rows) {
        if (!traceId && r.sentry_trace) traceId = traceOf(r.sentry_trace) ?? traceId
        const isErr = r.status === 'failed' || Boolean(r.error)
        const line =
          `${tbl} ${fmt(r.action ?? r.mutation_type ?? r.direction ?? '')} ${fmt(r.entity_type)} ${fmt(r.entity_id)} ${fmt(r.status ?? '')}`.trim()
        const ev: Ev = {
          at: fmt(r.created_at),
          source: tbl,
          line,
          request_id: fmt(r.request_id),
          trace: traceOf(r.sentry_trace),
        }
        if (isErr) {
          ev.error = fmt(r.error)
          errors.push(ev)
        }
        events.push(ev)
        addCand(r.request_id, r.sentry_trace, isErr, r.entity_type)
      }
    }
  } else {
    // window mode: pull the company's timeline + errors in the window
    const audit = await q(
      `SELECT created_at, action, entity_type, entity_id, actor_user_id, request_id, sentry_trace
       FROM audit_events WHERE ${cWhere} AND created_at BETWEEN $${cp.length + 1} AND $${cp.length + 2} ORDER BY created_at ASC LIMIT 1000`,
      [...cp, since, until],
    )
    for (const r of audit) {
      events.push({
        at: fmt(r.created_at),
        source: 'audit',
        line: `${fmt(r.action)} ${fmt(r.entity_type)} ${fmt(r.entity_id)} by ${fmt(r.actor_user_id)}`,
        request_id: fmt(r.request_id),
        trace: traceOf(r.sentry_trace),
      })
      addCand(r.request_id, r.sentry_trace, false, r.entity_type)
    }
    for (const [tbl, extra] of [
      ['mutation_outbox', 'mutation_type'],
      ['sync_events', 'direction'],
    ] as const) {
      const errFilter = errLike ? `AND error ILIKE $${cp.length + 3}` : ''
      const rows = await q(
        `SELECT created_at, status, entity_type, entity_id, ${extra} AS kind, error, request_id, sentry_trace
         FROM ${tbl} WHERE ${cWhere} AND created_at BETWEEN $${cp.length + 1} AND $${cp.length + 2} ${errFilter} ORDER BY created_at ASC LIMIT 1000`,
        errLike ? [...cp, since, until, errLike] : [...cp, since, until],
      )
      for (const r of rows) {
        const isErr = r.status === 'failed' || Boolean(r.error)
        const ev: Ev = {
          at: fmt(r.created_at),
          source: tbl,
          line: `${fmt(r.kind)} ${fmt(r.entity_type)} ${fmt(r.entity_id)} ${fmt(r.status)}`.trim(),
          request_id: fmt(r.request_id),
          trace: traceOf(r.sentry_trace),
        }
        if (isErr) {
          ev.error = fmt(r.error)
          errors.push(ev)
        }
        events.push(ev)
        addCand(r.request_id, r.sentry_trace, isErr, r.entity_type)
      }
    }
    // capture sessions + work items in the window (route context the email may cite)
    const caps = await q(
      `SELECT started_at, route_path, mode, status, app_build_sha FROM capture_sessions
       WHERE ${cWhere} AND started_at BETWEEN $${cp.length + 1} AND $${cp.length + 2} ${routeLike ? `AND route_path ILIKE $${cp.length + 3}` : ''} ORDER BY started_at ASC LIMIT 200`,
      routeLike ? [...cp, since, until, routeLike] : [...cp, since, until],
    )
    for (const r of caps)
      events.push({
        at: fmt(r.started_at),
        source: 'capture',
        line: `session ${fmt(r.mode)} on ${fmt(r.route_path)} (${fmt(r.status)}, build ${fmt(r.app_build_sha)})`,
      })
    const wis = await q(
      `SELECT created_at, route, title, status, lane, severity, entity_type, entity_id FROM context_work_items
       WHERE ${cWhere} AND created_at BETWEEN $${cp.length + 1} AND $${cp.length + 2} ${routeLike ? `AND route ILIKE $${cp.length + 3}` : ''} ORDER BY created_at ASC LIMIT 200`,
      routeLike ? [...cp, since, until, routeLike] : [...cp, since, until],
    )
    for (const r of wis)
      events.push({
        at: fmt(r.created_at),
        source: 'work_item',
        line: `[${fmt(r.severity)}/${fmt(r.lane)}] "${fmt(r.title)}" on ${fmt(r.route)} (${fmt(r.status)})`,
      })
  }

  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

  // 3) errors first
  log(`## Errors found (${errors.length})`)
  if (!errors.length)
    log(
      '- none in scope (the failure may be a pure 5xx with no DB-side error row — check the Sentry trace + container logs below)',
    )
  for (const e of errors)
    log(
      `- \`${tt(e.at)}\` **${e.source}** ${e.line} — ERROR: ${e.error || '(status failed)'}  ${e.request_id ? `[req ${e.request_id}]` : ''}${e.trace ? ` [trace ${e.trace}]` : ''}`,
    )
  log('')

  // 4) candidate requests/traces (vague mode)
  if (!reqId && !traceId && candidates.size) {
    const ranked = [...candidates.entries()].sort((a, b) => b[1].errors - a[1].errors).slice(0, 15)
    log(`## Candidate requests in window (ranked by errors)`)
    for (const [id, c] of ranked)
      log(
        `- req \`${id}\`${c.trace ? ` trace \`${c.trace}\`` : ''} — errors:${c.errors} routes:${[...c.routes].slice(0, 4).join(',')}`,
      )
    log('')
    log(`> re-run with \`--request-id <id>\` (or \`--trace-id <trace>\`) to focus a single request.`)
    log('')
  }

  // 5) timeline
  log(`## Timeline — events leading up to it (${events.length})`)
  for (const e of events)
    log(
      `- \`${tt(e.at)}\` ${e.source}: ${e.line}${e.error ? ` — **ERROR: ${e.error}**` : ''}${e.request_id ? `  _(req ${e.request_id})_` : ''}`,
    )
  log('')

  // 6) Sentry enrichment
  log(`## Trace / Sentry`)
  const org = process.env.SENTRY_ORG
  const host = process.env.SENTRY_HOST || 'sentry.io'
  if (traceId) {
    log(`- trace_id: \`${traceId}\``)
    if (org) {
      log(`- trace view: https://${org}.${host.replace(/^sentry\./, '')}/performance/trace/${traceId}/`)
      log(`- logs (by trace): https://${org}.${host.replace(/^sentry\./, '')}/explore/logs/?query=trace%3A${traceId}`)
    }
    if (org && process.env.SENTRY_AUTH_TOKEN) {
      try {
        const res = await fetch(`https://${host}/api/0/organizations/${org}/events-trace/${traceId}/`, {
          headers: { authorization: `Bearer ${process.env.SENTRY_AUTH_TOKEN}` },
          signal: AbortSignal.timeout(8000),
        })
        if (res.ok) {
          const data = (await res.json()) as unknown
          const spans = Array.isArray(data) ? data : ((data as Row)?.transactions as Row[]) || []
          log(`- fetched ${Array.isArray(spans) ? spans.length : 0} trace nodes from Sentry:`)
          log('```json')
          log(JSON.stringify(data, null, 2).slice(0, 6000))
          log('```')
        } else log(`- Sentry events-trace: HTTP ${res.status}`)
      } catch (e) {
        log(`- Sentry fetch failed: ${(e as Error).message}`)
      }
    } else log(`- (set SENTRY_ORG + SENTRY_AUTH_TOKEN to inline the trace spans + logs here)`)
  } else
    log(
      `- no trace_id resolved (no enqueued/audited row carried a sentry_trace). Use the Sentry UI by time+route, or the container logs below.`,
    )
  log('')

  // 7) go deeper
  log(`## Go deeper`)
  const focus = reqId || (candidates.size ? [...candidates.keys()][0] : null)
  if (focus)
    log(
      `- joined trace+queue+audit: \`GET /api/debug/traces/${focus}?by=request_id\` (Bearer DEBUG_TRACE_TOKEN; prod needs DEBUG_ALLOW_PROD=1)`,
    )
  log(
    `- raw app logs (ephemeral, prod droplet): \`ssh sitelayer@165.245.230.3 'docker logs sitelayer-api-1 2>&1 | grep ${focus || '<request_id>'}'\``,
  )
  log(`- worker logs: same with \`sitelayer-worker-1\``)
  log('')
  log(`---`)
  log(
    `_Paste this whole bundle to an LLM: "Here is an incident bundle from sitelayer. The error is in the Errors section; the Timeline is what happened leading up to it. Diagnose the likely root cause and propose a fix."_`,
  )

  await db.end()
  process.stdout.write(out.join('\n') + '\n')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e)
  process.exit(1)
})
