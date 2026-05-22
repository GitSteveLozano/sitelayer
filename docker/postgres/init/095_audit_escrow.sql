-- 095_audit_escrow.sql
--
-- Audit Escrow MVP — signed, chained, append-only evidence anchor for
-- sitelayer's audit chain. Mirrors the schema in
-- ~/projects/control-plane/mesh/postgres/migrations/266_audit_escrow.sql
-- so a future merger (if anyone wants to unify the chains) is mechanical.
--
-- Wedge 2 of the proving-ground plan (docs/PROVING_GROUND_PLAN.md). Per
-- ADR 0024 (default-decoupled), sitelayer holds its own escrow chain and
-- does not depend on mesh at runtime.
--
-- The authoritative append path lives in apps/api/src/audit-escrow.ts:
-- each row signs a canonical material JSON blob with a local Ed25519 key
-- and links to the previous row by entry_hash. Optional DO Spaces (S3)
-- Object Lock and OpenTimestamps metadata is filled after external
-- sealing succeeds.

CREATE TABLE IF NOT EXISTS audit_escrow_keys (
    key_id          TEXT        PRIMARY KEY,
    host_id         TEXT        NOT NULL DEFAULT '',
    algorithm       TEXT        NOT NULL DEFAULT 'Ed25519',
    public_key_b64  TEXT        NOT NULL,
    private_key_b64 TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at      TIMESTAMPTZ,
    CONSTRAINT audit_escrow_keys_key_id_nonempty
        CHECK (length(key_id) > 0),
    CONSTRAINT audit_escrow_keys_algorithm_supported
        CHECK (algorithm IN ('Ed25519')),
    CONSTRAINT audit_escrow_keys_retired_after_created
        CHECK (retired_at IS NULL OR retired_at >= created_at)
);

CREATE INDEX IF NOT EXISTS audit_escrow_keys_active_idx
    ON audit_escrow_keys (retired_at, created_at DESC)
    WHERE retired_at IS NULL;

-- company_id is UUID (matching audit_events.company_id) and nullable so
-- a global / cross-tenant entry is possible. The runner ticks per-company
-- and writes per-company entries; chain linkage is also per-company so
-- one tenant's gap doesn't break another tenant's verifier walk.
CREATE TABLE IF NOT EXISTS audit_escrow_entries (
    id                  BIGSERIAL   PRIMARY KEY,
    entry_hash          TEXT        NOT NULL UNIQUE,
    previous_entry_hash TEXT        NOT NULL DEFAULT '',
    action              TEXT        NOT NULL,
    company_id          UUID        REFERENCES companies(id) ON DELETE RESTRICT,
    window_start        TIMESTAMPTZ NOT NULL,
    window_end          TIMESTAMPTZ NOT NULL,
    source_count        INTEGER     NOT NULL DEFAULT 0,
    payload_hash        TEXT        NOT NULL,
    context_hash        TEXT        NOT NULL,
    key_id              TEXT        NOT NULL REFERENCES audit_escrow_keys(key_id),
    signature_b64       TEXT        NOT NULL,
    material_json       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    payload_json        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    s3_bucket           TEXT        NOT NULL DEFAULT '',
    s3_key              TEXT        NOT NULL DEFAULT '',
    s3_version_id       TEXT        NOT NULL DEFAULT '',
    s3_object_locked    BOOLEAN     NOT NULL DEFAULT false,
    ots_proof_path      TEXT        NOT NULL DEFAULT '',
    ots_status          TEXT        NOT NULL DEFAULT '',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT audit_escrow_entries_entry_hash_nonempty
        CHECK (length(entry_hash) > 0),
    CONSTRAINT audit_escrow_entries_action_nonempty
        CHECK (length(action) > 0),
    CONSTRAINT audit_escrow_entries_signature_nonempty
        CHECK (length(signature_b64) > 0),
    CONSTRAINT audit_escrow_entries_window_order
        CHECK (window_end >= window_start)
);

CREATE INDEX IF NOT EXISTS audit_escrow_entries_created_idx
    ON audit_escrow_entries (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_escrow_entries_company_idx
    ON audit_escrow_entries (company_id, created_at DESC)
    WHERE company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_escrow_entries_action_idx
    ON audit_escrow_entries (action, window_end DESC);

-- Chain-walk helper: given (company_id, action), find the latest entry
-- whose previous_entry_hash this entry will point to. Per-company per-
-- action chains keep the tick logic simple.
CREATE INDEX IF NOT EXISTS audit_escrow_entries_chain_idx
    ON audit_escrow_entries (company_id, action, id DESC);

-- Back-references on the source tables so a row can be located in its
-- escrow bundle by joining on escrow_anchor_id. NULL until the next
-- escrow tick anchors the row.
ALTER TABLE audit_events
    ADD COLUMN IF NOT EXISTS escrow_anchor_id BIGINT REFERENCES audit_escrow_entries(id);

CREATE INDEX IF NOT EXISTS audit_events_escrow_anchor_idx
    ON audit_events (escrow_anchor_id)
    WHERE escrow_anchor_id IS NOT NULL;

ALTER TABLE context_handoff_events
    ADD COLUMN IF NOT EXISTS escrow_anchor_id BIGINT REFERENCES audit_escrow_entries(id);

CREATE INDEX IF NOT EXISTS context_handoff_events_escrow_anchor_idx
    ON context_handoff_events (escrow_anchor_id)
    WHERE escrow_anchor_id IS NOT NULL;

-- Seed the audit_escrow_tick dispatch lane so the worker gates on it.
-- The dispatch_lanes table lands on the wedge5 branch (migration 094);
-- guard the seed so this migration is idempotent even if 094 is absent.
-- Once wedge5 merges, this seed becomes a no-op on conflict.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_lanes'
    ) THEN
        INSERT INTO dispatch_lanes (name, state, last_decided_by)
        VALUES ('audit_escrow_tick', 'active', 'system:seed')
        ON CONFLICT (name) DO NOTHING;
    END IF;
END
$$;
