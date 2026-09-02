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

  -- The admin blacked out the author's name. A flag rather than a rewritten handle:
  -- author_instagram cannot hold a "*", and overwriting it would lose the value the
  -- toggle needs to put back.
  handle_censored   INTEGER NOT NULL DEFAULT 0,

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

-- 20260831 ++ RG #rate_limit_survives_a_restart
-- Rate-limit counters. In the database rather than in process memory, so a deploy or a
-- crash does not hand every caller a fresh budget. CREATE TABLE IF NOT EXISTS runs on
-- every open, so an existing install picks this up with no migration.
CREATE TABLE IF NOT EXISTS rate_limits (
  namespace   TEXT NOT NULL,
  key         TEXT NOT NULL,
  count       INTEGER NOT NULL,
  -- Epoch milliseconds. Integer rather than ISO text: this is compared on every single
  -- request, and it is arithmetic, never something a human reads.
  started_at  INTEGER NOT NULL,

  PRIMARY KEY (namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_started ON rate_limits (started_at);

-- Monotonic counters. Kept in a table rather than derived from MAX(author_sequence)
-- so two concurrent submissions can never be handed the same Doe#NNN.
CREATE TABLE IF NOT EXISTS counters (
  name   TEXT PRIMARY KEY,
  value  INTEGER NOT NULL
);
