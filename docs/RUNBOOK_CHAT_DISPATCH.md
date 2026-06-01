# Runbook: Operator-Context Chat Dispatch

The operator-context chat widget routes responses through the
**subscription-CLI lane** — never a metered API key. This document
covers the production-env wiring + rotation discipline for the three
new env vars that the chat backend needs.

**Doctrine source:** `digital-ontology/operator-action-triage-2026-05-21.md` §5 (revised).

## Architecture (one-page summary)

```
Browser widget (operator types)
   │
   ▼
POST /api/ai/chat                          (sitelayer API)
   │  persists audit_events stage_message
   │  enqueues mesh task with counsel-of-models operator_assistant lane
   ▼
POST $MESH_API_URL/api/tasks               (control-plane authority)
   │  scheduler routes to Claude CLI runner (subscription)
   ▼
Runner generates response, POSTs back to
POST /api/ai/chat/:audit_event_id/respond  (sitelayer API)
   │  bearer-auth via SITELAYER_CHAT_WEBHOOK_TOKEN
   │  persists audit_events respond_message
   ▼
GET  /api/ai/chat/:audit_event_id/response (widget polling)
   200 + body once respond_message lands
```

**No `ANTHROPIC_API_KEY`. No `OPENAI_API_KEY`. No metered key anywhere.**

## Required env vars

| Var                            | Where                                                          | Purpose                                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MESH_API_URL`                 | sitelayer API                                                  | Where to POST mesh tasks (e.g. `http://mesh-hetzner:8713` from inside the prod droplet's Tailnet)                                                                              |
| `SITELAYER_PUBLIC_BASE`        | sitelayer API                                                  | The PUBLIC URL the CLI runner uses to reach the webhook (e.g. `https://sitelayer.sandolab.xyz`). Must be reachable from any worker host on the fleet.                          |
| `SITELAYER_CHAT_WEBHOOK_TOKEN` | sitelayer API **+ every CLI runner that picks up these tasks** | Bearer token the runner presents on the webhook POST. Mesh's runner-secret-injection path provides this to the runner; sitelayer's webhook verifies it with `timingSafeEqual`. |

If any of these are unset:

- **`MESH_API_URL` missing** → `dispatchChatResponseToMesh` returns `ok:false`. The widget still receives `status:'staged'` (audit row landed) but `mesh_task_id:null` and `dispatch_error:'MESH_API_URL not configured'`. UX: operator's message stages but no agent reply arrives — the polling actor will time out at 60s with "subscription-CLI runner did not respond in time".
- **`SITELAYER_PUBLIC_BASE` missing** → same as above; the dispatch prompt has no webhook URL so the runner couldn't reply even if it tried.
- **`SITELAYER_CHAT_WEBHOOK_TOKEN` missing** → the webhook endpoint returns `503 webhook disabled`. The runner sees the 503 in its task body and fails the task; the widget times out.

All three are required for end-to-end function. Sitelayer's existing audit-row write does NOT depend on any of these — the message will always be durably persisted; only the reply loop is gated.

## Wiring sequence (sitelayer prod)

> **DEPLOY MODEL UPDATED 2026-06-01.** Prod runtime secrets now live in
> `/app/sitelayer/.env` on the droplet (the GitHub Actions deploy was
> removed in `70b9584b`; the prod deploy script reuses the on-droplet
> `.env`). Add the three keys to `/app/sitelayer/.env` directly and bounce
> the affected container; register them in `ops/env/production.env.json` so
> a future re-render stays correct.

Per `CLAUDE.md` deploy procedure rules 1 and 2 (prod runtime secrets live
in `/app/sitelayer/.env` on the droplet, names/scope manifested in
`ops/env/production.env.json`):

### 1. Add the three keys to `/app/sitelayer/.env` on the prod droplet

SSH to the droplet (as `sitelayer`), back up `.env`, and add:

```
MESH_API_URL                     = http://mesh-hetzner:8713
SITELAYER_PUBLIC_BASE            = https://sitelayer.sandolab.xyz
SITELAYER_CHAT_WEBHOOK_TOKEN     = <generate via: openssl rand -hex 32>
```

The webhook token must NOT have been used anywhere else; it's a fresh
secret. Capture the value to your password manager.

### 2. Register the names in `ops/env/production.env.json`

So a future `render-production-env.mjs` run stays correct, add three
entries to the manifest:

```json
{
  "MESH_API_URL": { "source": "secret", "key": "MESH_API_URL" },
  "SITELAYER_PUBLIC_BASE": { "source": "secret", "key": "SITELAYER_PUBLIC_BASE" },
  "SITELAYER_CHAT_WEBHOOK_TOKEN": { "source": "secret", "key": "SITELAYER_CHAT_WEBHOOK_TOKEN" }
}
```

