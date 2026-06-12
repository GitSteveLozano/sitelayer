import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CONTRACT_VERSION,
  validateCallback,
  validateConcern,
  validateProjectEvent,
  validateWorkRequest,
  WORK_ITEM_STATUSES,
} from '@operator/projectkit'
import {
  buildCallbackSnapshot,
  buildConcernSnapshot,
  buildProjectEventEnvelope,
  buildProjectEventSnapshot,
  buildWorkRequestSnapshot,
  isTerminalCallbackStatus,
  normalizeCallbackArtifacts,
  severityToPriority,
  validateCallbackSnapshot,
  validateConcernSnapshot,
  validateWorkRequestSnapshot,
  workItemStatusToCallbackStatus,
} from './index.js'

// Test fixture: the sitelayer agent-callback event vocabulary. Source of truth
// is apps/api/src/context-handoff.ts (AGENT_CALLBACK_EVENT_TYPES); mirrored here
// as a literal so this contract test lives with the bridge it exercises and has
// no cross-app import. If context-handoff.ts adds an event type, add it here.
const AGENT_CALLBACK_EVENT_TYPES = [
  'agent.dispatch_acknowledged',
  'agent.message_received',
  'agent.artifact_attached',
  'agent.proposal_ready',
  'agent.completed',
  'human.review_requested',
] as const

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

// callback.schema.json is a flat top-level schema (no $defs wrapper), so load
// its root required[] + the status enum directly. This holds the inbound-leg
// snapshot to the same cross-language Callback contract a Go subscriber reads.
function loadRootSchema(name: string): SchemaDef {
  const path = require.resolve(`@operator/projectkit/schemas/${name}`)
  return JSON.parse(readFileSync(path, 'utf8')) as SchemaDef
}
const CALLBACK_DEF = loadRootSchema('callback.schema.json')

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

