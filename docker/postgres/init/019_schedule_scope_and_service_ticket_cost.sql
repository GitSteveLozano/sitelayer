-- 019_schedule_scope_and_service_ticket_cost.sql
--
-- Wave-2 data-truth fixes (design-fidelity audit 2026-06-12). Two additive,
-- nullable columns; no backfill required, old rows read as NULL.
--
-- 1) crew_schedules.scope — the New Assignment sheet's SCOPE field (msg__66)
--    was captured client-side only and silently dropped before the POST
--    (audit M09 #10, a regression: the 05-31 fix wave claimed it was
--    threaded). This column makes the field real end-to-end: POST
--    /api/schedules persists it and the schedule read surfaces return it so
--    the crew actually sees what they're being sent to do.
ALTER TABLE public.crew_schedules
  ADD COLUMN IF NOT EXISTS scope text;

COMMENT ON COLUMN public.crew_schedules.scope IS
  'Free-text work scope for the assignment (e.g. "EPS East — anchor + plate top to bottom."). NULL = none given.';

-- 2) inventory_service_tickets.{service_type, cost_cents} — the mobile
--    service log (msg__75, audit M10 #9) kept entries in component state and
--    its SPENT·YTD KPI always read $0. The durable backend already existed
--    (inventory_service_tickets) but carried no maintenance type or cost, so
--    the design's headline KPI had nothing real to sum. Cost is integer
--    cents (labor-burden precedent), never estimated; NULL = not recorded.
ALTER TABLE public.inventory_service_tickets
  ADD COLUMN IF NOT EXISTS service_type text,
  ADD COLUMN IF NOT EXISTS cost_cents integer;

-- Guarded check constraint so a negative cost can never be recorded.
-- (Same re-run-safe pattern as 018_takeoff_capture_async.sql.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_service_tickets_cost_cents_check'
  ) THEN
    ALTER TABLE public.inventory_service_tickets
      ADD CONSTRAINT inventory_service_tickets_cost_cents_check
      CHECK (cost_cents IS NULL OR cost_cents >= 0);
  END IF;
END
$$;

COMMENT ON COLUMN public.inventory_service_tickets.service_type IS
  'Short maintenance type for the service-log row (e.g. "Oil change"). NULL on pre-019 rows and desktop-opened tickets that only carry notes.';
COMMENT ON COLUMN public.inventory_service_tickets.cost_cents IS
  'Maintenance cost in integer cents — feeds the mobile service-log SPENT·YTD KPI. NULL = cost not recorded (never estimated).';
