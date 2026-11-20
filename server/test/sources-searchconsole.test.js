import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sign } from 'cookie-signature';

import { resetGoogleCredentials } from '../src/lib/google.js';

// Point the database at a throwaway directory before importing anything that
// opens it. The session store constructs on first use.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-searchconsole-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';

// A fake service-account key generated per run — never a checked-in secret.
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'test-key-id',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'test-runner@test-project.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
};
const SERVICE_ACCOUNT_BASE64 = Buffer.from(JSON.stringify(SERVICE_ACCOUNT), 'utf8').toString('base64');

const SITE_URL = 'https://example.com/analytics';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

// Install the credential environment before the app resolves its config.
process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 = SERVICE_ACCOUNT_BASE64;
process.env.GSC_SITE_URL = SITE_URL;
resetGoogleCredentials();

const { createApp } = await import('../src/app.js');
const { loadConfig } = await import('../src/lib/config.js');
const { getDb, latestSnapshot, getSourceState } = await import('../src/lib/db.js');
const { runMigrations } = await import('../src/lib/db.js');

const SESSION_SECRET = 'test-secret';
const SESSION_COOKIE = ['cd', 'sid'].join('.');

/** Stub global.fetch, restoring (and clearing credential caches) afterwards. */
async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  resetGoogleCredentials();
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
    resetGoogleCredentials();
  }
}

/**
 * The real fetch, captured before any stub replaces globalThis.fetch, so the
 * HTTP client used by the tests never routes through a stub meant for the
 * server's outbound Google calls.
 */
const realFetch = globalThis.fetch;

function cookieHeader(sid) {
  const signed = `s:${sign(sid, SESSION_SECRET)}`;
  return `${SESSION_COOKIE}=${encodeURIComponent(signed)}`;
}

/** Insert a signed-in session directly so we can exercise the guarded route. */
function signIn({ email = 'admin@example.com', csrf = 'test-csrf-token' } = {}) {
  const sid = `test-${Math.random().toString(36).slice(2)}`;
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const data = {
    cookie: { originalMaxAge: 86400000, expires, httpOnly: true, path: '/' },
    user: { email, name: 'Test Admin' },
    csrfToken: csrf,
  };
  getDb()
    .prepare('INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)')
    .run(sid, JSON.stringify(data), Date.now() + 86400000);
  return { sid, csrf, cookie: cookieHeader(sid) };
}

/** A stub fetch that answers the token endpoint and the two GSC queries. */
function makeGscFetch({ siteEntries = [{ siteUrl: SITE_URL }] } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });

    if (String(url).includes('oauth2.googleapis.com')) {
      return jsonResponse(200, { access_token: 'stub-access-token', expires_in: 3600 });
    }
    if (String(url).endsWith('/sites')) {
      return jsonResponse(200, { siteEntry: siteEntries });
    }
    if (String(url).includes('/searchAnalytics/query')) {
      const body = JSON.parse(options.body);
      const dimension = body.dimensions?.[0];
      if (dimension === 'query') {
        return jsonResponse(200, {
          rows: [
            { keys: ['widget repair'], clicks: 120, impressions: 2000, ctr: 0.06, position: 4.2 },
            { keys: ['blue widget'], clicks: 30, impressions: 1000, ctr: 0.03, position: 8.5 },
          ],
        });
      }
      return jsonResponse(200, {
        rows: [
          { keys: ['https://example.com/analytics/a'], clicks: 90, impressions: 1500, ctr: 0.06, position: 5.1 },
        ],
      });
    }
    return jsonResponse(404, { error: { message: 'unexpected url' } });
  };
  return { impl, calls };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// The refresh endpoint hits the real token URL; keep it from succeeding by
// default so no test slips through to the network.
const app = createApp({ config: loadConfig(), sessionSecret: SESSION_SECRET });
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

test.before(async () => {
  // A fresh migrated db keeps the cache assertions deterministic.
  getDb();
  runMigrations(getDb());
});

test.after(() => {
  server.close();
  getDb().close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/sources/searchConsole is refused without a session', async () => {
  const response = await realFetch(`${base}/api/sources/searchConsole`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'authentication_required');
});

test('GET serves the empty cache when nothing has been refreshed yet', async () => {
  const { cookie } = signIn();
  const response = await realFetch(`${base}/api/sources/searchConsole`, { headers: { cookie } });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.source, 'searchConsole');
  assert.equal(body.enabled, true);
  assert.equal(body.data, null);
  assert.equal(body.fetchedAt, null);
  assert.equal(body.health.ok, false);
});

