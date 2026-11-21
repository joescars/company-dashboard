import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * Registry-level tests for the three sources wired in this change: ga4,
 * adsense and simpleAnalytics.
 *
 * The fetchers themselves are unit-tested next to their modules
 * (sources-ga4.test.js, sources-simpleanalytics.test.js,
 * sources-adsense.test.js). What is proven here is the part that only exists
 * once the source is in the router's registry: the endpoint resolves, the
 * enablement flag is driven by the right environment variables, and a
 * credentialed-but-unfetched source reports an empty snapshot instead of
 * exploding.
 *
 * Everything runs against the real router with a signed-in session shim and
 * the real CSRF middleware. No network is touched: nothing calls refresh.
 */

const httpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-registry-'));
process.env.DATA_DIR = httpDataDir;
process.env.NODE_ENV = 'test';

const { loadConfig } = await import('../src/lib/config.js');
const { csrfProtection } = await import('../src/middleware/auth.js');
const { sourcesRouter } = await import('../src/routes/sources.js');
const { getDb, runMigrations } = await import('../src/lib/db.js');
const express = (await import('express')).default;

runMigrations(getDb());

/** Load config with a temporary env overlay, then restore the environment. */
function configWithEnv(envVars = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(envVars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const config = loadConfig();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return config;
}

function signedInSourcesApp(config) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: { email: 'tester@example.com' }, csrfToken: 'test-csrf-token' };
    next();
  });
  app.use('/api', csrfProtection());
  app.use('/api/sources', sourcesRouter(config));
  return app;
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function withApp(config, run) {
  const { server, base } = await listen(signedInSourcesApp(config));
  try {
    return await run(base);
  } finally {
    server.close();
  }
}

test.after(async () => {
  const { closeDb } = await import('../src/lib/db.js');
  closeDb();
  fs.rmSync(httpDataDir, { recursive: true, force: true });
});

const NEW_SOURCES = [
  {
    key: 'ga4',
    label: 'Google Analytics 4',
    identifierEnv: { GA4_PROPERTY_ID: '123456789' },
    credentialEnv: 'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64',
    disabledHint: 'Google Analytics 4 is not enabled',
  },
  {
    key: 'adsense',
    label: 'AdSense',
    identifierEnv: { ADSENSE_ACCOUNT_ID: 'pub-1234567890123456' },
    credentialEnv: 'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64',
    disabledHint: 'AdSense is not enabled',
  },
  {
    key: 'simpleAnalytics',
    label: 'Simple Analytics',
    identifierEnv: { SIMPLE_ANALYTICS_SITE: 'example.com' },
    credentialEnv: 'SIMPLE_ANALYTICS_API_KEY',
    disabledHint: 'Simple Analytics is not enabled',
  },
];

// Clear every credential these tests care about so results do not depend on a
// developer's shell.
const NEUTRAL = {
  GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: undefined,
  GA4_PROPERTY_ID: undefined,
  ADSENSE_ACCOUNT_ID: undefined,
  SIMPLE_ANALYTICS_SITE: undefined,
  SIMPLE_ANALYTICS_API_KEY: undefined,
};

for (const source of NEW_SOURCES) {
  test(`GET /api/sources/${source.key} resolves once registered`, async () => {
    const config = configWithEnv(NEUTRAL);
    const body = await withApp(config, async (base) => {
      const response = await fetch(`${base}/api/sources/${source.key}`);
      assert.equal(response.status, 200);
      return response.json();
    });

    assert.equal(body.source, source.key);
    assert.equal(body.enabled, false);
    assert.equal(body.snapshot, null);
    assert.equal(body.data, null);
    assert.equal(body.fetchedAt, null);
    // health is always a full object, never null.
    assert.deepEqual(Object.keys(body.health).sort(), [
      'lastError',
      'lastErrorAt',
      'lastSuccessAt',
      'ok',
    ]);
  });

  test(`${source.key} reports enabled when its credential and identifier are set`, async () => {
    const config = configWithEnv({
      ...NEUTRAL,
      ...source.identifierEnv,
      [source.credentialEnv]: 'fake-credential-value',
    });
    const body = await withApp(config, async (base) => {
      const response = await fetch(`${base}/api/sources/${source.key}`);
      return response.json();
    });

    assert.equal(body.enabled, true);
  });

  test(`${source.key} needs the identifier, not just the credential`, async () => {
    const config = configWithEnv({
      ...NEUTRAL,
      [source.credentialEnv]: 'fake-credential-value',
    });
    const body = await withApp(config, async (base) => {
      const response = await fetch(`${base}/api/sources/${source.key}`);
      return response.json();
    });

    assert.equal(body.enabled, false);
  });

  test(`POST /api/sources/${source.key}/refresh is 503 while disabled`, async () => {
    const config = configWithEnv(NEUTRAL);
    const body = await withApp(config, async (base) => {
      const response = await fetch(`${base}/api/sources/${source.key}/refresh`, {
        method: 'POST',
        headers: { 'x-csrf-token': 'test-csrf-token' },
      });
      assert.equal(response.status, 503);
      return response.json();
    });

    assert.equal(body.error, 'source_not_configured');
    assert.match(body.message, new RegExp(source.disabledHint));
  });
}

test('an unknown source is still 404, not a silent 500', async () => {
  const config = configWithEnv(NEUTRAL);
  const body = await withApp(config, async (base) => {
    const response = await fetch(`${base}/api/sources/notasource`);
    assert.equal(response.status, 404);
    return response.json();
  });
  assert.equal(body.error, 'unknown_source');
});
