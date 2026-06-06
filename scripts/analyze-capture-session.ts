#!/usr/bin/env -S npx tsx
import { Pool } from 'pg'
import { createCaptureArtifactAnalysisRunner } from '../apps/worker/src/runners/capture-artifact-analysis.js'
import { createBlueprintStorageGcClient } from '../apps/worker/src/runners/blueprint-storage-gc.js'

type WorkItemRow = {
  id: string
  status: string
  capture_artifact_analysis: Record<string, unknown> | null
}

type CountRow = {
  count: number
}

const ANALYZABLE_KINDS = ['transcript', 'text', 'rrweb', 'canvas_geometry']
const AUDIO_ANALYSIS_MODES = ['off', 'local-whisper'] as const
const VIDEO_ANALYSIS_MODES = ['off', 'frames-only'] as const

function usage() {
  console.log(`Usage:
  CAPTURE_SESSION_ID=<uuid> DATABASE_URL=postgres://... npm run capture:analyze

Runs the deterministic capture artifact analyzer for the capture session's
company, then verifies the session has analysis handoff events and readiness
metadata. In local compose, prefer:

  CAPTURE_SESSION_ID=<uuid> docker compose exec -T -e CAPTURE_SESSION_ID worker npx tsx scripts/analyze-capture-session.ts`)
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required env: ${name}`)
  return value
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage()
    return
  }

  const captureSessionId = requiredEnv('CAPTURE_SESSION_ID')
  const databaseUrl = requiredEnv('DATABASE_URL')
  const pool = new Pool({ connectionString: databaseUrl })
  try {
    const session = await pool.query<{ company_id: string }>(
      `select company_id::text as company_id
         from capture_sessions
        where id = $1::uuid`,
      [captureSessionId],
    )
    const companyId = session.rows[0]?.company_id
    if (!companyId) throw new Error(`Capture session not found: ${captureSessionId}`)

    const storage = await createBlueprintStorageGcClient()
    if (!storage) throw new Error('Object storage is not configured for capture artifact analysis')

    const runner = createCaptureArtifactAnalysisRunner({
      pool,
      storage,
      logger: {
        warn: (obj, msg) => {
          const err = obj.err instanceof Error ? { message: obj.err.message, stack: obj.err.stack } : obj.err
          console.warn(JSON.stringify({ level: 'warn', msg, ...obj, err }))
        },
      },
    })

    const summary = await runner.forceAnalyze(companyId)
    const audioMode = readMode('CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE', AUDIO_ANALYSIS_MODES, 'off')
    const videoMode = readMode('CAPTURE_ARTIFACT_VIDEO_ANALYSIS_MODE', VIDEO_ANALYSIS_MODES, 'off')
    const eligible = await pool.query<CountRow>(
      `select count(*)::int as count
         from capture_artifacts
        where company_id = $1
          and capture_session_id = $2::uuid
          and deleted_at is null
          and not (metadata ? 'derived_from_artifact_id')
          and (
            (
              storage_key is not null
              and (
                kind = any($3::text[])
                or content_type like 'text/%'
                or content_type = 'application/json'
                or ($4::boolean and (kind = 'audio' or content_type like 'audio/%'))
                or ($5::boolean and (kind = 'video' or content_type like 'video/%'))
              )
            )
            or (storage_key is null and uri is not null)
          )`,
      [companyId, captureSessionId, ANALYZABLE_KINDS, audioMode !== 'off', videoMode !== 'off'],
    )
    const handoffEvents = await pool.query<CountRow>(
      `select count(*)::int as count
         from context_handoff_events
        where company_id = $1
          and capture_session_id = $2::uuid
          and actor_ref = 'capture-artifact-analysis'
          and event_type = 'agent.artifact_attached'`,
      [companyId, captureSessionId],
    )
    const workItems = await pool.query<WorkItemRow>(
      `select id::text,
              status,
              metadata -> 'capture_artifact_analysis' as capture_artifact_analysis
         from context_work_items
        where company_id = $1
          and capture_session_id = $2::uuid
        order by created_at asc`,
      [companyId, captureSessionId],
    )

    const eligibleCount = eligible.rows[0]?.count ?? 0
    const analysisEventCount = handoffEvents.rows[0]?.count ?? 0
    const readiness = workItems.rows[0]?.capture_artifact_analysis
    const output = {
      capture_session_id: captureSessionId,
      company_id: companyId,
      analyzer_summary: summary,
      analysis_modes: {
        audio: audioMode,
        video: videoMode,
      },
      eligible_artifact_count: eligibleCount,
      analysis_event_count: analysisEventCount,
      work_items: workItems.rows,
    }
    console.log(JSON.stringify(output, null, 2))

    if (eligibleCount > 0 && analysisEventCount < eligibleCount) {
      throw new Error(`Only ${analysisEventCount}/${eligibleCount} eligible artifacts have analysis events`)
    }
    if (!readiness || readiness.status !== 'ready') {
      throw new Error(`Capture artifact readiness is not ready: ${JSON.stringify(readiness)}`)
    }
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

function readMode<const T extends readonly string[]>(name: string, allowed: T, fallback: T[number]): T[number] {
  const raw = process.env[name]?.trim().toLowerCase()
  return raw && allowed.includes(raw as T[number]) ? (raw as T[number]) : fallback
}
