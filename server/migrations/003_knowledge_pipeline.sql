ALTER TABLE captures
  ADD COLUMN IF NOT EXISTS pipeline_status TEXT,
  ADD COLUMN IF NOT EXISTS pipeline_error TEXT,
  ADD COLUMN IF NOT EXISTS pipeline_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'captures_pipeline_status_check'
  ) THEN
    ALTER TABLE captures
      ADD CONSTRAINT captures_pipeline_status_check
      CHECK (
        pipeline_status IS NULL OR
        pipeline_status IN ('uploaded', 'transcribing', 'structuring', 'ready', 'failed')
      );
  END IF;
END
$$;

ALTER TABLE procedures
  ADD COLUMN IF NOT EXISTS tools_json JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS safety_json JSONB NOT NULL DEFAULT '[]'::JSONB;

CREATE INDEX IF NOT EXISTS captures_pipeline_status_idx
  ON captures(pipeline_status);

CREATE INDEX IF NOT EXISTS procedures_pending_review_idx
  ON procedures(created_at DESC)
  WHERE approved = FALSE;
