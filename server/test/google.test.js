import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  GoogleCredentialError,
  buildAssertion,
  getAccessToken,
  getCredentials,
  resetGoogleCredentials,
} from '../src/lib/google.js';

/**
 * Credential handling is exercised against a freshly generated key pair — a
 * real RSA signature over a throwaway key, never a checked-in secret — so the
 * signing path is covered end to end without any real credential in the repo.
 */

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

/** Deterministic fake service-account key pair for the current test. */
function fakeServiceAccount(overrides = {}) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = {
    type: 'service_account',
    project_id: 'test-project',
    private_key_id: 'test-key-id',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: 'test-runner@test-project.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  };
  return account;
}

function encoded(account) {
  return Buffer.from(JSON.stringify(account), 'utf8').toString('base64');
}

/** Install a credential env var, restoring state (and caches) afterwards. */
async function withCredentials(value, fn) {
  const saved = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  if (value === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  else process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 = value;
  resetGoogleCredentials();
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
    else process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 = saved;
    resetGoogleCredentials();
  }
}

/** A well-formed token endpoint response, counting calls. */
function tokenFetch({ expiresIn = 3600, tokens = ['token-1'] } = {}) {
  const calls = [];
  let index = 0;

  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const token = tokens[Math.min(index, tokens.length - 1)];
    index += 1;
    return new Response(
      JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: 'Bearer' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  return { fetchImpl, calls };
}

test('credentials decode from base64 into the service-account fields', () => {
  const account = fakeServiceAccount();
  withCredentials(encoded(account), () => {
    const credentials = getCredentials();
    assert.equal(credentials.clientEmail, account.client_email);
    assert.equal(credentials.privateKey, account.private_key);
    assert.equal(credentials.tokenUri, 'https://oauth2.googleapis.com/token');
  });
});

test('missing credentials raise a clear, actionable error', () => {
  withCredentials(undefined, () => {
    assert.throws(
      () => getCredentials(),
      (error) => {
        assert.ok(error instanceof GoogleCredentialError);
        assert.match(error.message, /GOOGLE_SERVICE_ACCOUNT_JSON_BASE64/);
        assert.match(error.message, /not configured/i);
        return true;
      },
    );
  });
});

test('malformed base64 raises a specific error', () => {
  withCredentials('not valid base64!!!', () => {
    assert.throws(() => getCredentials(), /not valid base64/i);
  });
});

test('base64 of non-JSON raises a specific JSON error', () => {
  withCredentials(Buffer.from('this is not json', 'utf8').toString('base64'), () => {
    assert.throws(() => getCredentials(), /not valid JSON/i);
  });
});

test('JSON missing client_email or private_key is rejected', () => {
  withCredentials(Buffer.from(JSON.stringify({ type: 'service_account' })).toString('base64'), () => {
    assert.throws(() => getCredentials(), /client_email.*private_key|"client_email"/i);
  });
});

test('the JWT assertion has RS256 header and the expected claims', () => {
  const account = fakeServiceAccount();
  withCredentials(encoded(account), () => {
    const now = 1_700_000_000;
    const [headerPart, claimsPart, signaturePart] = buildAssertion(SCOPE, { now }).split('.');

    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });

    const claims = JSON.parse(Buffer.from(claimsPart, 'base64url').toString('utf8'));
    assert.equal(claims.iss, account.client_email);
    assert.equal(claims.scope, SCOPE);
    assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
    assert.equal(claims.iat, now);
    assert.equal(claims.exp, now + 3600, 'assertion is short-lived');

    // The signature must verify against the public half of the key.
    const publicKey = crypto.createPublicKey(account.private_key);
    const verified = crypto
      .createVerify('RSA-SHA256')
      .update(`${headerPart}.${claimsPart}`)
      .verify(publicKey, Buffer.from(signaturePart, 'base64url'));
    assert.equal(verified, true, 'signature verifies against the public key');
  });
});

test('two calls under one scope perform a single token exchange', async () => {
  const account = fakeServiceAccount();
  const { fetchImpl, calls } = tokenFetch({ tokens: ['token-abc'] });

  await withCredentials(encoded(account), async () => {
    const first = await getAccessToken(SCOPE, { fetchImpl });
    const second = await getAccessToken(SCOPE, { fetchImpl });

    assert.equal(first, 'token-abc');
    assert.equal(second, 'token-abc', 'the cached token is reused');
    assert.equal(calls.length, 1, 'only one token request is made');

    const body = new URLSearchParams(calls[0].options.body);
    assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.ok(body.get('assertion').split('.').length === 3, 'the assertion is sent as a JWT');
  });
});

test('a token near expiry is refreshed', async () => {
  const account = fakeServiceAccount();
  const { fetchImpl, calls } = tokenFetch({ expiresIn: 100, tokens: ['old-token', 'new-token'] });

  await withCredentials(encoded(account), async () => {
    const now = 1_700_000_000_000;
    const first = await getAccessToken(SCOPE, { fetchImpl, now });
    assert.equal(first, 'old-token');

    // 100s token minus the 60s skew leaves a 40s usable window; 50s in is stale.
    const second = await getAccessToken(SCOPE, { fetchImpl, now: now + 50_000 });
    assert.equal(second, 'new-token');
    assert.equal(calls.length, 2, 'a second exchange is performed');
  });
});

test('a token exchange failure does not poison the cache', async () => {
  const account = fakeServiceAccount();
  let attempt = 0;
  const fetchImpl = async () => {
    attempt += 1;
    if (attempt === 1) {
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ access_token: 'recovered', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  await withCredentials(encoded(account), async () => {
    await assert.rejects(() => getAccessToken(SCOPE, { fetchImpl }), /invalid_grant/);
    const token = await getAccessToken(SCOPE, { fetchImpl });
    assert.equal(token, 'recovered', 'a retry issues a fresh exchange');
  });
});