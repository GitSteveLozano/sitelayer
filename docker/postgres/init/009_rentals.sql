-- 009_rentals.sql
--
-- Equipment rentals for the Avontus-style side of the business (WhatsApp:202-218).
-- Each row models one rented item with a delivery date, a daily rate, and a
-- rolling invoice clock. A background job in `apps/worker` drains rentals whose
-- `next_invoice_at` has passed and produces a `material_bills` row of
-- `bill_type='rental'` per cadence tick.
--
-- Design notes:
--   * `delivered_on` is required and drives the billing clock; until the item
--     is returned, `returned_on` stays NULL and the rental is considered
--     active.
--   * `next_invoice_at` is set on create/update to
--     `delivered_on + invoice_cadence_days` and advanced by
--     `invoice_cadence_days` each time an invoice fires.
--   * `status` is a denormalized flag so the heartbeat query can skip closed
--     rentals without joining `returned_on IS NULL` and cadence math.
--     Transitions: active -> returned (when mark-returned happens) -> closed
--     (once the returned rental has been fully invoiced).
--   * Soft delete via `deleted_at` matches the convention used for other
--     company-scoped entities in the schema.
--   * The composite FK from (company_id, project_id) to
--     projects(company_id, id) keeps tenant scoping sound, mirroring how
--     material_bills, labor_entries, and blueprint_documents are anchored.

CREATE TABLE IF NOT EXISTS rentals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  item_description text NOT NULL,
  daily_rate numeric(12,2) NOT NULL DEFAULT 0,
  delivered_on date NOT NULL,
  returned_on date,
  next_invoice_at timestamptz,
  invoice_cadence_days int NOT NULL DEFAULT 7,
  last_invoice_amount numeric(12,2),
  last_invoiced_through date,
  status text NOT NULL DEFAULT 'active',
  notes text,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS rentals_active_idx
  ON rentals (company_id, status, next_invoice_at)
  WHERE deleted_at IS NULL;
