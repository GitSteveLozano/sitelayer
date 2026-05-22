# Runbook: Audit Escrow

**Owner:** Operator
**Last updated:** 2026-05-22 (Wedge 2 of `PROVING_GROUND_PLAN.md`)
**Related:** ADR 0024 (default-decoupled), `agent-control-plane-vendor-map.md` §8 (escrow as 8th control point)

## What it is

Sitelayer holds a local, signed, append-only chain of evidence anchors over
`audit_events` and `context_handoff_events`. Each entry in
`audit_escrow_entries` carries:

- An Ed25519 signature over a canonical JSON material blob (RFC 8785-style
  sort, inlined in `packages/queue/src/audit-escrow.ts::canonicalizeJSON`).
- A SHA-256 hash chain link to the previous entry for the same
  `(company_id, action)` pair.
- A minimal redacted projection of the source rows for the window.
- Optional best-effort external sealing: DO Spaces (S3 Object Lock
  GOVERNANCE, 7-year retention) and OpenTimestamps (stub in v1; TODO).

The chain is sitelayer-local — no mesh dependency at runtime. The local
Ed25519 signature is the legally-meaningful primitive.

## Symptom: a third party challenges an audit_event's authenticity

A customer's lawyer asks "how do we know this `crew_schedule.updated`
audit row at 2026-05-30T14:23 wasn't backdated last night?"

### Steps

1. **Find the escrow anchor:**

   ```sql
   select id, escrow_anchor_id, action, entity_id, created_at
     from audit_events
    where id = '<the row in question>';
   ```

   If `escrow_anchor_id IS NULL`, the row hasn't been anchored yet —
   the next hourly tick will pick it up. Bring this back when the
   anchor is populated.

2. **Pull the bundle from the API:**

   ```bash
   curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
        https://api.sitelayer.dev/api/audit/escrow/<escrow_anchor_id> \
     | jq .
   ```

   A 200 response means the API verified the signature in-process
   before returning. A 500 with `"escrow_corruption": true` means the
   row's signature no longer verifies — escalate immediately (see DR
   section below).

3. **Run the verbose verification (for the auditor):**

   ```bash
   curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
        https://api.sitelayer.dev/api/audit/escrow/verify/<escrow_anchor_id> \
     | jq .verification
   ```

   The returned `verification.report.ok` boolean and `errors[]` list
   are what the third party verifies. The bundle includes the public
   key in base64 — they can re-verify offline using any Ed25519
   library that accepts raw 32-byte keys.

