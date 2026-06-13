-- Seed the dispatch lane for Mobile Ops onsite capture-router retry delivery.
--
-- The API path attempts capture-router delivery synchronously so the phone gets
-- immediate feedback, but retryable failures remain in mutation_outbox as
-- mutation_type='ops_diagnostic_capture_route'. The worker runner owns this
-- lane and replays those ProjectEvent envelopes without another phone tap.
--
-- Canonical forward-migration lane-seed pattern (008_rental_invoice_push_lane);
-- the remaining NOT NULL columns default.
INSERT INTO public.dispatch_lanes (name, state, last_decided_by)
VALUES ('ops_diagnostic_capture_route', 'active', 'system:seed')
ON CONFLICT (name) DO NOTHING;
