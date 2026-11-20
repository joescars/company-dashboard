import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeDb,
  getDb,
  getSourceState,
  latestSnapshot,
  recordSourceResult,
  resolveDbPath,
  runMigrations,
  saveSnapshot,
} from '../src/lib/db.js';

/** Fresh temp data dir per test so nothing leaks between cases. */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cdb-'));
}

/** Open a migrated database in its own temp dir; caller must closeDb(). */
function freshDb() {
  closeDb();
  const dir = tempDir();
  const db = getDb({ dataDir: dir });
  runMigrations(db);
  return { db, dir };
}

test('getDb creates the data dir and the db file', () => {
  closeDb();
  const dir = path.join(tempDir(), 'nested', 'data');
  assert.equal(fs.existsSync(dir), false, 'precondition: dir does not exist yet');

  const db = getDb({ dataDir: dir });
  try {
    assert.equal(fs.existsSync(dir), true, 'data dir must be created');
    const file = resolveDbPath(dir);
    assert.equal(fs.existsSync(file), true, 'database file must exist');
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  } finally {
    closeDb();
  }
});

test('getDb is a singleton honoring the resolved path', () => {
  closeDb();
  const dir = tempDir();
  try {
    const first = getDb({ dataDir: dir });
    const second = getDb({ dataDir: tempDir() });
    assert.equal(first, second, 'second call returns the cached handle');
  } finally {
    closeDb();
  }
});

test('migrations apply once and are idempotent', () => {
  closeDb();
  const dir = tempDir();
  try {
    const db = getDb({ dataDir: dir });

    const first = runMigrations(db);
    assert.ok(first.includes('001_init.sql'), 'first run applies 001_init.sql');
    assert.ok(first.length > 0, 'first run applies at least one migration');

    const second = runMigrations(db);
    assert.deepEqual(second, [], 'second run applies nothing');

    const recorded = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all();
    const names = recorded.map((r) => r.name);
    assert.deepEqual(names, first, 'every applied migration is recorded exactly once');
    assert.equal(new Set(names).size, names.length, 'no duplicate migration rows');

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.ok(tables.includes('snapshots'), 'snapshots table exists');
    assert.ok(tables.includes('source_state'), 'source_state table exists');
    assert.ok(tables.includes('schema_migrations'), 'schema_migrations table exists');
    assert.ok(tables.includes('sessions'), 'sessions table exists');
  } finally {
    closeDb();
  }
});

