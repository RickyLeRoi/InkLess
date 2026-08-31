-- backend/src/adapters/persistence/schema.sql

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  original_text     TEXT NOT NULL,
  text              TEXT NOT NULL,
  author_instagram  TEXT,
  author_sequence   INTEGER,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  print_count       INTEGER NOT NULL DEFAULT 0 CHECK (print_count >= 0),
  created_at        TEXT NOT NULL,

  -- Set once the LLM stage has had its say. A pending message carrying a timestamp
  -- here is waiting on a human and must never be sent to the model again.
  llm_reviewed_at   TEXT,

  -- JSON array of rule identifiers, so the admin panel can say why this is here.
  moderation_reasons TEXT,

  -- Exactly one identity: a real handle, or a generated Doe#NNN sequence.
  CHECK ((author_instagram IS NOT NULL) <> (author_sequence IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_messages_status_created
  ON messages (status, created_at DESC);

-- Drives both the queue-depth count and the batch selection.
CREATE INDEX IF NOT EXISTS idx_messages_awaiting_llm
  ON messages (status, llm_reviewed_at);

CREATE TABLE IF NOT EXISTS print_jobs (
  id                 TEXT PRIMARY KEY,
  message_id         TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  printer_instagram  TEXT,
  amount_cents       INTEGER NOT NULL CHECK (amount_cents >= 51),
  payment_ref        TEXT UNIQUE,
  status             TEXT NOT NULL CHECK (status IN ('awaiting_payment', 'queued', 'printing', 'completed', 'failed')),
  video_url          TEXT,
  failure_reason     TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_print_jobs_message ON print_jobs (message_id);

-- Monotonic counters. Kept in a table rather than derived from MAX(author_sequence)
-- so two concurrent submissions can never be handed the same Doe#NNN.
CREATE TABLE IF NOT EXISTS counters (
  name   TEXT PRIMARY KEY,
  value  INTEGER NOT NULL
);
