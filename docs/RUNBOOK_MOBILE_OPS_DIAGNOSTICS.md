# Mobile Ops Onsite Diagnostics Runbook

## Symptom

An onsite support session needs controlled capture or agent review from a
phone, without SSHing into the workstation or exposing local debug ports.

## Detection

- Mobile Ops shows Diagnostic readiness as limited, blocked, or ready.
- `GET /api/ops/diagnostics` returns component state and an
  `onsite_session` plan.
- `GET /api/ops/diagnostics/sessions` shows active sessions and audit events.

## Runtime Contract

`POST /api/ops/diagnostics/sessions` creates a one-hour session and returns the
raw control token once. Later reads never return the raw token.

Session actions are audit-first:

- `capture_field_context`
- `capture_desktop_context`
- `route_support_packet`
- `dispatch_agent_review`

When `SITELAYER_OPS_DIAGNOSTIC_AGENT_AUDIENCE` is unset, routed actions stay
audit-only. When it is set, `route_support_packet` and
`dispatch_agent_review` enqueue a projectkit Concern into `/api/agent-feed`.

## Agent-Feed Setup

Set both runtime variables on the API tier:

```bash
AGENT_FEED_TOKENS='{"onsite-diagnostics":"<token>"}'
SITELAYER_OPS_DIAGNOSTIC_AGENT_AUDIENCE=onsite-diagnostics
```

The audience name must be the same in all three places:

- `AGENT_FEED_TOKENS` JSON key
- `SITELAYER_OPS_DIAGNOSTIC_AGENT_AUDIENCE`
- the workstation executor `PULL_AUDIENCE`

Run the pull executor on the workstation that should receive onsite actions:

```bash
PULL_FEED_URL=https://dev.sitelayer.sandolab.xyz/api/agent-feed \
PULL_AUDIENCE=onsite-diagnostics \
PULL_FEED_TOKEN=<token> \
PULL_STATE_FILE=$HOME/.local/state/sitelayer-onsite-agent/done.json \
LOCAL_EXECUTOR_TIMEOUT_MS=3600000 \
LOCAL_EXECUTOR_CMD='claude -p "You are handling a Sitelayer onsite diagnostic Concern. Read inputs.agent_prompt and inputs.artifacts from stdin, inspect only the provided evidence, make a focused diagnosis, and report the next operator action."' \
npx --yes --package=github:taylorSando/projectkit#v0.9.1 pull-executor
```

## Diagnosis

Check API readiness:

```bash
curl -fsS "$SITELAYER_PUBLIC_BASE/api/ops/diagnostics" | jq '.status,.onsite_session'
```

Check agent-feed is configured and audience-scoped:

```bash
curl -fsS \
  -H "Authorization: Bearer $PULL_FEED_TOKEN" \
  "$SITELAYER_PUBLIC_BASE/api/agent-feed/concerns?audience=$PULL_AUDIENCE" \
  | jq '.concerns | length'
```

If this returns 503, `AGENT_FEED_TOKENS` is unset or invalid. If it returns
401/403, the token or audience does not match.

## Mitigation

1. If Mobile Ops is blocked, use the listed blocker first; do not force an
   action the plan marks disabled.
2. If routing is not configured, continue audit-only and copy the support
   packet manually.
3. If routing is configured but no Concern arrives, verify the audience triplet
   above and restart only the API container after env changes.
4. If the workstation executor is down, restart the pull executor; the feed is
   pull-based and will not require SSH into the workstation.

## Verifying Recovery

- Start an onsite session from Mobile Ops.
- Request `dispatch_agent_review`.
- The action response includes `accepted_action.agent_feed.queued=true`.
- The executor receives one Concern whose `inputs.metadata` includes
  `ops_diagnostic_session_id`.
- The session detail shows a new `action.requested` audit event.

## Post-Incident

Record whether the user accepted field capture, desktop capture, routed review,
or audit-only handling. If the operator had to leave the user waiting, add that
friction to the product backlog instead of treating it as an infra-only issue.
