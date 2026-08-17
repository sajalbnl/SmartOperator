ALTER TABLE procedures
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'procedures_review_state_check'
  ) THEN
    ALTER TABLE procedures
      ADD CONSTRAINT procedures_review_state_check
      CHECK (NOT (approved = TRUE AND rejected_at IS NOT NULL));
  END IF;
END
$$;

DROP INDEX IF EXISTS procedures_pending_review_idx;

CREATE INDEX procedures_pending_review_idx
  ON procedures(created_at DESC)
  WHERE approved = FALSE AND rejected_at IS NULL;
