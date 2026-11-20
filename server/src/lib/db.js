import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

/**
 * SQLite persistence for cached source snapshots.
 *
 * Uses Node's built-in `node:sqlite` — no external dependency, no native build
 * step. The database lives under DATA_DIR (default './data') as
 * 'dashboard.sqlite', with WAL and foreign key enforcement enabled.
 *
 * Nothing here is wired into the HTTP app yet; this module is importable on
 * its own and safe to call from tests.
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'db',
  'migrations',
);

const DEFAULT_DATA_DIR = './data';
const DB_FILENAME = 'dashboard.sqlite';

/** Cached singleton handle. */
let db = null;

/** Absolute database file path for a given data dir (exported for tests). */
export function resolveDbPath(dataDir = process.env.DATA_DIR || DEFAULT_DATA_DIR) {
  return path.join(path.resolve(dataDir), DB_FILENAME);
}

/**
 * Open (and cache) the database handle.
 *
 * The path is resolved once from DATA_DIR at first call; pass `dataDir` to
 * override it (tests use this instead of mutating the environment). Calling
 * again without arguments returns the existing handle.
 */
export function getDb({ dataDir } = {}) {
  if (db) return db;

  const targetDir = path.resolve(dataDir || process.env.DATA_DIR || DEFAULT_DATA_DIR);
  fs.mkdirSync(targetDir, { recursive: true });

  db = new DatabaseSync(path.join(targetDir, DB_FILENAME));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

/** Close and forget the cached handle. Safe to call when already closed. */
export function closeDb() {
  if (!db) return;
  try {
    db.close();
  } finally {
    db = null;
  }
}

/** Migration files, sorted by filename so 001 runs before 002. */
function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/**
 * Apply every pending migration in filename order, recording each in
 * `schema_migrations`. Idempotent: already-applied files are skipped, so
 * calling this repeatedly is a no-op.
 *
 * @returns {string[]} names of the migrations applied by this call
 */
export function runMigrations(handle = getDb()) {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const applied = new Set(
    handle.prepare('SELECT name FROM schema_migrations').all().map((row) => row.name),
  );

  const insert = handle.prepare('INSERT INTO schema_migrations (name) VALUES (?)');
  const ran = [];

  for (const name of migrationFiles()) {
    if (applied.has(name)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    // Each migration is atomic: either the whole file lands, or none of it.
    handle.exec('BEGIN');
    try {
      handle.exec(sql);
      insert.run(name);
      handle.exec('COMMIT');
    } catch (error) {
      handle.exec('ROLLBACK');
      throw new Error(`migration ${name} failed: ${error.message}`);
    }
    ran.push(name);
  }

  return ran;
}

/**
 * Store a snapshot for `source`. Serializes the payload to JSON.
 *
 * Passing `fetchedAt` explicitly makes writes testable/deterministic;
 * otherwise the current time is used. Returns the stored row's id and
 * timestamp.
 */
export function saveSnapshot(handle, source, payload, { fetchedAt } = {}) {
  if (!source) throw new TypeError('saveSnapshot: source is required');

  const db_ = handle || getDb();
  const stamp = fetchedAt || new Date().toISOString();
  const json = JSON.stringify(payload ?? null);

  // Re-fetching the same source twice in the same millisecond should replace,
  // not explode — keep the newest payload for a (source, fetched_at) pair.
  const info = db_
    .prepare(
      `INSERT INTO snapshots (source, fetched_at, payload)
       VALUES (?, ?, ?)
       ON CONFLICT (source, fetched_at) DO UPDATE SET payload = excluded.payload`,
    )
    .run(source, stamp, json);

  const row = db_
    .prepare('SELECT id, source, fetched_at FROM snapshots WHERE source = ? AND fetched_at = ?')
    .get(source, stamp);

  return { id: row.id, source: row.source, fetchedAt: row.fetched_at, changes: info.changes };
}

/** Most recent snapshot for a source, or null when none exists. */
export function latestSnapshot(handle, source) {
  const db_ = handle || getDb();
  const row = db_
    .prepare(
      `SELECT id, source, fetched_at, payload
         FROM snapshots
        WHERE source = ?
        ORDER BY fetched_at DESC, id DESC
        LIMIT 1`,
    )
    .get(source);

  if (!row) return null;

  let payload;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    // A corrupt row must not take down the caller; surface the raw text.
    payload = null;
  }

  return {
    id: row.id,
    source: row.source,
    fetchedAt: row.fetched_at,
    payload,
    raw: row.payload,
  };
}

/**
 * Record the outcome of a fetch for a source.
 *
 * On success the success timestamp advances and the last error is cleared;
 * on failure the error and its timestamp are stored and the last success is
 * left untouched (so "last good data" stays readable).
 */
export function recordSourceResult(handle, source, { ok, error } = {}) {
  if (!source) throw new TypeError('recordSourceResult: source is required');

  const db_ = handle || getDb();
  const now = new Date().toISOString();

  if (ok) {
    db_
      .prepare(
        `INSERT INTO source_state (source, last_success_at, last_error, last_error_at)
         VALUES (?, ?, NULL, NULL)
         ON CONFLICT (source) DO UPDATE SET
           last_success_at = excluded.last_success_at,
           last_error      = NULL,
           last_error_at   = NULL`,
      )
      .run(source, now);
  } else {
    db_
      .prepare(
        `INSERT INTO source_state (source, last_success_at, last_error, last_error_at)
         VALUES (?, NULL, ?, ?)
         ON CONFLICT (source) DO UPDATE SET
           last_error    = excluded.last_error,
           last_error_at = excluded.last_error_at`,
      )
      .run(source, error === undefined || error === null ? null : String(error), now);
  }

  return getSourceState(handle, source);
}

/** Current stored state for one source, or null. */
export function getSourceState(handle, source) {
  const db_ = handle || getDb();
  const row = db_
    .prepare(
      `SELECT source, last_success_at, last_error, last_error_at
         FROM source_state
        WHERE source = ?`,
    )
    .get(source);

  if (!row) return null;

  return {
    source: row.source,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
  };
}