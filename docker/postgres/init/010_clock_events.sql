-- 010_clock_events.sql
--
-- Geofenced passive clock-in/out for crew members (WhatsApp:103-121).
-- Cavy described this as "the big thing" for adoption.
--
-- Shape:
--   projects grows site_lat/site_lng/site_radius_m so each job can have a
--   geofence centered on the site. Radius defaults to 100m which fits the
--   typical residential lot / small commercial setback.
--   clock_events is append-only; 'in' and 'out' pair up by being the most
--   recent event of their opposite type for the same worker. We also carry
--   inside_geofence so we can tell if the device thought it was on-site at
--   punch time without recomputing later.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS site_lat numeric(9,6),
  ADD COLUMN IF NOT EXISTS site_lng numeric(9,6),
  ADD COLUMN IF NOT EXISTS site_radius_m int DEFAULT 100;

CREATE TABLE IF NOT EXISTS clock_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  worker_id uuid REFERENCES workers(id) ON DELETE SET NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  clerk_user_id text,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  lat numeric(9,6),
  lng numeric(9,6),
  accuracy_m numeric(8,2),
  inside_geofence boolean,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS clock_events_worker_idx
  ON clock_events(company_id, worker_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS clock_events_project_idx
  ON clock_events(company_id, project_id, occurred_at DESC);
