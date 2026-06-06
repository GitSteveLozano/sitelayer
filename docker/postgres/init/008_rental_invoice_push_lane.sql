-- Seed the dispatch lane for the rental phase-2 worker cadence
-- (apps/worker/src/runners/rental-invoice-push.ts). worker.ts references the
-- `rental_invoice_push` lane; this row makes the dispatch-lanes-seed parity test
-- pass and lets operators pause/resume the lane from the admin UI. The 3-value
-- shape (name, state, last_decided_by='system:seed') matches the canonical
-- forward-migration lane-seed pattern; the remaining NOT NULL columns default.
INSERT INTO public.dispatch_lanes (name, state, last_decided_by)
VALUES ('rental_invoice_push', 'active', 'system:seed')
ON CONFLICT DO NOTHING;
