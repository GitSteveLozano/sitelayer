-- Phase 4: scan-driven rental dispatch context.
--
-- Workers scan a QR/barcode in the field to dispatch (deliver) or
-- return inventory. The movement row already records the
-- from/to/project/quantity; this migration adds the scan-time
-- attribution (who scanned, what they scanned, where they were).
--
-- Additive only — older clients that POST without these fields keep
-- working. The new columns let a foreman/owner audit which crew
-- physically moved which assets, and let the utilization rollup
-- surface "scanned by Worker X at 8:42a" in the timeline.

ALTER TABLE inventory_movements
  ADD COLUMN IF NOT EXISTS worker_id uuid,
  ADD COLUMN IF NOT EXISTS clerk_user_id text,
  ADD COLUMN IF NOT EXISTS scan_payload text,
  ADD COLUMN IF NOT EXISTS scanned_at timestamptz,
  ADD COLUMN IF NOT EXISTS lat numeric(10,7),
  ADD COLUMN IF NOT EXISTS lng numeric(10,7);

ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_worker_fk
    FOREIGN KEY (company_id, worker_id) REFERENCES workers(company_id, id) ON DELETE SET NULL
  NOT VALID;

ALTER TABLE inventory_movements VALIDATE CONSTRAINT inventory_movements_worker_fk;

CREATE INDEX IF NOT EXISTS inventory_movements_scanned_idx
  ON inventory_movements (company_id, scanned_at desc)
  WHERE scanned_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS inventory_movements_worker_idx
  ON inventory_movements (company_id, worker_id, occurred_on desc)
  WHERE worker_id IS NOT NULL;
