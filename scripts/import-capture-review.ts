#!/usr/bin/env -S npx tsx
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Pool } from 'pg'
import { setCompanyGuc } from '../apps/worker/src/runner-utils.js'

type Args = {
  captureSessionId: string
  databaseUrl: string
  reviewFile: string
  reviewer: string
  sourceCommand: string | null
  maxChars: number
}

type CaptureSessionRow = {
  company_id: string
}

type WorkItemRow = {
  id: string
}

type EventRow = {
  id: string
  inserted: boolean
}

function usage() {
  console.log(`Usage:
  CAPTURE_SESSION_ID=<uuid> REVIEW_FILE=/path/review.md DATABASE_URL=postgres://... npm run capture:review-import

Options:
  --capture-session-id UUID
  --review-file FILE
  --reviewer gemini|antigravity|operator   default: CAPTURE_REVIEWER or gemini
  --source-command TEXT                    optional command/run id that produced the review
  --max-chars N                            default: 20000

Attaches a Gemini/Antigravity/operator review result back to the finalized
capture work item as a context_handoff_events row. This is the return path for
the multimodal review lane; it does not create a new Mesh task.`)
}

function parseArgs(argv: string[]): Args {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage()
    process.exit(0)
  }
  const captureSessionId = valueAfter(argv, '--capture-session-id') ?? process.env.CAPTURE_SESSION_ID ?? ''
  const reviewFile = valueAfter(argv, '--review-file') ?? process.env.REVIEW_FILE ?? ''
  const databaseUrl = process.env.DATABASE_URL ?? ''
  if (!captureSessionId.trim()) throw new Error('Missing CAPTURE_SESSION_ID or --capture-session-id')
  if (!reviewFile.trim()) throw new Error('Missing REVIEW_FILE or --review-file')
  if (!databaseUrl.trim()) throw new Error('Missing DATABASE_URL')

  const maxCharsRaw = Number(valueAfter(argv, '--max-chars') ?? process.env.CAPTURE_REVIEW_IMPORT_MAX_CHARS ?? 20_000)
  return {
    captureSessionId: captureSessionId.trim(),
    databaseUrl: databaseUrl.trim(),
    reviewFile: path.resolve(reviewFile.trim()),
    reviewer: normalizeReviewer(valueAfter(argv, '--reviewer') ?? process.env.CAPTURE_REVIEWER ?? 'gemini'),
    sourceCommand:
      (valueAfter(argv, '--source-command') ?? process.env.CAPTURE_REVIEW_SOURCE_COMMAND ?? '').trim() || null,
    maxChars: Number.isFinite(maxCharsRaw) ? Math.max(1_000, Math.min(200_000, Math.trunc(maxCharsRaw))) : 20_000,
  }
}

function valueAfter(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name)
  if (idx === -1) return undefined
  return argv[idx + 1]
}

function normalizeReviewer(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'gemini' || normalized === 'antigravity' || normalized === 'operator') return normalized
  throw new Error(`Unsupported reviewer ${value}; expected gemini, antigravity, or operator`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const reviewText = await readFile(args.reviewFile, 'utf8')
  const reviewHash = `sha256:${createHash('sha256').update(reviewText).digest('hex')}`
  const truncated = reviewText.length > args.maxChars
  const reviewMarkdown = truncated ? reviewText.slice(0, args.maxChars) : reviewText
  const pool = new Pool({ connectionString: args.databaseUrl })

  try {
    const session = await pool.query<CaptureSessionRow>(
      `select company_id::text as company_id
         from capture_sessions
        where id = $1::uuid`,
      [args.captureSessionId],
    )
    const companyId = session.rows[0]?.company_id
    if (!companyId) throw new Error(`Capture session not found: ${args.captureSessionId}`)

    const workItems = await pool.query<WorkItemRow>(
      `select id::text
         from context_work_items
        where company_id = $1
          and capture_session_id = $2::uuid
        order by created_at desc
        limit 1`,
      [companyId, args.captureSessionId],
    )
    const workItemId = workItems.rows[0]?.id
    if (!workItemId) throw new Error(`No context work item found for capture session ${args.captureSessionId}`)

    const client = await pool.connect()
    try {
      await client.query('begin')
      await setCompanyGuc(client, companyId)
      const idempotencyKey = `capture_review:${args.captureSessionId}:${args.reviewer}:${reviewHash}`
      const payload = {
        reviewer: args.reviewer,
        review_file: args.reviewFile,
        review_hash: reviewHash,
        review_length: reviewText.length,
        review_truncated: truncated,
        review_markdown: reviewMarkdown,
        source_command: args.sourceCommand,
        imported_at: new Date().toISOString(),
      }
      const inserted = await client.query<EventRow>(
        `insert into context_handoff_events (
           company_id, work_item_id, event_type, actor_kind, actor_ref,
           source_system, payload, metadata, idempotency_key,
           capture_session_id, redaction_version
         ) values (
           $1, $2, 'agent.capture_review_attached', 'agent', $3,
           'capture-review-import', $4::jsonb, $5::jsonb, $6,
           $7::uuid, 'capture-review-import-v1'
         )
         on conflict (company_id, idempotency_key) where idempotency_key is not null do nothing
         returning id::text, true as inserted`,
        [
          companyId,
          workItemId,
          args.reviewer,
          JSON.stringify(payload),
          JSON.stringify({
            source: 'capture_review_import',
            reviewer: args.reviewer,
            review_hash: reviewHash,
            review_file: args.reviewFile,
          }),
          idempotencyKey,
          args.captureSessionId,
        ],
      )
      let row = inserted.rows[0]
      if (!row) {
        const existing = await client.query<EventRow>(
          `select id::text, false as inserted
             from context_handoff_events
            where company_id = $1
              and idempotency_key = $2
            limit 1`,
          [companyId, idempotencyKey],
        )
        row = existing.rows[0]
      }
      await client.query('commit')
      if (!row) throw new Error('Review event insert did not return an id')
      console.log(
        JSON.stringify(
          {
            capture_session_id: args.captureSessionId,
            company_id: companyId,
            work_item_id: workItemId,
            event_id: row.id,
            inserted: row.inserted,
            reviewer: args.reviewer,
            review_hash: reviewHash,
            review_length: reviewText.length,
            review_truncated: truncated,
          },
          null,
          2,
        ),
      )
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