(Exact format matches what's already there — check existing entries.)

### 3. Recreate the API/worker containers

After editing `/app/sitelayer/.env`, recreate the services that read these
keys so the new env is picked up:

```sh
cd /app/sitelayer && GIT_SHA=$(cat .last_successful_deployed_sha) \
  docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate api worker
```

### 4. Distribute the webhook token to the fleet

The CLI runner needs the same token in its environment so it can present
it on the webhook POST. Add to the runner-credential rotation flow:

- **Per-host runner env** lives at `~/.config/mesh/env` on each worker
  (taylor-pc-ubuntu, system76-pc, taylorsando-alienware-17). Add the
  line:

  ```
  export SITELAYER_CHAT_WEBHOOK_TOKEN=<same value as the GitHub secret>
  ```

- After updating `~/.config/mesh/env` on each worker:

  ```
  systemctl --user restart mesh-worker.service
  ```

- For mesh-hetzner authority (which dispatches but doesn't run the CLI
  itself), the value is consumed by the dispatch-side prompt template;
  add to `~/.config/mesh/env` on hetzner with the same value:

  ```
  hetzner 'echo "export SITELAYER_CHAT_WEBHOOK_TOKEN=$WEBHOOK_TOKEN" >> ~/.config/mesh/env'
  hetzner 'systemctl --user restart mesh'
  ```

  (Run with `WEBHOOK_TOKEN=...` set in your local shell so the value
  isn't recorded in shell history.)

### 5. Deploy + smoke-test

If a fresh build/image is also needed, re-deploy from the fleet with
`scripts/deploy.sh prod` (otherwise the container-recreate in step 3 is
sufficient for an env-only change).

After deploy / recreate completes:

```sh
# 1. Verify the .env has the three keys (do NOT print the token)
ssh sitelayer@10.118.0.4 'grep -E "^(MESH_API_URL|SITELAYER_PUBLIC_BASE|SITELAYER_CHAT_WEBHOOK_TOKEN)=" /app/sitelayer/.env | wc -l'
# Expect: 3

# 2. From the prod droplet, confirm mesh authority is reachable
ssh sitelayer@10.118.0.4 'curl -s -m 3 http://mesh-hetzner:8713/api/health | head'
# Expect: {"status":"ok",...}

# 3. End-to-end: open sitelayer.sandolab.xyz, send a chat message,
#    watch the widget. Stage button → "Awaiting…" → response inline
#    within 5-15s.
```

If the smoke fails, see the troubleshooting section.

## Rotation discipline

The webhook token is a long-lived shared secret. Rotate quarterly OR
immediately after any of:

- A worker host is decommissioned
- A runner credential leak is suspected
- The operator changes the Tailnet membership

**Rotation procedure:**

1. Generate a new token: `openssl rand -hex 32`
2. **In ONE atomic deploy turn**, update:
   - `SITELAYER_CHAT_WEBHOOK_TOKEN` in `/app/sitelayer/.env` on the prod droplet
   - `~/.config/mesh/env` on every worker host (the value must be
     identical across hosts; mismatch breaks webhook auth)
   - `~/.config/mesh/env` on mesh-hetzner authority
3. Recreate the sitelayer api/worker containers (or `scripts/deploy.sh prod` from the fleet if a rebuild is also needed)
4. `systemctl --user restart mesh-worker.service` on every worker host
5. `hetzner 'systemctl --user restart mesh'`
6. Send a test chat message; confirm the reply lands.

**Why all-at-once:** the webhook does a single-token compare. There's
no key-rotation window. If the worker's token doesn't match the
sitelayer prod env's token, EVERY chat dispatch fails 401 until both
sides converge. Sitelayer's audit table still records the staged
message, so no data is lost — only the reply UX is broken during the
gap.

## Troubleshooting

| Symptom                                                                     | Cause                                                                | Fix                                                                                                                                                                |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Widget shows "Sending…" → "Awaiting…" forever, no reply                     | `MESH_API_URL` empty OR mesh authority unreachable from prod droplet | `curl http://mesh-hetzner:8713/api/health` from the droplet. If unreachable, check Tailnet routing. If reachable, check `/app/sitelayer/.env` for `MESH_API_URL=`. |
| Widget shows reply error: "subscription-CLI runner did not respond in time" | Mesh task created but no CLI runner picked it up within 60s          | `curl "$MESH_API_URL/api/orchestrate/tasks?q=operator-chat-response&limit=5"                                                                                       | jq '.[] | {id,state,agent}'`— if state=pending and agent=null, no runner is claiming. Check`mcp**mesh**fleet_status` for Claude runners. |
| Sitelayer logs: webhook returning 401                                       | Token mismatch between sitelayer env + worker env                    | Rotate (above) and confirm same value lands on both sides.                                                                                                         |
| Sitelayer logs: webhook returning 503                                       | `SITELAYER_CHAT_WEBHOOK_TOKEN` empty in prod env                     | Check `/app/sitelayer/.env`; re-render via deploy if missing.                                                                                                      |
| Stage button works but no audit row appears                                 | Mutation outbox stuck                                                | Check `/api/sync/outbox` for failed rows. Not related to chat dispatch wiring.                                                                                     |

## Cost posture

Per CLAUDE.md rule 3 (cost cap at the dispatcher chokepoint): the
counsel-of-models registry's `operator_assistant` lane primary is the
Claude CLI subscription. Each chat reply is one Claude Code session
turn. **No metered spend.**

If the operator's chat usage explodes (>50 messages/day sustained), the
shared-cost concern would be CLI runner availability, not $. The
scheduler's existing daily-budget caps don't apply here (those gate
browser research, not CLI dispatch).

## Related docs

- `digital-ontology/operator-action-triage-2026-05-21.md` §5 — decision matrix
- `~/projects/control-plane-suite/repos/control-plane/mesh/core/counsel_of_models_registry.go` — `operator_assistant` lane definition
- `apps/api/src/mesh-dispatcher.ts` — sitelayer-side dispatch
- `apps/api/src/routes/ai-chat.ts` — POST/GET/webhook endpoints
- `apps/web/src/machines/chat-widget.ts` — XState polling
