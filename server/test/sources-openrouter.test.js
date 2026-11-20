import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fetchOpenRouter, shapeActivity, shapeCredits, shapeKeyUsage } from '../src/sources/openrouter.js';

/**
 * OpenRouter source tests — pure fetcher level.
 *
 * globalThis.fetch is stubbed and restored; nothing hits the network. All
 * credential values are obvious fakes. Route-level behavior (503 for a
 * disabled source, auth guard, CSRF on refresh) is covered at the bottom of
 * this file against a real listening app.
 */

const FAKE_API_KEY = 'sk-or-v1-fake-api-key';
const FAKE_MANAGEMENT_KEY = 'sk-or-v1-fake-management-key';

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

function stubFetch(script) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const matcher = script.find((entry) => entry.match(String(url), init));
    if (!matcher) throw new Error(`unexpected fetch to ${url}`);
    return matcher.response(String(url), init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const KEY_BODY = {
  data: {
    label: 'sk-or-v1-au7...890',
    usage: 25.5,
    usage_daily: 1.2,
    usage_weekly: 7.0,
    usage_monthly: 25.5,
    limit: 100,
    limit_remaining: 74.5,
    limit_reset: 'monthly',
    is_free_tier: false,
    is_management_key: false,
  },
};

const CREDITS_BODY = { data: { total_credits: 100.5, total_usage: 25.75 } };

const ACTIVITY_BODY = {
  data: [
    { date: '2026-11-01', model: 'acme/model-a', requests: 5, usage: 0.015 },
    { date: '2026-11-01', model: 'acme/model-b', requests: 3, usage: 0.02 },
    { date: '2026-11-02', model: 'acme/model-a', requests: 4, usage: 0.01 },
  ],
};

test('fetches key usage with the api key alone', async () => {
  const stub = stubFetch([
    { match: (url) => url.endsWith('/api/v1/key'), response: () => jsonResponse(KEY_BODY) },
  ]);

  try {
    const result = await fetchOpenRouter({ apiKey: FAKE_API_KEY }, { fetchImpl: globalThis.fetch });
    assert.equal(result.ok, true);
    assert.equal(result.hasManagementKey, false);
    assert.equal(result.sections.key.ok, true);
    assert.equal(result.sections.key.usage, 25.5);
    assert.equal(result.sections.key.limitRemaining, 74.5);

    // Both optional sections are unavailable, not errored.
    assert.equal(result.sections.credits.ok, false);
    assert.equal(result.sections.credits.unavailable, true);
    assert.match(result.sections.credits.error, /management key not configured/);
    assert.equal(result.sections.activity.ok, false);
    assert.equal(result.sections.activity.unavailable, true);

    assert.equal(stub.calls.length, 1, 'only /key is requested without a management key');
  } finally {
    stub.restore();
  }
});

test('a management key unlocks credits and 30-day activity', async () => {
  const stub = stubFetch([
    { match: (url) => url.endsWith('/api/v1/key'), response: () => jsonResponse(KEY_BODY) },
    { match: (url) => url.endsWith('/api/v1/credits'), response: () => jsonResponse(CREDITS_BODY) },
    { match: (url) => url.endsWith('/api/v1/activity'), response: () => jsonResponse(ACTIVITY_BODY) },
  ]);

  try {
    const result = await fetchOpenRouter(
      { apiKey: FAKE_API_KEY, managementKey: FAKE_MANAGEMENT_KEY },
      { fetchImpl: globalThis.fetch },
    );
    assert.equal(result.ok, true);
    assert.equal(result.hasManagementKey, true);
    assert.equal(result.sections.credits.ok, true);
    assert.equal(result.sections.credits.totalCredits, 100.5);
    assert.equal(result.sections.credits.remaining, 74.75);
    assert.equal(result.sections.activity.ok, true);
    assert.equal(result.sections.activity.windowDays, 30);
    assert.equal(result.sections.activity.requests, 12);
    assert.equal(result.sections.activity.daily.length, 2);
    assert.equal(stub.calls.length, 3);

    // The management key, not the api key, is sent to the privileged endpoints.
    const creditsCall = stub.calls.find((c) => c.url.endsWith('/credits'));
    assert.equal(creditsCall.init.headers.authorization, `Bearer ${FAKE_MANAGEMENT_KEY}`);
  } finally {
    stub.restore();
  }
});

test('a missing optional section does not fail the whole source', async () => {
  const stub = stubFetch([
    { match: (url) => url.endsWith('/api/v1/key'), response: () => jsonResponse(KEY_BODY) },
    { match: (url) => url.endsWith('/api/v1/credits'), response: () => jsonResponse(CREDITS_BODY) },
    {
      match: (url) => url.endsWith('/api/v1/activity'),
      response: () => jsonResponse({ error: { message: 'activity unavailable' } }, { status: 500 }),
    },
  ]);

  try {
    const result = await fetchOpenRouter(
      { apiKey: FAKE_API_KEY, managementKey: FAKE_MANAGEMENT_KEY },
      { fetchImpl: globalThis.fetch },
    );
    assert.equal(result.ok, true, 'key + credits still succeeded');
    assert.equal(result.sections.key.ok, true);
    assert.equal(result.sections.credits.ok, true);
    assert.equal(result.sections.activity.ok, false);
    assert.match(result.sections.activity.error, /HTTP 500/);
  } finally {
    stub.restore();
  }
});

test('a failing key section still returns other sections and a non-ok source', async () => {
  const stub = stubFetch([
    { match: (url) => url.endsWith('/api/v1/key'), response: () => jsonResponse({}, { status: 401 }) },
    { match: (url) => url.endsWith('/api/v1/credits'), response: () => jsonResponse(CREDITS_BODY) },
    { match: (url) => url.endsWith('/api/v1/activity'), response: () => jsonResponse(ACTIVITY_BODY) },
  ]);

  try {
    const result = await fetchOpenRouter(
      { apiKey: FAKE_API_KEY, managementKey: FAKE_MANAGEMENT_KEY },
      { fetchImpl: globalThis.fetch },
    );
    assert.equal(result.sections.key.ok, false);
    assert.equal(result.ok, true, 'credits/activity succeeded');
  } finally {
    stub.restore();
  }
});

test('fetchOpenRouter throws only when the api key is missing', async () => {
  await assert.rejects(() => fetchOpenRouter({}, { fetchImpl: async () => jsonResponse({}) }), /missing required config field/);
});

test('shapeCredits computes remaining from purchased and used', () => {
  assert.deepEqual(shapeCredits({ total_credits: 10, total_usage: 3.5 }), {
    totalCredits: 10,
    totalUsage: 3.5,
    remaining: 6.5,
  });
  assert.equal(shapeCredits(null), null);
});

test('shapeKeyUsage keeps the fields the dashboard needs', () => {
  const shaped = shapeKeyUsage(KEY_BODY.data);
  assert.equal(shaped.usage, 25.5);
  assert.equal(shaped.limit, 100);
  assert.equal(shaped.isManagementKey, false);
});

test('shapeActivity rolls rows into a per-day and per-model summary', () => {
  const activity = shapeActivity(ACTIVITY_BODY.data, { days: 30 });
  assert.equal(activity.requests, 12);
  assert.equal(activity.usage, 0.045);
  assert.deepEqual(activity.daily[0], { date: '2026-11-01', usage: 0.035, requests: 8 });
  assert.equal(activity.models[0].model, 'acme/model-a', 'models are sorted by usage desc');
});
// ---------------------------------------------------------------------------
// Route-level behavior.
//
// Two app shapes are exercised:
//   * the real createApp() app — confirms the route is mounted, is auth-gated
//     and is CSRF-protected (these checks do not need a signed-in session);
//   * a focused app mounting csrfProtection + sourcesRouter with a signed-in
//     shim — confirms the 503 (disabled) and persisted-failure paths.
// DATA_DIR is set before the session store imports the database.
// ---------------------------------------------------------------------------

const httpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-src-'));
process.env.DATA_DIR = httpDataDir;
process.env.NODE_ENV = 'test';

const { createApp } = await import('../src/app.js');
const { loadConfig } = await import('../src/lib/config.js');
const { csrfProtection } = await import('../src/middleware/auth.js');
const { sourcesRouter } = await import('../src/routes/sources.js');
const { getDb, runMigrations } = await import('../src/lib/db.js');
const express = (await import('express')).default;

// The focused app below does not create a session store, so make sure the
// snapshots/source_state tables exist before any route touches them.
runMigrations(getDb());

/** Load config with a temporary env overlay, then restore the environment. */
function configWithEnv(envVars = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(envVars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const config = loadConfig({ configPath: '/nonexistent/company.json' });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return config;
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/**
 * A focused app: a session shim that marks the caller signed in, a CSRF token
 * in the session, then the real CSRF middleware and the real sources router.
 */
function signedInSourcesApp(config, { fetchImpl } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: { email: 'tester@example.com' }, csrfToken: 'test-csrf-token' };
    next();
  });
  app.use('/api', csrfProtection());
  app.use('/api/sources', sourcesRouter(config, fetchImpl ? { fetchImpl } : {}));
  return app;
}

