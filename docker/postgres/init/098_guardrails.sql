-- 098_guardrails.sql
--
-- Guardrails — per-project threshold monitors that drive the v2 owner
-- dashboard's calm-vs-attention behaviour (workflow 03 · OWNER) and the
-- PROJECT · AT RISK state (workflow 07). A guardrail watches one metric
-- (labor margin, schedule slip, or a safety flag); when current_value crosses
-- threshold it flips to 'triggered', which is what raises the bold-yellow
-- attention card. The owner can snooze (re-arms after snoozed_until) or mute
-- (with a reason) so the dashboard stays calm by default and only shouts when
-- something genuinely needs eyes.
--
-- This is a lightweight monitor, not a human approval workflow, so it carries a
-- plain status enum rather than state_version/event-log. Transitions are driven
-- by (a) a background evaluator that sets current_value + arms/triggers, and
-- (b) user snooze/mute actions from the dashboard.
--
-- status:
--   armed     → watching; not currently breached
--   triggered → threshold crossed; surfaces the attention card
--   snoozed   → user deferred until snoozed_until (then re-evaluates)
--   muted     → user dismissed with muted_reason; stays quiet until cleared
--
-- type:
--   margin   → labor/cost burn vs bid (e.g. trending below target margin)
--   schedule → days behind plan
--   safety   → a safety flag / stop-work condition

CREATE TABLE IF NOT EXISTS guardrails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  type text NOT NULL
    CHECK (type IN ('margin', 'schedule', 'safety')),

  -- The breach boundary and the latest observed value (semantics depend on
  -- type: a margin % floor, a days-behind cap, or a 0/1 safety flag).
  threshold numeric(14, 4) NOT NULL DEFAULT 0,
  current_value numeric(14, 4) NOT NULL DEFAULT 0,

  status text NOT NULL DEFAULT 'armed'
    CHECK (status IN ('armed', 'triggered', 'snoozed', 'muted')),

  -- Set when the breach was first detected (cleared when it re-arms).
  triggered_at timestamptz,
  -- snoozed: re-evaluate after this instant. muted: muted_reason is required
  -- by the route (free text), and the guardrail stays quiet until cleared.
  snoozed_until timestamptz,
  muted_reason text,

  -- Short human label + last evaluator detail, surfaced on the attention card.
  label text NOT NULL DEFAULT '',
  detail text NOT NULL DEFAULT '',

  origin text DEFAULT current_setting('app.tier', true),
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  -- One live guardrail per (project, type); re-evaluation updates in place.
  UNIQUE (project_id, type)
);

-- The owner dashboard asks "is anything triggered across my company?" — keep
-- the index tiny by only covering the loud states.
CREATE INDEX IF NOT EXISTS guardrails_company_active_idx
  ON guardrails (company_id, status, triggered_at DESC)
  WHERE deleted_at IS NULL AND status IN ('triggered', 'snoozed');

CREATE INDEX IF NOT EXISTS guardrails_project_idx
  ON guardrails (project_id)
  WHERE deleted_at IS NULL;
