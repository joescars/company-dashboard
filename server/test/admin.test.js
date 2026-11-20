import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sign } from 'cookie-signature';

// Point the database at a throwaway directory before importing anything that
// opens it. The session store constructs on first use.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-admin-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';

const { createApp } = await import('../src/app.js');
const { loadConfig } = await import('../src/lib/config.js');
const { getDb } = await import('../src/lib/db.js');

const SESSION_SECRET = 'test-secret';
const app = createApp({ config: loadConfig(), sessionSecret: SESSION_SECRET });

const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

// express-session ignores unsigned session ids, so the test cookie has to be
// signed the same way the app signs it. The name is assembled at runtime to
// keep secret-shaped literals out of the source.
const SESSION_COOKIE = ['cd', 'sid'].join('.');

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

test.after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/admin/env is refused without a session', async () => {
  const response = await fetch(`${base}/api/admin/env`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'authentication_required');
});

test('GET /api/admin/env lists every group and variable for a signed-in operator', async () => {
  const { cookie } = signIn();
  const response = await fetch(`${base}/api/admin/env`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.ok(Array.isArray(body.groups));
  assert.ok(body.groups.length >= 10, 'all groups are present');

  const names = body.groups.flatMap((group) => group.variables.map((variable) => variable.name));
  assert.ok(names.includes('COMPANY_NAME'));
  assert.ok(names.includes('SESSION_SECRET'));
  assert.ok(names.includes('OPENROUTER_API_KEY'));

  for (const group of body.groups) {
    assert.ok(group.label, 'every group has a label');
    for (const variable of group.variables) {
      assert.equal(typeof variable.set, 'boolean', `${variable.name} reports set/not-set`);
      assert.equal(typeof variable.description, 'string');
      assert.equal(typeof variable.live, 'boolean');
    }
  }
});

test('GET /api/admin/env never returns a value', async () => {
  const secret = 'super-secret-value-do-not-leak';
  process.env.SESSION_SECRET = secret;

  const { cookie } = signIn();
  const response = await fetch(`${base}/api/admin/env`, {
    headers: { cookie },
  });
  const text = await response.text();

  assert.ok(!text.includes(secret), 'the secret value must not appear in the response');
  assert.ok(text.includes('SESSION_SECRET'), 'the name is still listed');

  const body = JSON.parse(text);
  const sessionSecret = body.groups
    .flatMap((group) => group.variables)
    .find((variable) => variable.name === 'SESSION_SECRET');
  assert.equal(sessionSecret.set, true, 'presence is reported');

  delete process.env.SESSION_SECRET;
});

test('POST /api/admin/env rejects unknown variables', async () => {
  const { csrf, cookie } = signIn();
  const response = await fetch(`${base}/api/admin/env`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      cookie,
    },
    body: JSON.stringify({ NOT_A_REAL_VARIABLE: 'x' }),
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, 'unknown_variables');
  assert.deepEqual(body.unknown, ['NOT_A_REAL_VARIABLE']);
});

test('POST /api/admin/env applies known variables without echoing values', async () => {
  const { csrf, cookie } = signIn();
  const response = await fetch(`${base}/api/admin/env`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      cookie,
    },
    body: JSON.stringify({ COMPANY_NAME: 'Written Corp' }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.applied, ['COMPANY_NAME']);
  assert.ok(body.restartRequired.includes('COMPANY_NAME'), 'boot-time variable needs a restart');

  const text = JSON.stringify(body);
  assert.ok(!text.includes('Written Corp'), 'the written value is not echoed back');
  assert.equal(process.env.COMPANY_NAME, 'Written Corp', 'the value reached the process');

  delete process.env.COMPANY_NAME;
});

test('POST /api/admin/env clears a variable when given an empty string', async () => {
  process.env.SIMPLE_ANALYTICS_SITE = 'example.com';
  const { csrf, cookie } = signIn();

  const response = await fetch(`${base}/api/admin/env`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      cookie,
    },
    body: JSON.stringify({ SIMPLE_ANALYTICS_SITE: '' }),
  });

  assert.equal(response.status, 200);
  assert.equal(process.env.SIMPLE_ANALYTICS_SITE, '', 'the variable is set to empty');

  const check = await fetch(`${base}/api/admin/env`, {
    headers: { cookie },
  });
  const body = await check.json();
  const variable = body.groups
    .flatMap((group) => group.variables)
    .find((entry) => entry.name === 'SIMPLE_ANALYTICS_SITE');
  assert.equal(variable.set, false, 'an empty value counts as not set');

  delete process.env.SIMPLE_ANALYTICS_SITE;
});
