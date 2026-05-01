-- QBO access token expiry tracking.
--
-- Intuit QBO access tokens are valid for ~1 hour after they're issued at
-- OAuth time. Without an expiry column the worker push paths re-use the
-- stored token forever and start 401ing roughly 60 minutes after the
-- OAuth callback ran. This migration adds the column so we can:
--   1. populate it from `expires_in` on OAuth callback,
--   2. cheaply check `now() < access_token_expires_at - interval '60 seconds'`
--      from the worker before invoking the QBO REST API,
--   3. fall back to the refresh-token grant when the access token is
--      about to expire (or already 401s on use).
--
-- Existing rows have NULL for this column, which means "expiry unknown" —
-- the worker treats unknown expiry as "needs refresh on first use" so we
-- don't keep handing out a stale token. Once any push runs through the
-- new refresh path the column is populated and stays current.

ALTER TABLE integration_connections
  ADD COLUMN IF NOT EXISTS access_token_expires_at timestamptz;