test('POST refresh fetches, maps the API and persists a snapshot', async () => {
  const { impl, calls } = makeGscFetch();
  const { csrf, cookie } = signIn();

  let body;
  await withFetch(impl, async () => {
    const response = await realFetch(`${base}/api/sources/searchConsole/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie },
    });
    assert.equal(response.status, 200);
    body = await response.json();
  });

  assert.equal(body.source, 'searchConsole');
  assert.equal(body.health.ok, true);
  assert.ok(body.fetchedAt, 'a fetch timestamp is recorded');

  // Queries
  assert.equal(body.data.queries.length, 2);
  assert.deepEqual(body.data.queries[0], {
    clicks: 120,
    impressions: 2000,
    ctr: 0.06,
    position: 4.2,
    keys: ['widget repair'],
  });

  // Pages
  assert.equal(body.data.pages.length, 1);
  assert.deepEqual(body.data.pages[0].keys, ['https://example.com/analytics/a']);

  // Totals are impression-weighted.
  assert.equal(body.data.totals.clicks, 150);
  assert.equal(body.data.totals.impressions, 3000);
  assert.ok(Math.abs(body.data.totals.ctr - (0.06 * 2000 + 0.03 * 1000) / 3000) < 1e-9);

  // Period is a 28-day window ending today.
  assert.match(body.data.period.startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(body.data.period.endDate, /^\d{4}-\d{2}-\d{2}$/);
  const span =
    (Date.parse(body.data.period.endDate) - Date.parse(body.data.period.startDate)) / 86400000;
  assert.equal(span, 27, '28 inclusive days');

  const queryCall = calls.find((call) => call.url.includes('/searchAnalytics/query'));
  assert.ok(queryCall.url.endsWith(`/sites/${encodeURIComponent(SITE_URL)}/searchAnalytics/query`));
  assert.equal(JSON.parse(queryCall.options.body).dimensions[0], 'query');

  // The snapshot and health state are durable.
  assert.ok(latestSnapshot(getDb(), 'searchConsole'));
  assert.equal(getSourceState(getDb(), 'searchConsole').lastError, null);
});

test('POST refresh is rejected without a CSRF token', async () => {
  const { cookie } = signIn();
  const response = await realFetch(`${base}/api/sources/searchConsole/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'invalid_csrf_token');
});

test('a site missing from the account reports a clear error and keeps the last snapshot', async () => {
  const before = latestSnapshot(getDb(), 'searchConsole');

  const { impl } = makeGscFetch({ siteEntries: [{ siteUrl: 'https://other.example/' }] });
  const { csrf, cookie } = signIn();

  let body;
  await withFetch(impl, async () => {
    const response = await realFetch(`${base}/api/sources/searchConsole/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie },
    });
    assert.equal(response.status, 502);
    body = await response.json();
  });

  assert.equal(body.error, 'source_fetch_failed');
  assert.match(body.message, /not available/i);

  // The failed fetch records an error without wiping the last good data.
  const after = latestSnapshot(getDb(), 'searchConsole');
  assert.equal(after.id, before.id, 'the last successful snapshot is untouched');
  const state = getSourceState(getDb(), 'searchConsole');
  assert.ok(state.lastError, 'the failure is recorded');
  assert.ok(state.lastSuccessAt, 'the last success is preserved');
});

test('a failed API call records a source error without wiping the last success', async () => {
  const before = latestSnapshot(getDb(), 'searchConsole');

  const impl = async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      return jsonResponse(200, { access_token: 'stub-access-token', expires_in: 3600 });
    }
    if (String(url).endsWith('/sites')) {
      return jsonResponse(200, { siteEntry: [{ siteUrl: SITE_URL }] });
    }
    return jsonResponse(500, { error: { message: 'backend error' } });
  };
  const { csrf, cookie } = signIn();

  let body;
  await withFetch(impl, async () => {
    const response = await realFetch(`${base}/api/sources/searchConsole/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie },
    });
    assert.equal(response.status, 502);
    body = await response.json();
  });

  assert.equal(body.error, 'source_fetch_failed');
  assert.match(body.message, /backend error/);

  const after = latestSnapshot(getDb(), 'searchConsole');
  assert.equal(after.id, before.id, 'the last good snapshot is not overwritten');
  const state = getSourceState(getDb(), 'searchConsole');
  assert.ok(state.lastError.includes('backend error'));
  assert.ok(state.lastSuccessAt, 'a prior success remains readable');
});

test('a disabled source returns 503 with a clear error', async () => {
  const disabledConfig = {
    sources: { searchConsole: { enabled: false, config: { siteUrl: null } } },
  };
  const disabledApp = createApp({ config: disabledConfig, sessionSecret: SESSION_SECRET });
  const disabledServer = await new Promise((resolve) => {
    const s = disabledApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  const disabledBase = `http://127.0.0.1:${disabledServer.address().port}`;

  try {
    const { csrf, cookie } = signIn();
    const response = await realFetch(`${disabledBase}/api/sources/searchConsole/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie },
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, 'source_not_configured');
    assert.match(body.message, /not enabled/i);
  } finally {
    disabledServer.close();
  }
});