test.after(async () => {
  const { closeDb } = await import('../src/lib/db.js');
  closeDb();
  fs.rmSync(httpDataDir, { recursive: true, force: true });
});

test('GET /api/sources/:source requires authentication on the real app', async () => {
  const app = createApp({ config: configWithEnv({}), sessionSecret: 'test-secret' });
  const { server, base } = await listen(app);
  try {
    const response = await fetch(`${base}/api/sources/openrouter`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'authentication_required');
  } finally {
    server.close();
  }
});

test('POST refresh without a CSRF token is rejected by the real app', async () => {
  const app = createApp({ config: configWithEnv({}), sessionSecret: 'test-secret' });
  const { server, base } = await listen(app);
  try {
    const response = await fetch(`${base}/api/sources/azure/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'invalid_csrf_token');
  } finally {
    server.close();
  }
});

test('POST refresh on a disabled source returns 503 with a clear reason', async () => {
  const config = configWithEnv({}); // nothing configured → disabled
  const app = signedInSourcesApp(config);
  const { server, base } = await listen(app);
  try {
    const response = await fetch(`${base}/api/sources/openrouter/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'test-csrf-token' },
      body: '{}',
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, 'source_not_configured');
    assert.match(body.message, /OpenRouter is not enabled/);
  } finally {
    server.close();
  }
});

