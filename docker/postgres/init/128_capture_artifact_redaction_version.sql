-- Every capture artifact carries the redaction policy version that made it
-- safe to store and summarize. This lets later analyzer/reviewer code reject
-- artifacts created under an obsolete policy without inspecting raw bytes.

ALTER TABLE capture_artifacts
  ADD COLUMN IF NOT EXISTS redaction_version text NOT NULL DEFAULT 'capture-session-v1';