4. **Pin the chain head** (for an external auditor who wants to walk
   the chain backward and prove the entry hasn't been retconned):

   ```bash
   curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
        https://api.sitelayer.dev/api/audit/escrow/chain/head \
     | jq .
   ```

   Output: `{"head": {"entry_id": 123, "entry_hash": "abc..."}}`.
   Send this to the auditor; they re-fetch each entry from N down to
   the row in question and confirm each `previous_entry_hash` matches
   the prior entry's `entry_hash`.

## Detection: how to watch for breaks

- **API alert** — the `/api/audit/escrow/:id` handler logs at error
  severity (Sentry) when an in-process verification fails. Watch the
  Sentry inbox for `"[audit-escrow] CORRUPTION DETECTED"`.

- **S3 object missing** — when `AUDIT_ESCROW_S3_BUCKET` is configured,
  verify the bucket weekly:

  ```sql
  select id, s3_bucket, s3_key, s3_object_locked, created_at
    from audit_escrow_entries
   where s3_bucket <> ''
     and s3_object_locked = false
   order by created_at desc
   limit 50;
  ```

  Rows with a `s3_bucket` set but `s3_object_locked = false` indicate
  the seal step failed; rerun the seal manually with the SDK or wait
  for a follow-up periodic re-seal (TODO).

- **OTS pending past 24h** — when `AUDIT_ESCROW_OTS_ENABLED=1`,
  monitor `ots_status='pending'` rows older than 24h. (OTS submission
  is a v2 stub at the moment — this check is a no-op until the
  follow-up wire-up.)

- **Chain gap** — a `previous_entry_hash` that doesn't match the prior
  entry's `entry_hash` for the same `(company_id, action)` is the
  bright-line corruption signal:

  ```sql
  with chain as (
    select id, action, company_id, entry_hash, previous_entry_hash,
           lag(entry_hash) over (partition by action, company_id order by id) as expected_previous
      from audit_escrow_entries
  )
  select * from chain
   where previous_entry_hash <> coalesce(expected_previous, '')
   order by id;
  ```

  Empty result = chain is intact.

## Key rotation

The Ed25519 keypair in `audit_escrow_keys` is long-lived by default.
Rotate when:

- The private key may have leaked (operator laptop loss, vendor key
  exposure, etc.).
- An external auditor requires evidence of a key-rotation event.
- The KMS upgrade path lands (see TODO in `audit-escrow.ts`).

### Procedure

```sql
-- 1. Mark the active key retired (any new appendEntry() call will
--    generate a fresh keypair on the next tick).
update audit_escrow_keys
   set retired_at = now()
 where retired_at is null;
```

```bash
# 2. Trigger an out-of-band tick so the new key is bound to a real
#    entry immediately. From a worker shell:
node -e "import('./apps/worker/src/runners/audit-escrow-tick.js').then(async m => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const runner = m.createAuditEscrowTickRunner({ pool, logger: console })
  const r = await runner.forceTick(process.env.ACTIVE_COMPANY_ID)
  console.log(r)
  await pool.end()
})"
```

```sql
-- 3. Confirm the new key was created and is now active.
select key_id, host_id, created_at, retired_at
  from audit_escrow_keys
 order by created_at desc
 limit 5;
```

**Important:** never delete a retired key row. Old entries still
reference it via the `key_id` foreign key — historical verification
needs the public key forever.

## DR: verifying the chain after a Postgres restore

After any restore from backup (PITR, dump-and-load, vendor migration),
walk the chain to confirm nothing was lost or shuffled:

```bash
# Chain-walk script (see the SQL above for the manual version).
psql -d sitelayer -c "
  with chain as (
    select id, action, company_id, entry_hash, previous_entry_hash,
           lag(entry_hash) over (partition by action, company_id order by id) as expected_previous
      from audit_escrow_entries
  )
  select count(*) as gaps
    from chain
   where previous_entry_hash <> coalesce(expected_previous, '');
"
```

If `gaps` is 0 the chain is intact. If `gaps > 0`, the gap row's
`(company_id, action, id)` identifies the corrupted segment. Pull the
DO Spaces object for any affected entry (the bundle's `s3_key` is
recorded on the row) and reconcile against the database:

1. The S3 object contains the original `material_json` + `signature`.
2. Use the verbose verification endpoint with the S3-stored copy to
   confirm the in-DB copy was tampered or restored from a stale
   backup.
3. File an incident note and bring in legal counsel before
   communicating with affected customers.

## Configuration knobs

| Env var                             | Default                     | Effect                                                         |
| ----------------------------------- | --------------------------- | -------------------------------------------------------------- |
| `AUDIT_ESCROW_TICK_INTERVAL_MS`     | `3600000` (1h)              | Worker tick cadence                                            |
| `AUDIT_ESCROW_BATCH_SIZE`           | `10000`                     | Max source rows per entry                                      |
| `AUDIT_ESCROW_HOST_ID`              | `''`                        | Stamped on `audit_escrow_keys.host_id` for forensic context    |
| `AUDIT_ESCROW_S3_BUCKET`            | unset                       | DO Spaces bucket for sealing; unset disables                   |
| `AUDIT_ESCROW_S3_REGION`            | `AWS_REGION` or `us-east-1` | Region for S3 client                                           |
| `AUDIT_ESCROW_S3_ENDPOINT`          | unset                       | DO Spaces endpoint (`https://<region>.digitaloceanspaces.com`) |
| `AUDIT_ESCROW_S3_ACCESS_KEY_ID`     | unset                       | Spaces access key                                              |
| `AUDIT_ESCROW_S3_SECRET_ACCESS_KEY` | unset                       | Spaces secret                                                  |
| `AUDIT_ESCROW_S3_RETAIN_YEARS`      | `7`                         | Object Lock retention period                                   |
| `AUDIT_ESCROW_OTS_ENABLED`          | unset                       | Stub flag for OpenTimestamps wire-up (v2)                      |

## Follow-ups (not in v1)

- Move private-key storage out of Postgres to KMS or operator
  Bitwarden — see the TODO in `packages/queue/src/audit-escrow.ts`.
- Wire `javascript-opentimestamps` for actual OTS submission +
  reconciliation. Track in `PROVING_GROUND_PLAN.md`.
- Add a daily reconciliation keeper that re-walks the chain and emits
  a mesh `observation_event` on gap detection.
- Backfill historical audit_events into the chain (v1 forward-anchors
  only).
