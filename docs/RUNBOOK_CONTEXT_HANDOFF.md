# Runbook — Context Handoff / Work Requests

**When to read this:** `/work` items are not moving, agent dispatch is stuck,
callbacks are failing, or a support/debug packet needs to be correlated with a
work item timeline.

**Related code:** `apps/api/src/routes/work-requests.ts`,
`apps/api/src/context-handoff.ts`,
`apps/worker/src/runners/context-work-dispatch.ts`,
`apps/worker/src/runners/work-request-stale.ts`.

## Symptom

Any one of:

- Work item stuck in `agent_running` or `review_ready`.
- `Dispatch agent` returns success but no agent update appears in the timeline.
- Worker logs show `[worker] context_work_dispatch drain failed`.
- Mesh agent says callback was rejected.
- GitHub export/link does not appear in the work item timeline.

## Detection

- **Web:** open `/work`; the Health strip shows active/failed agent dispatches
  and stale review pressure. Filter `Agent` or `Review` for the underlying
  items.
- **Prometheus:** graph
  `sitelayer_context_handoff_total{action=~"agent.*|stale.*|github.*"}`.
- **Queue depth:** graph `sitelayer_queue_pending_count{queue="mutation_outbox"}`.
  Use the SQL below to isolate `dispatch_mesh_work_request` rows.
- **Dispatch lane pressure:** graph `sitelayer_context_dispatch_outbox_count`
  split by `status`.
- **Worker logs:**

  ```bash
  ssh sitelayer@10.118.0.4 \
    "docker compose -f /app/sitelayer/docker-compose.prod.yml logs worker --tail 200 | grep -E 'context_work|work_request'"
  ```

## Common Causes

1. `MESH_WORK_REQUEST_DISPATCH_URL` is unset or points at the wrong Mesh
   endpoint.
2. `MESH_WORK_REQUEST_DISPATCH_TOKEN` or Mesh-side auth changed.
3. `SITELAYER_PUBLIC_BASE` is unset or wrong, so Mesh receives only a relative
   callback path instead of a usable callback URL.
4. The agent callback replay omitted the per-dispatch scoped token from the
   Mesh payload. `SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN` is only a legacy
   fallback for rows created before scoped callback tokens.
5. Mesh accepted the job but did not call back before
   `WORK_REQUEST_CALLBACK_TOKEN_TTL_HOURS`.
6. The work item was stale-swept to `proposal_expired` or `review_stale`.
7. GitHub linking was attempted by a role without export permission.

## Failure Semantics

- **Sitelayer API unavailable:** the work request is not created unless the API
  returns `201`. The browser should keep the user-entered problem statement and
  retry; no partial `context_work_items` row should exist without a support
  packet and first timeline event. Browser-created work requests include a
  `client_request_id`; a retry after a lost response should return the existing
  work item with `idempotent_replay: true`.
- **Database unavailable:** request creation, event append, and dispatch
  enqueue fail closed. The UI should show the API error; no agent handoff is
  implied.
- **Worker unavailable:** dispatch rows remain in `mutation_outbox` as
  `pending` or lease-expired `processing`. Work items remain `agent_running`
  until the worker resumes or the stale sweep marks them
  `proposal_expired`.
- **Mesh dispatch URL unset:** the worker leaves dispatch rows pending and does
  not spend retry attempts. Configure `MESH_WORK_REQUEST_DISPATCH_URL`; the
  next worker heartbeat will claim the backlog.
- **Mesh unavailable:** the worker records the dispatch error and reschedules
  with queue backoff. After the retry cap the row is `failed`; retry it from
  the work item after the underlying URL/token/availability issue is fixed.
- **Callback unavailable or token mismatch:** the agent may have done work, but
  Sitelayer has no trusted completion event. Treat the timeline as the source
  of truth and ask the agent system to replay the callback with the scoped token
  from that dispatch payload and the same idempotency key.
