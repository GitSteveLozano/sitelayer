-- 150_company_notification_sender.sql
--
-- ⚠️ RENUMBER FLAG: a sibling slice (RLS FORCE / row-level-security work) is
-- landing migrations around the same range. Max existing migration at author
-- time was 145. This file is numbered 150 to leave 146–149 to that slice; if
-- both land, renumber whichever lands second so the ledger stays monotonic.
-- This migration is purely additive (nullable columns, no backfill, no policy
-- change) so the renumber is a rename only — no content change.
--
-- Per-company notification sender identity (multi-tenant email).
--
-- Until now EVERY outbound email — estimate share links, teammate invites,
-- sync-failure alerts, welcome emails — was sent from a SINGLE process-wide
-- env (EMAIL_FROM, default 'noreply@sitelayer.sandolab.xyz') resolved once in
-- apps/{api,worker}/src/email.ts:loadEmailConfig(). With one tenant that was
-- fine; once we onboard multiple construction companies, every company's
-- customers receive mail from the SAME generic address with no company
-- branding. This is the SAME config-in-global-env class that migration 144
-- moved for the QBO live flag: a setting that legitimately differs per company
-- but lived in the process env.
--
-- This migration is the EXPAND step. It adds the per-company columns so the
-- sender CAN be resolved per tenant; resolveCompanyNotificationSender()
-- (apps/.../company-notification-sender.ts) reads them with the global EMAIL_FROM
-- env as the fallback, so behavior is byte-for-byte unchanged for every
-- existing company (both columns default NULL → fall back to env).
--
-- ── DELIBERATELY NOT IN THIS SLICE (FLAGGED) ────────────────────────────
-- Actually SENDING from a per-company address safely requires domain / SES /
-- Resend sender VERIFICATION per company (SPF/DKIM/DMARC), an operator UI to
-- set + verify it, and a verification-state column before the worker may use a
-- custom from. Shipping the send-path swap without that would let a company
-- spoof an unverified domain and tank deliverability. So this slice ships ONLY
-- the schema + the resolver-with-env-fallback (read path, fallback-safe). The
-- BACKFILL/CONTRACT steps (verification column, operator UI, worker send-path
-- swap, drop of the env default once every company is verified) are tracked in
-- docs/MULTI_TENANCY.md → "Flagged follow-ups".
--
-- `companies` is the tenant REGISTRY (its `id` IS the company_id every child
-- table scopes to); it carries no `company_id` column and is intentionally not
-- in the RLS-FORCE audit set. Access to a company row is gated in the app layer
-- by a `company_memberships` lookup (getCompany() in apps/api/src/server.ts), so
-- adding profile/config columns here needs NO new RLS policy — same as the
-- existing profile columns (migration 102) and the auto-post columns (116).
--
-- Additive / forward-only / idempotent (ADD COLUMN IF NOT EXISTS): safe to
-- re-run, never edits an applied migration. Tolerates the old schema during
-- rollout: old code never reads these columns; new code reads them but the
-- NULL default keeps every company on the env sender. No data is backfilled.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS notification_from_email text,
  ADD COLUMN IF NOT EXISTS notification_from_name text;

COMMENT ON COLUMN companies.notification_from_email IS
  'Per-company From: address for outbound notifications (invites, estimate '
  'shares, sync alerts, welcome emails). NULL (default) = fall back to the '
  'global EMAIL_FROM env. EXPAND-only: not yet used on the send path — that '
  'requires per-company domain/sender VERIFICATION first (see '
  'docs/MULTI_TENANCY.md flagged follow-ups). resolveCompanyNotificationSender '
  'reads this with the env as a fallback so the default posture is unchanged.';

COMMENT ON COLUMN companies.notification_from_name IS
  'Per-company display name paired with notification_from_email (e.g. '
  '"Acme Construction"). NULL (default) = no display name / env behavior. '
  'Same EXPAND-only status + verification gate as notification_from_email.';
