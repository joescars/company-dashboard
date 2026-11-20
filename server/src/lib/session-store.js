import session from 'express-session';

import { getDb } from './db.js';

/**
 * express-session store backed by SQLite.
 *
 * The default MemoryStore is explicitly not for production — it leaks and
 * forgets sessions on restart. Since the database is already here, this store
 * costs one table and keeps logins across container restarts.
 */
export class SqliteSessionStore extends session.Store {
  constructor({ db = getDb() } = {}) {
    super();
    this.db = db;
    this.ensureSchema();
    this.sweep();
  }

  ensureSchema() {
    // Migration 002 also creates this; creating here keeps the store usable
    // when it is constructed before migrations have run (tests, early boot).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid        TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
    `);
  }

  /** Drop rows whose expiry has passed. Called on start and opportunistically. */
  sweep() {
    try {
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    } catch {
      // A sweep failure must never take down the request path.
    }
  }

  get(sid, callback) {
    try {
      const row = this.db
        .prepare('SELECT data, expires_at FROM sessions WHERE sid = ?')
        .get(sid);

      if (!row) return callback(null, null);
      if (row.expires_at <= Date.now()) {
        this.destroy(sid, () => callback(null, null));
        return undefined;
      }

      return callback(null, JSON.parse(row.data));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, data, callback) {
    try {
      const expiresAt = expiryOf(data);
      this.db
        .prepare(
          `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
           ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
        )
        .run(sid, JSON.stringify(data), expiresAt);
      return callback ? callback(null) : undefined;
    } catch (error) {
      return callback ? callback(error) : undefined;
    }
  }

  destroy(sid, callback) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      return callback ? callback(null) : undefined;
    } catch (error) {
      return callback ? callback(error) : undefined;
    }
  }

  touch(sid, data, callback) {
    try {
      this.db
        .prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?')
        .run(expiryOf(data), sid);
      return callback ? callback(null) : undefined;
    } catch (error) {
      return callback ? callback(error) : undefined;
    }
  }
}

/** Session expiry as epoch milliseconds. */
function expiryOf(data) {
  const expires = data?.cookie?.expires;
  if (expires) {
    const parsed = expires instanceof Date ? expires.getTime() : Date.parse(expires);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now() + 7 * 24 * 60 * 60 * 1000;
}