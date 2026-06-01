-- Migration 133: impersonation_sessions (audited impersonation ledger, design §7)
-- One row per platform-admin impersonation grant: who (actor_user_id) is acting
-- as whom (subject_user_id), why (reason, required), the posture (mode), and the
-- TTL. This is the cross-tenant "who impersonated whom and why" record; the
-- per-mutation trail lives in audit_events.impersonated_by (migration 132).
-- Not company-scoped — impersonation is a platform-level action.
-- OQ6 default posture: read_only (a view-by-default safety toggle; capability is
-- full either way since superadmin). Forward-only + idempotent.
create table if not exists impersonation_sessions (
  id uuid primary key default gen_random_uuid(),
  actor_user_id text not null,
  subject_user_id text not null,
  reason text not null,
  mode text not null default 'read_only',
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists impersonation_sessions_actor_idx
  on impersonation_sessions (actor_user_id, created_at desc);
create index if not exists impersonation_sessions_subject_idx
  on impersonation_sessions (subject_user_id, created_at desc);
