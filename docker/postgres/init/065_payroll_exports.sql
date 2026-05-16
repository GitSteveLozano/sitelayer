-- Payroll exporters: XLSX / Xero / Payworks.
--
-- labor_payroll_runs already pushes a QBO TimeActivity batch. This table
-- records every other format the same run is exported to, so a bookkeeper
-- can pull an XLSX while QBO is still posting, and a Xero-only customer
-- can skip the QBO push entirely.
--
-- Artifacts are written to blob storage (Spaces in prod, local FS in dev)
-- under a stable path; storage_path is opaque to the DB. format is enum'd
-- so unknown values fail at write time.

CREATE TABLE IF NOT EXISTS payroll_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id uuid NOT NULL,
  format text NOT NULL CHECK (format IN ('xlsx', 'csv', 'xero_csv', 'payworks_csv', 'json')),
  storage_path text,
  download_url text,             -- presigned, expires; not the source of truth
  presigned_expires_at timestamptz,
  byte_size bigint,
  row_count integer,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed', 'expired')),
  error text,
  requested_by_user_id text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  origin text DEFAULT current_setting('app.tier', true),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, payroll_run_id) REFERENCES labor_payroll_runs(company_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS payroll_exports_run_idx
  ON payroll_exports (company_id, payroll_run_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS payroll_exports_pending_idx
  ON payroll_exports (company_id, requested_at)
  WHERE status = 'pending';
