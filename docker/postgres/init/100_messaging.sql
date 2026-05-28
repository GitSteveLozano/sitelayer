-- 100_messaging.sql
--
-- Cross-role comms (Steve's v2, workflow 11 · CROSS-ROLE): project chat threads
-- + owner one-way broadcast. The per-user notification inbox + activity log
-- already exist (008_notifications.sql, audit_events); this adds the two surfaces
-- that need real persistence:
--
--   project_messages — a chat thread per project. Every role on the project can
--     post; messages are role-tagged so the thread reads like the v2 mock
--     (OWNER / FOREMAN / WORKER chips). Append-only conversation; no edit/delete
--     beyond soft-delete.
--
--   broadcasts — owner → crew one-way announcement (no replies). Audience is a
--     coarse band (all / foremen / crew). Surfaced read-only on the recipient's
--     notifications/home; the broadcast row is the source of truth.
--
-- Both are plain append tables (not deterministic workflows) — there is no
-- multi-step state machine, just create + read + soft-delete.

CREATE TABLE IF NOT EXISTS project_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  author_user_id text NOT NULL,            -- Clerk user id of the sender
  -- Role the author was wearing when they posted (admin|foreman|office|member|
  -- bookkeeper), captured at write time so the thread renders role chips even
  -- if the membership role later changes.
  author_role text NOT NULL DEFAULT '',
  body text NOT NULL,

  origin text DEFAULT current_setting('app.tier', true),
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);

-- Thread read: newest-or-oldest first by project. Most reads are "the thread
-- for one project" so this composite covers it.
CREATE INDEX IF NOT EXISTS project_messages_project_idx
  ON project_messages (project_id, created_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS project_messages_company_idx
  ON project_messages (company_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  author_user_id text NOT NULL,
  -- Coarse audience band. 'all' = everyone in the company; 'foremen' / 'crew'
  -- filter on company_memberships role at fan-out time.
  audience text NOT NULL DEFAULT 'all'
    CHECK (audience IN ('all', 'foremen', 'crew')),
  body text NOT NULL,
  -- Optional project scope (NULL = company-wide).
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,

  origin text DEFAULT current_setting('app.tier', true),
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);

CREATE INDEX IF NOT EXISTS broadcasts_company_idx
  ON broadcasts (company_id, created_at DESC)
  WHERE deleted_at IS NULL;