- **GitHub unavailable:** use `/github-export` output as a human-transferable
  issue body. The internal work item and timeline stay canonical.

## Backpressure Rules

- One work item maps to one Mesh dispatch outbox row:
  `context_work_item:dispatch_mesh:<work_item_id>`.
- One browser create attempt maps to one `context_work_items` row by creator
  and `metadata.client_request_id`. Repeated creates should replay the existing
  response for that user, not create new support packets or queue work.
- Repeated API dispatch calls return the existing outbox state. They must not
  reset `attempt_count`, `next_attempt_at`, `error`, or worker-owned backoff.
- The worker is the only normal path that advances queue retry state. Human
  recovery uses the explicit retry action after the dependency is fixed; normal
  dispatch clicks do not reset failed rows.
- `WORK_REQUEST_STALE_SWEEP_LIMIT` bounds how many stale work items are marked
  per sweep. Keep it low enough that stale cleanup cannot dominate normal queue
  drain.
- If `mutation_outbox` depth rises globally, fix the shared worker or database
  bottleneck before retrying individual work requests. Individual retries only
  help after the common dependency has recovered.

## Diagnosis

```sql
-- 1. Recent context work items.
select id, title, status, lane, severity, route, entity_type, entity_id,
       support_packet_id, updated_at
from context_work_items
where company_id = :'company_id'
order by updated_at desc
limit 50;

-- 2. Full timeline for one item.
select event_type, actor_kind, actor_user_id, actor_ref, source_system,
       idempotency_key, request_id, recorded_at, payload, metadata
from context_handoff_events
where company_id = :'company_id' and work_item_id = :'work_item_id'
order by recorded_at asc;

-- 3. Pending or failed Mesh dispatch rows.
select id, entity_id as work_item_id, status, attempt_count, next_attempt_at,
       error, request_id, sentry_trace, created_at, updated_at
from mutation_outbox
where company_id = :'company_id'
  and entity_type = 'context_work_item'
  and mutation_type = 'dispatch_mesh_work_request'
order by created_at desc
limit 50;

-- 4. Divergence check: item status versus latest event.
select w.id, w.status, w.lane, e.event_type as latest_event, e.recorded_at
from context_work_items w
left join lateral (
  select event_type, recorded_at
  from context_handoff_events
  where company_id = w.company_id and work_item_id = w.id
  order by recorded_at desc
  limit 1
) e on true
where w.company_id = :'company_id'
order by w.updated_at desc
limit 50;

-- 5. Raw support packet access audit.
select support_packet_id, actor_user_id, access_type, route, request_id, created_at
from support_packet_access_log
where company_id = :'company_id'
  and support_packet_id = :'support_packet_id'
order by created_at desc
limit 100;
```

Check env on the host:

```bash
ssh sitelayer@10.118.0.4 \
  "grep -E '^(SITELAYER_PUBLIC_BASE|MESH_WORK_REQUEST_DISPATCH_URL|SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN|WORK_REQUEST_)=' /app/sitelayer/.env | sed 's/=.*/=***/'"
```

Check env inside the running containers after deploy. This matters because a
rendered `/app/sitelayer/.env` is not enough if `docker-compose.prod.yml` does
not pass the variables into `api` and `worker`.

```bash
ssh sitelayer@10.118.0.4 \
  "cd /app/sitelayer && docker compose -f docker-compose.prod.yml exec -T api env | grep -E '^(SITELAYER_PUBLIC_BASE|MESH_WORK_REQUEST_DISPATCH_URL|WORK_REQUEST_CALLBACK_TOKEN_TTL_HOURS)=' | sed 's/=.*/=***/'"

ssh sitelayer@10.118.0.4 \
  "cd /app/sitelayer && docker compose -f docker-compose.prod.yml exec -T worker env | grep -E '^(SITELAYER_PUBLIC_BASE|MESH_WORK_REQUEST_DISPATCH_URL|MESH_WORK_REQUEST_DISPATCH_TOKEN|WORK_REQUEST_)=' | sed 's/=.*/=***/'"
```

