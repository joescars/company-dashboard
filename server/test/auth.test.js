import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authSettings,
  authorizeUser,
  buildAuthUrl,
  decodeIdToken,
  isAuthConfigured,
} from '../src/lib/auth.js';

const SETTINGS = authSettings({
  GOOGLE_CLIENT_ID: 'client-123',
  GOOGLE_CLIENT_SECRET: 'secret-456',
  GOOGLE_CALLBACK_URL: 'https://dash.example.com/api/auth/callback',
  ADMIN_EMAILS: 'Owner@Example.com, second@example.com',
});

/** Build an unsigned JWT-shaped id_token from a claims object. */
function fakeIdToken(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${body}.signature`;
}

test('configuration is detected only when every piece is present', () => {
  assert.equal(isAuthConfigured(SETTINGS), true);
  assert.equal(isAuthConfigured(authSettings({ GOOGLE_CLIENT_ID: 'x' })), false);
  assert.equal(
    isAuthConfigured(
      authSettings({
        GOOGLE_CLIENT_ID: 'a',
        GOOGLE_CLIENT_SECRET: 'b',
        GOOGLE_CALLBACK_URL: 'c',
        ADMIN_EMAILS: '',
      }),
    ),
    false,
    'an empty allowlist means nobody can log in',
  );
});

test('allowlist entries are normalized to lowercase and trimmed', () => {
  assert.deepEqual(SETTINGS.adminEmails, ['owner@example.com', 'second@example.com']);
});

test('the consent url carries the state and does not leak the secret', () => {
  const url = buildAuthUrl(SETTINGS, 'state-xyz');
  assert.match(url, /accounts\.google\.com/);
  assert.match(url, /state=state-xyz/);
  assert.ok(!url.includes('secret-456'), 'client secret must never appear in a URL');
});

test('an allowlisted, verified account is accepted', () => {
  const user = authorizeUser(
    { email: 'Owner@Example.com', email_verified: true, name: 'Owner', sub: 's1', aud: 'client-123' },
    SETTINGS,
  );
  assert.equal(user.email, 'owner@example.com');
  assert.equal(user.name, 'Owner');
});

test('an account outside the allowlist is refused', () => {
  assert.throws(
    () => authorizeUser({ email: 'stranger@example.com', email_verified: true }, SETTINGS),
    /not authorized/,
  );
});

test('an unverified address is refused', () => {
  assert.throws(
    () => authorizeUser({ email: 'owner@example.com', email_verified: false }, SETTINGS),
    /not verified/,
  );
});

test('a mismatched audience is refused', () => {
  assert.throws(
    () => authorizeUser({ email: 'owner@example.com', aud: 'someone-else' }, SETTINGS),
    /audience mismatch/,
  );
});

test('an expired token is refused', () => {
  assert.throws(
    () =>
      authorizeUser(
        { email: 'owner@example.com', aud: 'client-123', exp: Math.floor(Date.now() / 1000) - 60 },
        SETTINGS,
      ),
    /expired/,
  );
});

test('an id token round-trips and rejects malformed input', () => {
  const claims = { email: 'owner@example.com', sub: 'abc' };
  assert.deepEqual(decodeIdToken(fakeIdToken(claims)), claims);
  assert.throws(() => decodeIdToken('not-a-jwt'), /malformed/);
  assert.throws(() => decodeIdToken('a.!!!.c'), /malformed/);
});