-- 052_estimate_share_links.sql
--
-- Sales Loop (Loop 5 from the design handoff) — public-facing estimate
-- share links so an estimator can send a frozen estimate to a customer
-- and capture their accept/decline + signature without forcing the
-- customer through Clerk auth.
--
-- One row per send. The estimate_snapshot column captures the line
-- items + totals at send time so accept/decline and the public portal
-- view stay deterministic even if the project's live estimate_lines
-- change after the link goes out (mirrors estimate_pushes, which
-- captures snapshot_lines for the QBO push path — same idea, different
-- consumer).
--
-- Public access is gated by share_token (HMAC-derived; verified in
-- apps/api/src/estimate-share-token.ts) and by expires_at. The portal
-- route increments view_count, sets viewed_at on first view, and
-- accepts/declines flip accepted_at / declined_at exactly once
-- (subsequent attempts return the existing terminal state).

CREATE TABLE IF NOT EXISTS estimate_share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  estimate_snapshot jsonb NOT NULL,
  share_token text UNIQUE NOT NULL,
  recipient_email text,
  recipient_name text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  accepted_at timestamptz,
  declined_at timestamptz,
  decline_reason text,
  viewed_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  signature_data_url text,
  signer_name text,
  signer_ip inet,
  -- Audit + tier-isolation marker (matches the rest of the schema —
  -- 002_tier_origin.sql precedent: every per-tenant table tags its
  -- writes with the active tier so cross-tier copies are detectable).
  origin text DEFAULT current_setting('app.tier', true),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT estimate_share_links_share_token_min_length
    CHECK (length(share_token) >= 32),
  FOREIGN KEY (company_id, project_id)
    REFERENCES projects(company_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS estimate_share_links_project_idx
  ON estimate_share_links (company_id, project_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS estimate_share_links_share_token_idx
  ON estimate_share_links (share_token);

-- Partial index for the "still pending" lookup: useful for a
-- forthcoming follow-up reminder job that needs to find all
-- non-accepted, non-declined, non-expired links.
CREATE INDEX IF NOT EXISTS estimate_share_links_pending_idx
  ON estimate_share_links (company_id, expires_at)
  WHERE accepted_at IS NULL AND declined_at IS NULL;
