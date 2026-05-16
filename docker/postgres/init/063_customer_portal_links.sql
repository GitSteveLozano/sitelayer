-- Customer portal links — generalize the estimate-share-link pattern to
-- cover invoices, daily photos, and scaffold inspections.
--
-- estimate_share_links stays as-is (it's a frozen-snapshot record for
-- a single estimate). This new table is the persistent portal entry: one
-- token per (company, customer or project) that exposes a configurable
-- subset of read-only artifacts. Visibility is gated by both
-- companies.portal_settings (set per tenant) and the per-link allows[]
-- override.

CREATE TABLE IF NOT EXISTS customer_portal_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  project_id uuid,
  portal_token text UNIQUE NOT NULL,
  recipient_email text,
  recipient_name text,
  -- Per-link allow-list. Empty array = inherit companies.portal_settings.
  -- Otherwise restricts to the listed kinds:
  --   estimates | invoices | photos | inspections | shipments | schedules
  allows jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '180 days'),
  revoked_at timestamptz,
  viewed_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  origin text DEFAULT current_setting('app.tier', true),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_portal_links_token_min_length
    CHECK (length(portal_token) >= 32),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS customer_portal_links_token_idx
  ON customer_portal_links (portal_token);

CREATE INDEX IF NOT EXISTS customer_portal_links_company_idx
  ON customer_portal_links (company_id, customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS customer_portal_links_active_idx
  ON customer_portal_links (company_id, expires_at)
  WHERE revoked_at IS NULL;
