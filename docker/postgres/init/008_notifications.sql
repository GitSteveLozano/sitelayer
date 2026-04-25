CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  recipient_clerk_user_id text,
  recipient_email text,
  kind text NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempt_count int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_pending_idx
  ON notifications(next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS notifications_company_idx
  ON notifications(company_id, created_at DESC);