test('GET an unknown source returns 404 when authenticated', async () => {
  const app = signedInSourcesApp(configWithEnv({}));
  const { server, base } = await listen(app);
  try {
    const response = await fetch(`${base}/api/sources/nope`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'unknown_source');
  } finally {
    server.close();
  }
});

test('GET a configured source returns the null snapshot shell before any fetch', async () => {
  const app = signedInSourcesApp(configWithEnv({}));
  const { server, base } = await listen(app);
  try {
    const response = await fetch(`${base}/api/sources/openrouter`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'openrouter');
    assert.equal(body.enabled, false);
    assert.equal(body.snapshot, null);
    assert.equal(body.health, null);
  } finally {
    server.close();
  }
});

test('POST refresh on an enabled-but-failing source records the failure and 502s', async () => {
  // Keep OPENROUTER_API_KEY set for the whole test: the router reads the
  // environment when it builds the fetcher config, not only at load time.
  const savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-fake-enabled';

  const failingFetch = async () => ({
    ok: false,
    status: 401,
    headers: { get: () => null },
    json: async () => ({ error: { message: 'invalid key' } }),
  });

  const config = loadConfig({ configPath: '/nonexistent/company.json' });
  assert.equal(config.sources.openrouter.enabled, true, 'precondition: source is enabled');

  const app = signedInSourcesApp(config, { fetchImpl: failingFetch });
  const { server, base } = await listen(app);
  try {
    const response = await fetch(`${base}/api/sources/openrouter/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'test-csrf-token' },
      body: '{}',
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.saved, false);
    assert.ok(body.health.lastErrorAt, 'the failure is recorded in source_state');
  } finally {
    server.close();
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
  }
});

test('POST refresh on a working source persists a snapshot that GET reads back', async () => {
  const savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-fake-working';

  const okFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      data: {
        usage: 5,
        limit: 10,
        limit_remaining: 5,
        label: 'sk-or-v1-...-fake',
        is_free_tier: false,
        is_management_key: false,
      },
    }),
  });

  const config = loadConfig({ configPath: '/nonexistent/company.json' });
  const app = signedInSourcesApp(config, { fetchImpl: okFetch });
  const { server, base } = await listen(app);
  try {
    const refresh = await fetch(`${base}/api/sources/openrouter/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'test-csrf-token' },
      body: '{}',
    });
    assert.equal(refresh.status, 200);
    const refreshed = await refresh.json();
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.saved, true);
    assert.ok(Number.isInteger(refreshed.snapshotId), 'a snapshot row was written');
    assert.equal(refreshed.health.lastError, null);

    const read = await fetch(`${base}/api/sources/openrouter`);
    const body = await read.json();
    assert.equal(body.enabled, true);
    assert.ok(body.snapshot, 'the cached snapshot is returned');
    assert.equal(body.snapshot.payload.sections.key.usage, 5);
    assert.equal(body.health.lastSuccessAt, refreshed.health.lastSuccessAt);
  } finally {
    server.close();
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
  }
});
