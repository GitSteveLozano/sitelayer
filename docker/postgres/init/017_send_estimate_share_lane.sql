-- Seed the dispatch lane for the estimate-share delivery email runner
-- (apps/worker/src/runners/estimate-share-email.ts). worker.ts wraps the
-- runner in runIfLaneActive('send_estimate_share', ...); this row makes the
-- dispatch-lanes-seed parity test pass and gives operators a dedicated
-- kill-switch for estimate-share sends, separate from the broad
-- 'notifications' lane it was provisionally gated under.
--
-- Pausing this lane is SAFE under the inverted outbox contract (introduced
-- with the same change set): send_estimate_share rows stay pending for this
-- runner; the generic drain can never claim them.
--
-- The 3-value shape (name, state, last_decided_by='system:seed') matches the
-- canonical forward-migration lane-seed pattern (008_rental_invoice_push_lane);
-- the remaining NOT NULL columns default.
INSERT INTO public.dispatch_lanes (name, state, last_decided_by)
VALUES ('send_estimate_share', 'active', 'system:seed')
ON CONFLICT DO NOTHING;