// The addressed-dispatch surface the apps/api emit sites route through
// (capture-sessions.ts `capan:<session>` / admin-work-requests.ts
// `wi:<id>:<audience>`): concern_ref override, v1.4.0 audience / assignee /
// acceptance, and caller-supplied executor inputs.
describe('buildConcernSnapshot — addressed dispatch (concernRef / audience / assignee / acceptance / inputs)', () => {
  it('honors a concernRef override while keeping the work-item linkage in inputs', () => {
    const concern = buildConcernSnapshot({
      workItemId: WORK_ITEM_ID,
      concernRef: `capan:${CAPTURE_SESSION_ID}`,
      title: 'Analyze capture',
      captureSessionId: CAPTURE_SESSION_ID,
      dispatchedAt: FIXED_AT,
    })
    expect(concern.concern_ref).toBe(`capan:${CAPTURE_SESSION_ID}`)
    // The override must never sever the join back to the work item.
    expect(concern.inputs?.work_item_id).toBe(WORK_ITEM_ID)
    expect(validateConcern(concern)).toEqual([])
  })

  it('defaults concern_ref to workItemId when concernRef is absent/blank', () => {
    expect(buildConcernSnapshot({ workItemId: WORK_ITEM_ID, title: 'X' }).concern_ref).toBe(WORK_ITEM_ID)
    expect(buildConcernSnapshot({ workItemId: WORK_ITEM_ID, title: 'X', concernRef: '  ' }).concern_ref).toBe(
      WORK_ITEM_ID,
    )
    expect(buildConcernSnapshot({ workItemId: WORK_ITEM_ID, title: 'X', concernRef: null }).concern_ref).toBe(
      WORK_ITEM_ID,
    )
  })

  it('carries the v1.4.0 audience / assignee / acceptance fields, contract-valid', () => {
    const concern = buildConcernSnapshot({
      workItemId: WORK_ITEM_ID,
      concernRef: `wi:${WORK_ITEM_ID}:steve`,
      title: 'Fix the thing',
      audience: 'steve',
      assignee: 'steve',
      acceptance: ['Reproduce the bug', 'Land the fix with a test'],
      dispatchedAt: FIXED_AT,
    })
    expect(concern.audience).toBe('steve')
    expect(concern.assignee).toBe('steve')
    expect(concern.acceptance).toEqual(['Reproduce the bug', 'Land the fix with a test'])
    expect(validateConcern(concern)).toEqual([])
    expect(requiredFieldProblems(CONCERN_DEF, concern as unknown as Record<string, unknown>)).toEqual([])
  })

  it('omits audience / assignee / acceptance when blank or empty (never empty-string fields)', () => {
    const concern = buildConcernSnapshot({
      workItemId: WORK_ITEM_ID,
      title: 'X',
      audience: '  ',
      assignee: null,
      acceptance: [],
    })
    expect(concern.audience).toBeUndefined()
    expect(concern.assignee).toBeUndefined()
    expect(concern.acceptance).toBeUndefined()
    expect(validateConcern(concern)).toEqual([])
  })

  it('merges caller inputs OVER the derived defaults (caller keys win; defaults survive)', () => {
    const concern = buildConcernSnapshot({
      workItemId: WORK_ITEM_ID,
      title: 'Analyze capture',
      status: 'new',
      route: '/derived/route',
      captureSessionId: CAPTURE_SESSION_ID,
      inputs: {
        capture_session_id: 'caller-wins', // collision: caller value wins
        url: '/caller/url', // caller-only key travels
        artifacts: [{ kind: 'rrweb', ref: 'art-1' }],
      },
    })
    expect(concern.inputs?.capture_session_id).toBe('caller-wins')
    expect(concern.inputs?.url).toBe('/caller/url')
    expect(concern.inputs?.artifacts).toEqual([{ kind: 'rrweb', ref: 'art-1' }])
    // Derived defaults the caller did not override are still present.
    expect(concern.inputs?.route).toBe('/derived/route')
    expect(concern.inputs?.callback_status).toBe('accepted')
    expect(concern.inputs?.work_item_id).toBe(WORK_ITEM_ID)
    expect(validateConcern(concern)).toEqual([])
  })

  it('mirrors audience / assignee / acceptance onto the WorkRequest (and its embedded Concern)', () => {
    const workRequest = buildWorkRequestSnapshot({
      workItemId: WORK_ITEM_ID,
      title: 'X',
      audience: 'capture-analyzer',
      assignee: 'capture-analyzer',
      acceptance: ['Return the analysis'],
      dispatchedAt: FIXED_AT,
    })
    expect(workRequest.audience).toBe('capture-analyzer')
    expect(workRequest.assignee).toBe('capture-analyzer')
    expect(workRequest.acceptance).toEqual(['Return the analysis'])
    const embedded = (workRequest.payload as { concern: { audience?: string; assignee?: string } }).concern
    expect(embedded.audience).toBe('capture-analyzer')
    expect(embedded.assignee).toBe('capture-analyzer')
    expect(validateWorkRequest(workRequest)).toEqual([])
  })

  it('CONTRACT ENFORCEMENT: an invalid snapshot throws at the builder instead of travelling', () => {
    // Empty workItemId -> empty concern_ref -> the published validator flags it
    // and assertContractValid converts that into a loud throw.
    expect(() => buildConcernSnapshot({ workItemId: '', title: 'X' })).toThrow(/contract validation/)
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

// The ref-only dispatch surface (no context_work_item exists; the caller's ref
// IS the producer-stable idempotency key — the ops-diagnostics emit site).
describe('ref-only dispatch (no workItemId)', () => {
  const OPSDIAG_REF = 'opsdiag:11111111-1111-4111-8111-111111111111:dispatch_agent_review'

  it('builds a contract-valid Concern from concernRef alone, carrying only caller inputs', () => {
    const concern = buildConcernSnapshot({
      concernRef: OPSDIAG_REF,
      title: 'Dispatch agent review for onsite diagnostics',
      severity: 'high',
      audience: 'onsite-diagnostics',
      assignee: 'onsite-diagnostics',
      sourceEventRef: 'ops_diagnostic_session:11111111-1111-4111-8111-111111111111',
      dispatchedAt: FIXED_AT,
      acceptance: ['Inspect the plan.'],
      inputs: { requested_action: 'dispatch_agent_review', requested_by: 'user_99' },
    })
    expect(concern.concern_ref).toBe(OPSDIAG_REF)
    expect(concern.kind).toBe('execute')
    expect(concern.priority).toBe('high')
    // No work item -> no derived work-item linkage keys, ONLY the caller inputs.
    expect(concern.inputs).toEqual({ requested_action: 'dispatch_agent_review', requested_by: 'user_99' })
    expect(validateConcern(concern)).toEqual([])
  })

  it('CONTRACT ENFORCEMENT: throws when neither workItemId nor concernRef yields a ref', () => {
    expect(() => buildConcernSnapshot({ title: 'X' })).toThrow(/contract validation/)
    expect(() => buildConcernSnapshot({ title: 'X', concernRef: '  ' })).toThrow(/contract validation/)
  })

  it('mirrors the ref onto request_ref and carries sensitivity + merged payload (concern embed survives)', () => {
    const workRequest = buildWorkRequestSnapshot({
      concernRef: OPSDIAG_REF,
      title: 'Dispatch agent review for onsite diagnostics',
      severity: 'normal',
      intent: 'review',
      route: '/ops',
      entityType: 'ops_diagnostic_session',
      entityId: '11111111-1111-4111-8111-111111111111',
      sensitivity: 'internal',
      dispatchedAt: FIXED_AT,
      payload: { requested_action: 'dispatch_agent_review', concern: 'caller-cannot-clobber' },
    })
    expect(workRequest.request_ref).toBe(OPSDIAG_REF)
    expect(workRequest.sensitivity).toBe('internal')
    expect(workRequest.route_path).toBe('/ops')
    const payload = workRequest.payload as Record<string, unknown>
    expect(payload.requested_action).toBe('dispatch_agent_review')
    expect(payload.lane).toBeNull()
    // The embedded Concern always survives the payload merge.
    const embedded = payload.concern as { concern_ref: string }
    expect(embedded.concern_ref).toBe(OPSDIAG_REF)
    expect(validateConcern(embedded)).toEqual([])
    expect(validateWorkRequest(workRequest)).toEqual([])
  })

  it('keeps request_ref = work_item_id when no concernRef override is supplied (existing emit sites)', () => {
    const workRequest = buildWorkRequestSnapshot({ workItemId: WORK_ITEM_ID, title: 'X' })
    expect(workRequest.request_ref).toBe(WORK_ITEM_ID)
  })
})

describe('buildProjectEventSnapshot', () => {
  it('builds a contract-valid ProjectEvent and stamps schema_version = CONTRACT_VERSION', () => {
    const event = buildProjectEventSnapshot({
      eventType: 'sitelayer.ops_diagnostic.dispatch_agent_review.requested',
      occurredAt: FIXED_AT,
      domain: 'workflow_event',
      outcome: 'requested',
      environment: 'test',
      sourceSurface: 'mobile_ops',
      routePath: '/ops',
      actorKind: 'operator',
      principalId: 'user_99',
      entityKind: 'ops_diagnostic_session',
      entityId: '11111111-1111-4111-8111-111111111111',
      action: 'dispatch_agent_review',
      summary: 'Operator requested Dispatch agent review from Mobile Ops.',
      sensitivity: 'internal',
      redactionStatus: 'summary_only',
      payload: { work_request: { request_ref: 'r-1' } },
    })
    expect(event.schema_version).toBe(CONTRACT_VERSION)
    expect(event.event_type).toBe('sitelayer.ops_diagnostic.dispatch_agent_review.requested')
    expect(event.project_key).toBe('sitelayer') // default
    expect(event.occurred_at).toBe(FIXED_AT)
    expect(event.domain).toBe('workflow_event')
    expect(event.outcome).toBe('requested')
    expect(event.principal_id).toBe('user_99')
    expect(event.entity_id).toBe('11111111-1111-4111-8111-111111111111')
    expect(event.redaction_status).toBe('summary_only')
    expect(event.payload).toEqual({ work_request: { request_ref: 'r-1' } })
    expect(validateProjectEvent(event)).toEqual([])
  })

  it('a null principalId is meaningful and travels; blank optionals are omitted', () => {
    const event = buildProjectEventSnapshot({
      eventType: 'sitelayer.x.happened',
      occurredAt: FIXED_AT,
      principalId: null,
      environment: '  ',
      summary: null,
    })
    expect('principal_id' in event).toBe(true)
    expect(event.principal_id).toBeNull()
    expect('environment' in event).toBe(false)
    expect('summary' in event).toBe(false)
    expect('entity_id' in event).toBe(false) // undefined -> omitted
    expect(validateProjectEvent(event)).toEqual([])
  })

  it('CONTRACT ENFORCEMENT: an invalid snapshot throws at the builder instead of travelling', () => {
    expect(() => buildProjectEventSnapshot({ eventType: '' })).toThrow(/contract validation/)
    expect(() => buildProjectEventSnapshot({ eventType: 'sitelayer.x', occurredAt: 'not-a-timestamp' })).toThrow(
      /contract validation/,
    )
  })
})

describe('buildProjectEventEnvelope', () => {
  const validEvent = () => buildProjectEventSnapshot({ eventType: 'sitelayer.x.happened', occurredAt: FIXED_AT })

  it('wraps validated events and stamps contract_version (the bridge owns the stamp)', () => {
    const envelope = buildProjectEventEnvelope({
      emittedAt: FIXED_AT,
      producer: { name: 'sitelayer.ops-diagnostics' },
      deliveryId: 'opsdiag:s-1:dispatch_agent_review:e-1',
      events: [validEvent()],
    })
    expect(envelope.contract_version).toBe(CONTRACT_VERSION)
    expect(envelope.project_key).toBe('sitelayer') // default
    expect(envelope.emitted_at).toBe(FIXED_AT)
    expect(envelope.producer).toEqual({ name: 'sitelayer.ops-diagnostics' }) // no empty version key
    expect(envelope.delivery_id).toBe('opsdiag:s-1:dispatch_agent_review:e-1')
    expect(envelope.events).toHaveLength(1)
  })

  it('omits delivery_id when blank and carries producer.version when supplied', () => {
    const envelope = buildProjectEventEnvelope({
      producer: { name: 'sitelayer.api', version: '1.0.0' },
      deliveryId: null,
      events: [validEvent()],
    })
    expect('delivery_id' in envelope).toBe(false)
    expect(envelope.producer).toEqual({ name: 'sitelayer.api', version: '1.0.0' })
  })

  it('CONTRACT ENFORCEMENT: throws on a missing producer, empty events, or an invalid event', () => {
    expect(() => buildProjectEventEnvelope({ producer: { name: ' ' }, events: [validEvent()] })).toThrow(
      /contract validation/,
    )
    expect(() => buildProjectEventEnvelope({ producer: { name: 'sitelayer.api' }, events: [] })).toThrow(
      /contract validation/,
    )
    expect(() =>
      buildProjectEventEnvelope({
        producer: { name: 'sitelayer.api' },
        events: [{ bogus: true } as unknown as ReturnType<typeof validEvent>],
      }),
    ).toThrow(/events\[0\]/)
  })
})

describe('normalizeCallbackArtifacts', () => {
  it('keeps well-formed { kind, ref } entries', () => {
    expect(
      normalizeCallbackArtifacts([
        { kind: 'pr', ref: 'https://github.com/x/y/pull/1' },
        { kind: 'report', ref: 'report-123' },
      ]),
    ).toEqual([
      { kind: 'pr', ref: 'https://github.com/x/y/pull/1' },
      { kind: 'report', ref: 'report-123' },
    ])
  })

  it('falls back to url / id when ref is absent and drops malformed entries', () => {
    expect(
      normalizeCallbackArtifacts([
        { kind: 'pr', url: 'https://github.com/x/y/pull/2' }, // url -> ref
        { kind: 'screenshot', id: 'shot-7' }, // id -> ref
        { kind: 'no-pointer' }, // dropped: no ref/url/id
        { ref: 'no-kind' }, // dropped: no kind
        'not-an-object', // dropped
        null, // dropped
      ]),
    ).toEqual([
      { kind: 'pr', ref: 'https://github.com/x/y/pull/2' },
      { kind: 'screenshot', ref: 'shot-7' },
    ])
  })

  it('returns [] for non-array / empty / all-malformed input', () => {
    expect(normalizeCallbackArtifacts(undefined)).toEqual([])
    expect(normalizeCallbackArtifacts(null)).toEqual([])
    expect(normalizeCallbackArtifacts('x')).toEqual([])
    expect(normalizeCallbackArtifacts([])).toEqual([])
    expect(normalizeCallbackArtifacts([{}, { kind: '' }])).toEqual([])
  })

  it('flows artifacts onto a contract-valid Callback', () => {
    const callback = buildCallbackSnapshot({
      workItemId: WORK_ITEM_ID,
      status: 'resolved',
      artifacts: [{ kind: 'pr', ref: 'https://github.com/x/y/pull/3' }],
      completedAt: FIXED_AT,
    })
    expect(callback!.artifacts).toEqual([{ kind: 'pr', ref: 'https://github.com/x/y/pull/3' }])
    expect(validateCallback(callback)).toEqual([])
  })
})

// The INBOUND (return-leg) conformance: receiveAgentCallback records a
// projectkit `Callback` snapshot in the appended context_handoff_events payload
// under `projectkit_callback`. This block reproduces the route's derivation
// (deriveAgentCallbackState -> next.status -> workItemStatusToCallbackStatus ->
// buildCallbackSnapshot) for every agent-callback event type and asserts the
// resulting snapshot validates against the published Callback contract + schema.
describe('inbound agent-callback Callback snapshot (RETURN leg conformance)', () => {
  // Mirror of deriveAgentCallbackState in routes/work-requests.ts (the default
  // status each agent-callback event resolves to when the agent omits one).
  const defaultStatusForEvent: Record<string, string | undefined> = {
    'agent.dispatch_acknowledged': 'agent_running',
    'agent.message_received': undefined, // no status change -> no Callback snapshot
    'agent.artifact_attached': undefined, // no status change -> no Callback snapshot
    'agent.proposal_ready': 'review_ready',
    'agent.completed': 'review_ready',
    'human.review_requested': 'review_ready',
  }

  // Build the snapshot the same way receiveAgentCallback does.
  function snapshotForInbound(input: {
    eventType: string
    requestedStatus?: string
    artifacts?: unknown
    message?: string | null
    completedAt?: string
  }) {
    const nextStatus = input.requestedStatus ?? defaultStatusForEvent[input.eventType]
    const callbackStatus = workItemStatusToCallbackStatus(nextStatus)
    if (!callbackStatus) return null
    return buildCallbackSnapshot({
      workItemId: WORK_ITEM_ID,
      status: nextStatus,
      artifacts: input.artifacts,
      ...(callbackStatus === 'failed' && input.message ? { error: input.message } : {}),
      ...(isTerminalCallbackStatus(callbackStatus) ? { completedAt: input.completedAt ?? FIXED_AT } : {}),
    })
  }

  it('every agent-callback event yields a contract-valid Callback (or null when no status change)', () => {
    for (const eventType of AGENT_CALLBACK_EVENT_TYPES) {
      const snapshot = snapshotForInbound({ eventType, artifacts: [{ kind: 'pr', ref: 'pr-1' }] })
      if (defaultStatusForEvent[eventType] === undefined) {
        // message_received / artifact_attached do not move status -> no snapshot.
        expect(snapshot).toBeNull()
        continue
      }
      expect(snapshot).not.toBeNull()
      expect(snapshot!.concern_ref).toBe(WORK_ITEM_ID) // concern_ref = work_item_id
      expect(snapshot!.schema_version).toBe(CONTRACT_VERSION)
      // Validates against the published validator AND the re-export.
      expect(validateCallback(snapshot)).toEqual([])
      expect(validateCallbackSnapshot(snapshot)).toEqual([])
      // Satisfies the published callback.schema.json (required fields + enum).
      expect(requiredFieldProblems(CALLBACK_DEF, snapshot as unknown as Record<string, unknown>)).toEqual([])
      expect(CALLBACK_DEF.properties?.status?.enum).toContain(snapshot!.status)
    }
  })

  it('covers the full status mapping for an agent-supplied terminal status', () => {
    // succeeded (resolved): completed_at stamped, no error.
    const succeeded = snapshotForInbound({ eventType: 'agent.completed', requestedStatus: 'resolved' })
    expect(succeeded!.status).toBe('succeeded')
    expect(succeeded!.completed_at).toBe(FIXED_AT)
    expect(succeeded!.error).toBeUndefined()
    expect(validateCallback(succeeded)).toEqual([])

    // failed (wont_do): error carries the agent message, completed_at stamped.
    const failed = snapshotForInbound({
      eventType: 'agent.completed',
      requestedStatus: 'wont_do',
      message: 'cannot reproduce',
    })
    expect(failed!.status).toBe('failed')
    expect(failed!.error).toBe('cannot reproduce')
    expect(failed!.completed_at).toBe(FIXED_AT)
    expect(validateCallback(failed)).toEqual([])

    // running (agent_running / review_ready): no completed_at (non-terminal).
    const running = snapshotForInbound({ eventType: 'agent.dispatch_acknowledged' })
    expect(running!.status).toBe('running')
    expect(running!.completed_at).toBeUndefined()
    expect(validateCallback(running)).toEqual([])
  })

  it('maps inbound artifacts onto the published CallbackArtifact[] shape', () => {
    const snapshot = snapshotForInbound({
      eventType: 'agent.artifact_attached',
      requestedStatus: 'review_ready',
      artifacts: [
        { kind: 'pr', url: 'https://github.com/x/y/pull/9', extra: 'ignored' },
        { kind: 'screenshot', id: 'shot-1' },
        { bogus: true },
      ],
    })
    expect(snapshot!.artifacts).toEqual([
      { kind: 'pr', ref: 'https://github.com/x/y/pull/9' },
      { kind: 'screenshot', ref: 'shot-1' },
    ])
    expect(validateCallback(snapshot)).toEqual([])
  })

  it('never carries the scoped-bearer callback token in the published snapshot (TOKEN SAFETY)', () => {
    // Even if a (mis)caller routed token-ish data, the contract Callback only
    // exposes its own fields — no `token` / `authorization` / `bearer` keys.
    const snapshot = snapshotForInbound({ eventType: 'agent.completed', requestedStatus: 'resolved' })
    expect(snapshot).not.toBeNull()
    const keys = Object.keys(snapshot as unknown as Record<string, unknown>)
    expect(keys).not.toContain('token')
    expect(keys).not.toContain('authorization')
    expect(keys).not.toContain('bearer')
    expect(keys).not.toContain('callback_token')
    // The whole serialized snapshot has no token-shaped substring.
    expect(JSON.stringify(snapshot).toLowerCase()).not.toContain('token')
  })
})
