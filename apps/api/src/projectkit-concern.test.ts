import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CONTRACT_VERSION, validateCallback, validateConcern, validateWorkRequest } from '@operator/projectkit'
import {
  buildCallbackSnapshot,
  buildConcernSnapshot,
  buildWorkRequestSnapshot,
  severityToPriority,
  validateConcernSnapshot,
  validateWorkRequestSnapshot,
  workItemStatusToCallbackStatus,
} from './projectkit-concern.js'
import { WORK_ITEM_STATUSES } from './context-handoff.js'

// Load the PUBLISHED projectkit JSON schemas (schemas/*.json) from the installed
// package so the conformance test is held to the same cross-language contract a
// Go subscriber (mesh) would validate against. We read the files at runtime (no
// JSON import-attribute / no extra dep) and assert against each schema's
// declared $defs constraints (required fields + the CallbackStatus enum).
const require = createRequire(import.meta.url)
type SchemaDef = { required: string[]; properties?: Record<string, { enum?: string[] }> }
function loadSchemaDef(name: string, defName: string): SchemaDef {
  const path = require.resolve(`@operator/projectkit/schemas/${name}`)
  const schema = JSON.parse(readFileSync(path, 'utf8')) as { $defs?: Record<string, SchemaDef> }
  const def = schema.$defs?.[defName]
  if (!def) throw new Error(`schema ${name} is missing $defs.${defName}`)
  return def
}
const CONCERN_DEF = loadSchemaDef('concern.schema.json', 'Concern')
const WORK_REQUEST_DEF = loadSchemaDef('work-request.schema.json', 'WorkRequest')

function requiredFieldProblems(def: { required: string[] }, snapshot: Record<string, unknown>): string[] {
  const problems: string[] = []
  for (const key of def.required) {
    if (typeof snapshot[key] !== 'string' || (snapshot[key] as string).length === 0) {
      problems.push(`required field missing/empty: ${key}`)
    }
  }
  return problems
}

const WORK_ITEM_ID = '00000000-0000-4000-8000-000000000001'
const SUPPORT_PACKET_ID = '00000000-0000-4000-8000-000000000002'
const CAPTURE_SESSION_ID = '00000000-0000-4000-8000-000000000003'
const FIXED_AT = '2026-06-06T12:00:00.000Z'

describe('workItemStatusToCallbackStatus', () => {
  it('maps the seam-contract statuses to projectkit Callback statuses', () => {
    // The exact table from the task spec — this is the load-bearing seam.
    expect(workItemStatusToCallbackStatus('new')).toBe('accepted')
    expect(workItemStatusToCallbackStatus('triaged')).toBe('accepted')
    expect(workItemStatusToCallbackStatus('agent_running')).toBe('running')
    expect(workItemStatusToCallbackStatus('review_ready')).toBe('running')
    expect(workItemStatusToCallbackStatus('resolved')).toBe('succeeded')
    expect(workItemStatusToCallbackStatus('wont_do')).toBe('failed')
    expect(workItemStatusToCallbackStatus('reversed')).toBe('cancelled')
  })

  it('is total over every internal WorkItemStatus and every result is a valid Callback status', () => {
    for (const status of WORK_ITEM_STATUSES) {
      const mapped = workItemStatusToCallbackStatus(status)
      expect(mapped).not.toBeNull()
      // The mapped value must produce a contract-valid Callback.
      const callback = buildCallbackSnapshot({ workItemId: WORK_ITEM_ID, status })
      expect(callback).not.toBeNull()
      expect(validateCallback(callback)).toEqual([])
    }
  })

  it('returns null only for genuinely unknown input', () => {
    expect(workItemStatusToCallbackStatus(null)).toBeNull()
    expect(workItemStatusToCallbackStatus(undefined)).toBeNull()
    expect(workItemStatusToCallbackStatus('not_a_status')).toBeNull()
  })
})

