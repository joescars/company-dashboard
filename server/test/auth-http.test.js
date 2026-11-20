import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The app reads DATA_DIR when the session store opens the database, so point it
// at a throwaway directory before importing anything that touches it.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-auth-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';

const { createApp } = await import('../src/app.js');
const { loadConfig } = await import('../src/lib/config.js');

const app = createApp({ config: loadConfig(), sessionSecret: 'test-secret' });

const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('health stays public', async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
});

test('auth status reports "not configured" when no credentials are present', async () => {
  const response = await fetch(`${base}/api/auth/status`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.configured, false);
  assert.equal(body.user, null);
  assert.ok(body.csrfToken, 'a CSRF token is issued even when signed out');
});

test('auth status sets an httpOnly session cookie', async () => {
  const response = await fetch(`${base}/api/auth/status`);
  const cookie = response.headers.get('set-cookie') || '';
  assert.match(cookie, /cd\.sid=/);
  assert.match(cookie, /HttpOnly/i);
});

test('a state-changing request without a CSRF token is rejected', async () => {
  const response = await fetch(`${base}/api/anything`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'invalid_csrf_token');
});

test('a state-changing request with the session token is allowed through', async () => {
  const status = await fetch(`${base}/api/auth/status`);
  const token = (await status.json()).csrfToken;
  const cookie = (status.headers.get('set-cookie') || '').split(';')[0];

  const response = await fetch(`${base}/api/anything`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie },
    body: '{}',
  });

  // The middleware lets it past; there is no handler, so it 404s rather than 403s.
  assert.notEqual(response.status, 403);
});

test('login is refused while auth is unconfigured', async () => {
  const response = await fetch(`${base}/api/auth/login`, { redirect: 'manual' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'auth_not_configured');
});