## Mitigation

1. **Mesh URL/token wrong:** update GitHub production environment values and
   redeploy so `/app/sitelayer/.env` is rendered from source of truth. Do not
   patch the container manually except for break-glass recovery.

2. **Callback token mismatch:** for new dispatches, replay with the scoped
   callback token that was delivered to Mesh in
   `execution_context.context_handoff.callback.token`. For old rows without a
   scoped token hash, rotate `SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN` in
   Sitelayer and the Mesh/agent callback client together.

3. **Dispatch row failed due transient Mesh outage:** leave it pending while
   the worker retry loop is still active. If the row is terminal `failed` or
   `dead` and the underlying cause is fixed, use the work item `Retry dispatch`
   action or call:

   ```bash
   curl -X POST "$SITELAYER_API_URL/api/work-requests/$work_item_id/dispatch/mesh/retry" \
     -H "authorization: Bearer $SITELAYER_TOKEN" \
     -H "content-type: application/json" \
     --data '{"reason":"dependency recovered"}'
   ```

   SQL reset is break-glass only if the API is unavailable:

   ```sql
   update mutation_outbox
      set status = 'pending',
          attempt_count = 0,
          next_attempt_at = now(),
          applied_at = null,
          error = null,
          updated_at = now()
    where company_id = :'company_id'
      and id = :'outbox_id'
      and mutation_type = 'dispatch_mesh_work_request'
      and status in ('failed', 'dead');
   ```

4. **Work item stale but still active:** reopen or status-change from the UI.
   Avoid direct SQL unless UI/API is unavailable; the timeline should carry the
   correction event.

5. **GitHub link rejected:** use an admin/office/foreman/bookkeeper account.
   Members can create and message work items but cannot export/link GitHub in
   v1.

Support packet prompt reads are recorded in `support_packet_access_log`.
Expired packets are not returned through the Work Request detail join; the work
item and redacted timeline remain canonical after packet expiry. Work item
detail reads return a bounded event page by default; use `limit` and `offset`
when inspecting long timelines.

## Verifying Recovery

For a dev/preview end-to-end smoke, use:

```bash
SITELAYER_API_URL=https://dev.sitelayer.sandolab.xyz \
SITELAYER_AUTH_TOKEN=e2e-admin \
SITELAYER_COMPANY_SLUG=la-operations \
./scripts/test-context-work-request.sh
```

Set `DATABASE_URL` to also replay the scoped callback token from
`mutation_outbox` and verify that the work item reaches `review_ready`.
Set `MESH_API_URL` to also probe Mesh for the dispatched task. The smoke
refuses production by default because it creates a real work item and queues a
real Mesh task; use `ALLOW_PROD_WORK_REQUEST_SMOKE=1` only for deliberate prod
validation.

```sql
-- Dispatch accepted and callback/proposal returned:
select event_type, actor_kind, source_system, recorded_at
from context_handoff_events
where company_id = :'company_id' and work_item_id = :'work_item_id'
order by recorded_at asc;

-- No pending dispatch rows for this item:
select status, attempt_count, error
from mutation_outbox
where company_id = :'company_id'
  and entity_type = 'context_work_item'
  and entity_id = :'work_item_id'
  and mutation_type = 'dispatch_mesh_work_request';
```

Expected sequence for agent work:

1. `work_item.created`
2. `agent.dispatch_requested`
3. optional `agent.dispatch_retried` if the first dispatch failed and was reset
4. `agent.dispatch_acknowledged`
5. `agent.message_received`, `agent.proposal_ready`, or `agent.completed`
6. `human.reviewed` / `resolution.accepted`

## Post-Incident

If a customer or collaborator was blocked, file a short postmortem. Action
items usually belong in one of three buckets: scoped callback tokens,
per-adapter dispatch state, or a dashboard panel for oldest pending
`dispatch_mesh_work_request`.