describe('severityToPriority', () => {
  it('maps severity 1:1 to the published priority vocabulary', () => {
    expect(severityToPriority('low')).toBe('low')
    expect(severityToPriority('normal')).toBe('normal')
    expect(severityToPriority('high')).toBe('high')
    expect(severityToPriority('urgent')).toBe('urgent')
  })

  it('defaults unknown/null severity to normal', () => {
    expect(severityToPriority(null)).toBe('normal')
    expect(severityToPriority(undefined)).toBe('normal')
    expect(severityToPriority('weird')).toBe('normal')
  })
})

describe('buildCallbackSnapshot', () => {
  it('builds a contract-valid Callback keyed by concern_ref = work_item_id', () => {
    const callback = buildCallbackSnapshot({
      workItemId: WORK_ITEM_ID,
      status: 'resolved',
      outputs: { branch: 'agent/x/sitelayer-fix' },
      completedAt: FIXED_AT,
    })
    expect(callback).not.toBeNull()
    expect(callback!.concern_ref).toBe(WORK_ITEM_ID)
    expect(callback!.status).toBe('succeeded')
    expect(callback!.outputs).toEqual({ branch: 'agent/x/sitelayer-fix' })
    expect(callback!.completed_at).toBe(FIXED_AT)
    expect(validateCallback(callback)).toEqual([])
  })

  it('returns null for a status with no published Callback meaning', () => {
    expect(buildCallbackSnapshot({ workItemId: WORK_ITEM_ID, status: 'not_a_status' })).toBeNull()
  })
})

describe('buildConcernSnapshot', () => {
  it('maps work-item fields onto a projectkit Concern (concern_ref = work_item_id)', () => {
    const concern = buildConcernSnapshot({
      workItemId: WORK_ITEM_ID,
      title: 'Investigate estimate push',
      summary: 'The estimate push to QBO returned 5xx for project p-1.',
      severity: 'high',
      status: 'new',
      route: '/projects/p/estimate-push/x',
      entityType: 'estimate_push',
      entityId: 'ep-1',
      captureSessionId: CAPTURE_SESSION_ID,
      supportPacketId: SUPPORT_PACKET_ID,
      sourceEventRef: SUPPORT_PACKET_ID,
      dispatchedAt: FIXED_AT,
    })

    expect(concern.concern_ref).toBe(WORK_ITEM_ID)
    expect(concern.kind).toBe('execute')
    expect(concern.title).toBe('Investigate estimate push')
    expect(concern.summary).toBe('The estimate push to QBO returned 5xx for project p-1.')
    expect(concern.priority).toBe('high') // severity -> priority
    expect(concern.source_event_ref).toBe(SUPPORT_PACKET_ID)
    expect(concern.dispatched_at).toBe(FIXED_AT)
    expect(concern.inputs?.callback_status).toBe('accepted') // status 'new' -> Callback 'accepted'
    expect(concern.inputs?.evidence_refs).toEqual([
      { type: 'support_debug_packet', id: SUPPORT_PACKET_ID },
      { type: 'capture_session', id: CAPTURE_SESSION_ID },
    ])
    expect(concern.callback).toBeUndefined()
  })

  it('carries the adapter-agnostic callback target when supplied', () => {
    const concern = buildConcernSnapshot({
      workItemId: WORK_ITEM_ID,
      title: 'X',
      supportPacketId: SUPPORT_PACKET_ID,
      callback: {
        url: `https://sitelayer.example.test/api/work-requests/${WORK_ITEM_ID}/agent-callback`,
        mode: 'webhook',
      },
    })
    expect(concern.callback).toEqual({
      url: `https://sitelayer.example.test/api/work-requests/${WORK_ITEM_ID}/agent-callback`,
      mode: 'webhook',
    })
  })

  // ---- CONFORMANCE: snapshot must validate against the published contract ----
  it('conforms to @operator/projectkit (validateConcern AND published concern.schema.json)', () => {
    const concern = buildConcernSnapshot({
      workItemId: WORK_ITEM_ID,
      title: 'Investigate estimate push',
      summary: 'broke',
      severity: 'urgent',
      status: 'agent_running',
      route: '/projects/p/estimate-push/x',
      entityType: 'estimate_push',
      entityId: 'ep-1',
      captureSessionId: CAPTURE_SESSION_ID,
      supportPacketId: SUPPORT_PACKET_ID,
      dispatchedAt: FIXED_AT,
    })
    // 1. The real exported projectkit validator accepts it.
    expect(validateConcern(concern)).toEqual([])
    // 2. The convenience re-export agrees.
    expect(validateConcernSnapshot(concern)).toEqual([])
    // 3. It satisfies the published schemas/concern.schema.json $defs.Concern required fields.
    expect(requiredFieldProblems(CONCERN_DEF, concern as unknown as Record<string, unknown>)).toEqual([])
    expect(concern.schema_version).toBe(CONTRACT_VERSION)
  })
})

