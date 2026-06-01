-- Migration 132: audit_events.impersonated_by (audited impersonation, design §7)
-- When a platform admin impersonates a user (Clerk actor-token session), the
-- session JWT carries an `act` claim = the real admin. recordAudit() stamps
-- that admin here so EVERY mutation made while impersonating is attributable to
-- the human behind it, while actor_user_id stays the effective (impersonated)
-- user. NULL for normal self-auth. Forward-only + idempotent.
alter table audit_events add column if not exists impersonated_by text;

create index if not exists audit_events_impersonated_by_idx
  on audit_events (impersonated_by)
  where impersonated_by is not null;
