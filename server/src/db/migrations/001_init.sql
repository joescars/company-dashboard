-- 001_init: cached source snapshots and per-source health.
--
-- Generic by design: no source-specific columns, so a new source is added by
-- registering a key in config, not by altering this schema.

CREATE TABLE IF NOT EXISTS snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  payload    TEXT NOT NULL,
  UNIQUE (source, fetched_at)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_source_fetched_at
  ON snapshots (source, fetched_at DESC);

CREATE TABLE IF NOT EXISTS source_state (
  source          TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_error      TEXT,
  last_error_at   TEXT
);