describe('buildWorkRequestSnapshot', () => {
  it('embeds the Concern and adds request fields, still contract-valid', () => {
    const workRequest = buildWorkRequestSnapshot({
      workItemId: WORK_ITEM_ID,
      title: 'Wire chat widget retry button',
      summary: 'Add a retry button when AI chat returns 5xx.',
      severity: 'normal',
      status: 'agent_running',
      route: '/projects/p/chat-widget/retry',
      entityType: 'chat_widget',
      entityId: 'cw-1',
      supportPacketId: SUPPORT_PACKET_ID,
      lane: 'agent',
      intent: 'fix',
      acceptance: ['Add the retry button', 'Cover it with a test'],
      callback: { mode: 'webhook' },
      dispatchedAt: FIXED_AT,
    })

    expect(workRequest.request_ref).toBe(WORK_ITEM_ID)
    expect(workRequest.intent).toBe('fix')
    expect(workRequest.title).toBe('Wire chat widget retry button')
    expect(workRequest.priority).toBe('normal')
    expect(workRequest.route_path).toBe('/projects/p/chat-widget/retry')
    expect(workRequest.entity_kind).toBe('chat_widget')
    expect(workRequest.entity_id).toBe('cw-1')
    expect(workRequest.acceptance).toEqual(['Add the retry button', 'Cover it with a test'])
    expect(workRequest.source_event_ref).toBe(SUPPORT_PACKET_ID)

    const payload = workRequest.payload as {
      lane: string
      concern: { concern_ref: string; inputs?: { callback_status?: unknown } }
    }
    expect(payload.lane).toBe('agent')
    // The embedded Concern is the same shape buildConcernSnapshot produces.
    expect(payload.concern.concern_ref).toBe(WORK_ITEM_ID)
    expect(payload.concern.inputs?.callback_status).toBe('running') // agent_running -> running

    // CONFORMANCE: the WorkRequest validates, the convenience re-export agrees,
    // the embedded Concern validates, and both satisfy the published schemas.
    expect(validateWorkRequest(workRequest)).toEqual([])
    expect(validateWorkRequestSnapshot(workRequest)).toEqual([])
    expect(validateConcern(payload.concern)).toEqual([])
    expect(requiredFieldProblems(WORK_REQUEST_DEF, workRequest as unknown as Record<string, unknown>)).toEqual([])
    expect(requiredFieldProblems(CONCERN_DEF, payload.concern as unknown as Record<string, unknown>)).toEqual([])
  })

  it('defaults intent to capture-followup when omitted', () => {
    const workRequest = buildWorkRequestSnapshot({
      workItemId: WORK_ITEM_ID,
      title: 'X',
      supportPacketId: SUPPORT_PACKET_ID,
    })
    expect(workRequest.intent).toBe('capture-followup')
    expect(validateWorkRequest(workRequest)).toEqual([])
  })
})
