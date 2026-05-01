-- 029_geofence_policy.sql
--
-- Per-project geofence policy + clock_events provenance.
--
-- Existing 010_clock_events.sql gave projects (site_lat, site_lng,
-- site_radius_m) — the geofence shape — and clock_events.inside_geofence
-- — the boolean snapshot at punch time. This migration adds the *policy*
-- around it that the field-trustable design (Sitemap.html § wk-clockin,
-- prj-geofence) requires.
--
-- Two separable concerns:
--
-- 1. Policy on projects. The design lets a foreman pick whether
--    auto clock-in fires on geofence entry, or whether the geofence is
--    only a reminder ("you're on site — clock in?"). This is per-project
--    so a sensitive client site can keep manual-only while routine
--    repeats default to auto. The grace period covers the gap between
--    physical exit and geofence-detected exit (typically 30s–5min);
--    too short and crews get clocked out for a bathroom break, too long
--    and they're paid for driving home.
--
--    The correction window is the worker's "wait, that wasn't me"
--    affordance. The wk-clockin design shows a 2-minute confirmation
--    surface — within that window the worker can void the auto-event
--    without an admin override.
--
-- 2. Provenance on clock_events. Today every row is implicitly manual.
--    The new `source` column distinguishes manual (UI tap), auto_geofence
--    (PWA fired the event because the geofence was crossed), and
--    foreman_override (foreman entered for the worker). The Time tab's
--    approval queue surfaces these flags so reviewers can see *why* an
--    entry exists, not just that it does.
--
--    `correctible_until` is the per-event deadline computed at insert
--    time as occurred_at + auto_clock_correction_window_seconds. NULL
--    for manual events because they don't need a separate correction
--    window — the user just submitted them.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS auto_clock_in_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_clock_out_grace_seconds int NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS auto_clock_correction_window_seconds int NOT NULL DEFAULT 120,
  ADD CONSTRAINT projects_auto_clock_grace_chk CHECK (
    auto_clock_out_grace_seconds BETWEEN 0 AND 3600
  ),
  ADD CONSTRAINT projects_auto_clock_correction_chk CHECK (
    auto_clock_correction_window_seconds BETWEEN 0 AND 1800
  );

ALTER TABLE clock_events
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS correctible_until timestamptz,
  ADD CONSTRAINT clock_events_source_chk CHECK (
    source IN ('manual', 'auto_geofence', 'foreman_override')
  );

CREATE INDEX IF NOT EXISTS clock_events_source_idx
  ON clock_events (company_id, source, occurred_at DESC)
  WHERE source <> 'manual';

CREATE INDEX IF NOT EXISTS clock_events_correctible_idx
  ON clock_events (company_id, correctible_until)
  WHERE correctible_until IS NOT NULL;
