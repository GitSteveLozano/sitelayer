-- 053_rental_returns_transfer.sql
--
-- Returns reconciliation, project-to-project transfer, customer rental portal.
--
-- Backfills the existing `rentals` row with structured return-condition counts
-- (good/damaged/lost) plus a damage-charges field and an optional photo set.
-- Adds a self-referencing pointer for transfer chains so the original rental
-- can be tracked across project boundaries without forking the rental_billing
-- workflow (the new rental row simply continues from `delivered_on=transfer_at`).
--
-- Adds two new tables:
--   * rental_share_links — HMAC-signed customer portal access tokens, mirrors
--     the estimate_share_links shape from the sales-loop slice.
--   * rental_requests    — operator-review queue for portal "Reserve" submissions
--     (operators approve to convert into a real rental).
--
-- The `damage_work_order_id uuid` column is intentionally NULL with no FK —
-- a future `work_orders` table will own that side of the relationship; for
-- now this row is a loose pointer so existing routes don't have to wait on
-- the work-order migration.

-- ---------------------------------------------------------------------------
-- rentals: return reconciliation + transfer chain
-- ---------------------------------------------------------------------------

ALTER TABLE rentals
  ADD COLUMN IF NOT EXISTS qty_good int,
  ADD COLUMN IF NOT EXISTS qty_damaged int,
  ADD COLUMN IF NOT EXISTS qty_lost int,
  ADD COLUMN IF NOT EXISTS damage_photos text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS damage_charges_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS damage_work_order_id uuid,
  ADD COLUMN IF NOT EXISTS transferred_from_rental_id uuid;

-- Self-referential FK lives outside the column list so older databases that
-- have already been altered don't trip the IF NOT EXISTS guard.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'rentals_transferred_from_rental_id_fkey'
  ) THEN
    ALTER TABLE rentals
      ADD CONSTRAINT rentals_transferred_from_rental_id_fkey
      FOREIGN KEY (transferred_from_rental_id) REFERENCES rentals(id) ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS rentals_transferred_from_idx
  ON rentals (transferred_from_rental_id)
  WHERE transferred_from_rental_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- rental_share_links — signed-token gated customer portal access
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rental_share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  share_token text NOT NULL UNIQUE,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS rental_share_links_company_idx
  ON rental_share_links (company_id);

-- ---------------------------------------------------------------------------
-- rental_requests — portal "Reserve" submissions awaiting operator approval
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rental_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  share_link_id uuid REFERENCES rental_share_links(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  -- Free-form line items as JSON: [{ inventory_item_id, qty, start, end, delivery }]
  -- Operators reconcile these against the catalog when approving.
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_start date,
  requested_end date,
  contact_name text,
  contact_email text,
  contact_phone text,
  notes text,
  status text NOT NULL DEFAULT 'pending',
  approved_at timestamptz,
  approved_by text,
  rejected_at timestamptz,
  converted_rental_id uuid REFERENCES rentals(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rental_requests_pending_idx
  ON rental_requests (company_id, status, created_at DESC)
  WHERE status = 'pending';