test('saveSnapshot + latestSnapshot round-trip JSON payloads', () => {
  const { db } = freshDb();
  try {
    const payload = { views: 42, nested: { ok: true }, rows: [1, 2, 3] };
    const saved = saveSnapshot(db, 'openrouter', payload, { fetchedAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(saved.source, 'openrouter');
    assert.equal(saved.fetchedAt, '2026-01-01T00:00:00.000Z');
    assert.ok(Number.isInteger(saved.id));

    const latest = latestSnapshot(db, 'openrouter');
    assert.equal(latest.id, saved.id);
    assert.equal(latest.source, 'openrouter');
    assert.equal(latest.fetchedAt, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(latest.payload, payload, 'payload survives the JSON round-trip');
  } finally {
    closeDb();
  }
});

test('latestSnapshot returns the newest fetch and null when empty', () => {
  const { db } = freshDb();
  try {
    assert.equal(latestSnapshot(db, 'ga4'), null, 'no rows yet');

    saveSnapshot(db, 'ga4', { n: 1 }, { fetchedAt: '2026-02-01T00:00:00.000Z' });
    saveSnapshot(db, 'ga4', { n: 2 }, { fetchedAt: '2026-03-01T00:00:00.000Z' });
    saveSnapshot(db, 'ga4', { n: 3 }, { fetchedAt: '2026-02-15T00:00:00.000Z' });

    const latest = latestSnapshot(db, 'ga4');
    assert.deepEqual(latest.payload, { n: 2 }, 'ordered by fetched_at, not insertion');
    assert.equal(latest.fetchedAt, '2026-03-01T00:00:00.000Z');
  } finally {
    closeDb();
  }
});

test('snapshots are scoped per source', () => {
  const { db } = freshDb();
  try {
    saveSnapshot(db, 'azure', { cost: 5 }, { fetchedAt: '2026-04-01T00:00:00.000Z' });
    saveSnapshot(db, 'adsense', { revenue: 9 }, { fetchedAt: '2026-04-02T00:00:00.000Z' });

    assert.deepEqual(latestSnapshot(db, 'azure').payload, { cost: 5 });
    assert.deepEqual(latestSnapshot(db, 'adsense').payload, { revenue: 9 });
  } finally {
    closeDb();
  }
});

test('the UNIQUE(source, fetched_at) constraint replaces rather than duplicates', () => {
  const { db } = freshDb();
  try {
    const at = '2026-05-01T00:00:00.000Z';
    saveSnapshot(db, 'searchConsole', { impressions: 1 }, { fetchedAt: at });
    saveSnapshot(db, 'searchConsole', { impressions: 2 }, { fetchedAt: at });

    const rows = db
      .prepare('SELECT payload FROM snapshots WHERE source = ? AND fetched_at = ?')
      .all('searchConsole', at);
    assert.equal(rows.length, 1, 'exactly one row for a (source, fetched_at) pair');
    assert.deepEqual(JSON.parse(rows[0].payload), { impressions: 2 }, 'newest payload wins');
  } finally {
    closeDb();
  }
});

test('the raw UNIQUE constraint rejects a duplicate insert', () => {
  const { db } = freshDb();
  try {
    const at = '2026-05-02T00:00:00.000Z';
    db.prepare('INSERT INTO snapshots (source, fetched_at, payload) VALUES (?, ?, ?)').run(
      'azure',
      at,
      '{}',
    );
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO snapshots (source, fetched_at, payload) VALUES (?, ?, ?)')
          .run('azure', at, '{}'),
      /UNIQUE|constraint/i,
      'a plain duplicate insert must violate the unique constraint',
    );
  } finally {
    closeDb();
  }
});

test('recordSourceResult stores a success', () => {
  const { db } = freshDb();
  try {
    const state = recordSourceResult(db, 'openrouter', { ok: true });
    assert.equal(state.source, 'openrouter');
    assert.ok(state.lastSuccessAt, 'last_success_at is set');
    assert.equal(state.lastError, null);
    assert.equal(state.lastErrorAt, null);
    assert.deepEqual(getSourceState(db, 'openrouter'), state, 'readable back');
  } finally {
    closeDb();
  }
});

test('recordSourceResult stores a failure without clearing last success', () => {
  const { db } = freshDb();
  try {
    const ok = recordSourceResult(db, 'azure', { ok: true });
    const failed = recordSourceResult(db, 'azure', { ok: false, error: 'upstream 503' });

    assert.equal(failed.lastError, 'upstream 503');
    assert.ok(failed.lastErrorAt, 'last_error_at is set');
    assert.equal(failed.lastSuccessAt, ok.lastSuccessAt, 'last good fetch is preserved');

    const recovered = recordSourceResult(db, 'azure', { ok: true });
    assert.equal(recovered.lastError, null, 'a later success clears the error');
    assert.equal(recovered.lastErrorAt, null);
  } finally {
    closeDb();
  }
});

test('recordSourceResult on a failing source with no prior success leaves it empty', () => {
  const { db } = freshDb();
  try {
    const state = recordSourceResult(db, 'ga4', { ok: false, error: 'boom' });
    assert.equal(state.lastSuccessAt, null, 'never succeeded');
    assert.equal(state.lastError, 'boom');
    assert.ok(state.lastErrorAt);
  } finally {
    closeDb();
  }
});

test('the db survives a close and reopen with data intact', () => {
  closeDb();
  const dir = tempDir();
  try {
    const db = getDb({ dataDir: dir });
    runMigrations(db);
    saveSnapshot(db, 'openrouter', { persisted: true }, { fetchedAt: '2026-06-01T00:00:00.000Z' });
    closeDb();

    const reopened = getDb({ dataDir: dir });
    assert.deepEqual(runMigrations(reopened), [], 'migrations already applied on reopen');
    assert.deepEqual(latestSnapshot(reopened, 'openrouter').payload, { persisted: true });
  } finally {
    closeDb();
  }
});