-- Server-side session storage.
--
-- Sessions live in SQLite rather than in process memory so that restarting or
-- redeploying the container does not sign everyone out, and so memory use stays
-- bounded. The row is keyed by express-session's session id.

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);