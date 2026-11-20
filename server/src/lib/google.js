import crypto from 'node:crypto';

/**
 * Shared Google service-account credential foundation.
 *
 * Every Google-backed source (Search Console, GA4, AdSense) authenticates the
 * same way: a service-account key signs a short-lived RS256 JWT assertion,
 * which is exchanged at Google's OAuth endpoint for an access token scoped to
 * the APIs that source needs.
 *
 * Implemented with `node:crypto` only — no googleapis dependency, no native
 * build step. `fetch` is used for the token exchange.
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWT_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** Refresh a cached token this many seconds before it actually expires. */
const EXPIRY_SKEW_SECONDS = 60;

/** Credentials are resolved once and memoized; the key never leaves memory. */
let cachedCredentials = null;

/** Live access tokens keyed by scope, with an epoch-second expiry. */
const tokenCache = new Map();

/** Raised for anything the operator can fix (missing/malformed credentials). */
export class GoogleCredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GoogleCredentialError';
    this.code = 'google_credentials_unavailable';
  }
}

function envStr(name) {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Service-account credentials from GOOGLE_SERVICE_ACCOUNT_JSON_BASE64.
 *
 * Throws GoogleCredentialError with an actionable message when the variable is
 * absent, not valid base64, not valid JSON, or missing the fields a JWT
 * assertion needs. Results are memoized; call {@link resetGoogleCredentials}
 * to re-read the environment (used by tests).
 */
export function getCredentials() {
  if (cachedCredentials) return cachedCredentials;

  const encoded = envStr('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64');
  if (!encoded) {
    throw new GoogleCredentialError(
      'Google service account credentials are not configured: set ' +
        'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 to the base64-encoded service ' +
        'account JSON key.',
    );
  }

  const json = decodeBase64Utf8(encoded);
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new GoogleCredentialError(
      `Google service account credentials are not valid JSON: ${error.message}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GoogleCredentialError(
      'Google service account credentials must decode to a JSON object.',
    );
  }

  const { client_email: clientEmail, private_key: privateKey, token_uri: tokenUri } = parsed;
  if (!clientEmail || !privateKey) {
    throw new GoogleCredentialError(
      'Google service account credentials are missing "client_email" or "private_key".',
    );
  }

  cachedCredentials = {
    clientEmail,
    privateKey,
    tokenUri: typeof tokenUri === 'string' && tokenUri.trim() ? tokenUri.trim() : TOKEN_ENDPOINT,
  };
  return cachedCredentials;
}

/** Forget memoized credentials and cached tokens. */
export function resetGoogleCredentials() {
  cachedCredentials = null;
  tokenCache.clear();
}

/** base64 (or base64url) -> UTF-8 string, with a specific error on bad input. */
function decodeBase64Utf8(encoded) {
  const compact = encoded.replace(/\s+/g, '');
  // Node is lenient about padding; validate the alphabet ourselves so a typo
  // produces a clear message instead of silently garbage-decoded bytes.
  if (!/^[A-Za-z0-9+/\-_]*={0,2}$/.test(compact)) {
    throw new GoogleCredentialError(
      'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is not valid base64.',
    );
  }
  const buffer = Buffer.from(compact, 'base64');
  if (buffer.length === 0) {
    throw new GoogleCredentialError(
      'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 decoded to an empty value.',
    );
  }
  return buffer.toString('utf8');
}

/** base64url encoding without padding, as JWT requires. */
function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/**
 * Build and sign the RS256 JWT assertion for one scope.
 *
 * Exported for tests; callers normally use {@link getAccessToken}.
 */
export function buildAssertion(scope, { now = Math.floor(Date.now() / 1000) } = {}) {
  const { clientEmail, privateKey, tokenUri } = getCredentials();

  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: clientEmail,
    scope,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey);

  return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * An access token for `scope`, from cache when still fresh.
 *
 * Tokens are reused until ~60s before expiry, so a page that queries several
 * endpoints under one scope performs a single token exchange. Concurrent
 * callers for the same scope share one in-flight request.
 */
export async function getAccessToken(scope, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!scope) throw new TypeError('getAccessToken: scope is required');

  const cached = tokenCache.get(scope);
  if (cached && cached.expiresAtMs - EXPIRY_SKEW_SECONDS * 1000 > now) {
    return cached.token;
  }
  if (cached?.inflight) return cached.inflight;

  const inflight = requestToken(scope, fetchImpl, now);
  tokenCache.set(scope, { ...cached, inflight });

  try {
    const token = await inflight;
    return token;
  } catch (error) {
    // A failed exchange must not poison the cache.
    tokenCache.delete(scope);
    throw error;
  }
}

async function requestToken(scope, fetchImpl, now) {
  const assertion = buildAssertion(scope, { now: Math.floor(now / 1000) });
  const { tokenUri } = getCredentials();

  const response = await fetchImpl(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: JWT_GRANT_TYPE,
      assertion,
    }).toString(),
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  if (!response.ok || !body?.access_token) {
    const detail = body?.error_description || body?.error || text || `HTTP ${response.status}`;
    throw new Error(`Google token exchange failed: ${detail}`);
  }

  const expiresIn = Number(body.expires_in) || 3600;
  tokenCache.set(scope, {
    token: body.access_token,
    expiresAtMs: now + expiresIn * 1000,
  });

  return body.access_token;
}