ALTER TABLE captures
  ADD COLUMN IF NOT EXISTS total_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS s3_key TEXT,
  ADD COLUMN IF NOT EXISTS s3_upload_id TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

UPDATE captures AS capture
SET total_bytes = COALESCE(
  (
    SELECT MAX(chunk.byte_end) + 1
    FROM chunks AS chunk
    WHERE chunk.capture_id = capture.id
  ),
  0
)
WHERE capture.total_bytes IS NULL;

UPDATE captures
SET s3_key = 'captures/legacy-' || id || '.bin'
WHERE s3_key IS NULL;

ALTER TABLE captures
  ALTER COLUMN total_bytes SET NOT NULL,
  ALTER COLUMN s3_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS captures_idempotency_key_idx
  ON captures(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
