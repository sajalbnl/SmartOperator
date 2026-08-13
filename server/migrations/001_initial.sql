DO $$
BEGIN
  CREATE TYPE chunk_state AS ENUM ('pending', 'uploading', 'failed', 'done');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS captures (
  id BIGSERIAL PRIMARY KEY,
  machine_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  duration_s INTEGER NOT NULL CHECK (duration_s >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chunks (
  id BIGSERIAL PRIMARY KEY,
  capture_id BIGINT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number > 0),
  byte_start BIGINT NOT NULL CHECK (byte_start >= 0),
  byte_end BIGINT NOT NULL CHECK (byte_end >= byte_start),
  etag TEXT,
  state chunk_state NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (capture_id, part_number)
);

CREATE TABLE IF NOT EXISTS transcripts (
  id BIGSERIAL PRIMARY KEY,
  capture_id BIGINT NOT NULL UNIQUE REFERENCES captures(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS procedures (
  id BIGSERIAL PRIMARY KEY,
  capture_id BIGINT NOT NULL UNIQUE REFERENCES captures(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  steps_json JSONB NOT NULL DEFAULT '[]'::JSONB,
  source TEXT NOT NULL DEFAULT 'capture',
  approved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sops (
  id BIGSERIAL PRIMARY KEY,
  machine_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chunks_capture_id_idx ON chunks(capture_id);
CREATE INDEX IF NOT EXISTS sops_machine_id_idx ON sops(machine_id);

