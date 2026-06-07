-- 011_portal_share_revocation_audit.sql
--
-- Portal-link revocation + access audit (LANE A, security hardening).
--
-- A leaked / forwarded share link is the #1 real exposure on the public
-- /api/portal/* surface: it grants a third party access to that estimate,
-- rental catalog, or feedback capture session with no way to revoke and no
-- access trail. This migration adds the substrate for both halves:
--
--   * revoked_at        — owner can kill a link; the public gate rejects
--                         (HTTP 410) once set, BEFORE exposing any data or
--                         accepting accept/decline/finalize.
--   * last_accessed_at  — when the link was last hit on the public surface.
--   * access_count      — how many times the link was hit (cheap audit trail
--                         the owner can review to spot forwarding / abuse).
--
-- ADDITIVE ONLY. `revoked_at` already exists on estimate_share_links
-- (migration 115 / squashed baseline) and feedback_invites (baseline); only
-- rental_share_links lacks it. The access-audit columns are new on all three.
-- Every statement is IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so the file is
-- idempotent and safe to re-run.

-- ---------------------------------------------------------------------------
-- estimate_share_links — already carries revoked_at + viewed_at + view_count.
-- view_count/viewed_at remain the customer-funnel signal (first-view operator
-- notification). access_count/last_accessed_at are the SECURITY audit trail:
-- every public hit (GET view + accept/decline/finalize + capture lifecycle)
-- bumps them, so a forwarded link shows abnormal access regardless of the
-- terminal accepted/declined funnel state.
-- ---------------------------------------------------------------------------
ALTER TABLE public.estimate_share_links
  ADD COLUMN IF NOT EXISTS last_accessed_at timestamp with time zone;
ALTER TABLE public.estimate_share_links
  ADD COLUMN IF NOT EXISTS access_count integer DEFAULT 0 NOT NULL;

-- ---------------------------------------------------------------------------
-- rental_share_links — had NO revocation or audit columns at all.
-- ---------------------------------------------------------------------------
ALTER TABLE public.rental_share_links
  ADD COLUMN IF NOT EXISTS revoked_at timestamp with time zone;
ALTER TABLE public.rental_share_links
  ADD COLUMN IF NOT EXISTS last_accessed_at timestamp with time zone;
ALTER TABLE public.rental_share_links
  ADD COLUMN IF NOT EXISTS access_count integer DEFAULT 0 NOT NULL;

-- Active (non-revoked) rental share links, for the owner-facing usage list.
CREATE INDEX IF NOT EXISTS rental_share_links_active_idx
  ON public.rental_share_links USING btree (company_id, created_at DESC)
  WHERE (revoked_at IS NULL);

-- ---------------------------------------------------------------------------
-- feedback_invites — already carries revoked_at + last_used_at. last_used_at
-- is bumped on the resolve/capture-actor path today; access_count is the new
-- countable audit signal (last_accessed_at mirrors last_used_at semantics so
-- the owner-facing share-detail shape is uniform across all three surfaces).
-- ---------------------------------------------------------------------------
ALTER TABLE public.feedback_invites
  ADD COLUMN IF NOT EXISTS last_accessed_at timestamp with time zone;
ALTER TABLE public.feedback_invites
  ADD COLUMN IF NOT EXISTS access_count integer DEFAULT 0 NOT NULL;
