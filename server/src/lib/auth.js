import crypto from 'node:crypto';

/**
 * Google OAuth (authorization code flow) and the admin allowlist.
 *
 * Only an email listed in ADMIN_EMAILS may use the dashboard. The allowlist is
 * re-checked on every login, so removing an address takes effect the next time
 * that person authenticates.
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'openid email profile';

export function authSettings(env = process.env) {
  const adminEmails = String(env.ADMIN_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    callbackUrl: env.GOOGLE_CALLBACK_URL || '',
    adminEmails,
  };
}

/**
 * Whether login can actually be performed. Without these we cannot start the
 * flow, and the app degrades to a setup screen rather than pretending to be
 * protected.
 */
export function isAuthConfigured(settings = authSettings()) {
  return Boolean(
    settings.clientId && settings.clientSecret && settings.callbackUrl && settings.adminEmails.length > 0,
  );
}

/** Build the Google consent URL, carrying an anti-CSRF state value. */
export function buildAuthUrl(settings, state) {
  const params = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: settings.callbackUrl,
    response_type: 'code',
    scope: SCOPE,
    state,
    access_type: 'online',
    prompt: 'select_account',
    include_granted_scopes: 'true',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** Exchange an authorization code for tokens. */
export async function exchangeCode(settings, code, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      redirect_uri: settings.callbackUrl,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`token exchange failed (${response.status}) ${sanitize(detail)}`);
  }

  return response.json();
}

/**
 * Decode the payload of an ID token.
 *
 * The token was received directly from Google's token endpoint over TLS, which
 * is the case where signature verification is not required to establish its
 * origin. We still refuse anything that is not a well-formed JWT payload.
 */
export function decodeIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('malformed id_token payload');
  }

  if (!payload || typeof payload !== 'object') throw new Error('empty id_token payload');
  return payload;
}

/** Verify Google's claims and the admin allowlist. Returns the user or throws. */
export function authorizeUser(claims, settings, { now = Date.now() } = {}) {
  if (!claims.email) throw new Error('account has no email address');
  if (claims.email_verified === false) throw new Error('email is not verified by the provider');
  if (claims.aud && settings.clientId && claims.aud !== settings.clientId) {
    throw new Error('id_token audience mismatch');
  }
  if (claims.iss && !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) {
    throw new Error('unexpected id_token issuer');
  }
  if (claims.exp && claims.exp * 1000 < now) throw new Error('id_token has expired');

  const email = String(claims.email).toLowerCase();
  if (!settings.adminEmails.includes(email)) {
    throw new Error('this account is not authorized for this dashboard');
  }

  return {
    email,
    name: claims.name || null,
    picture: claims.picture || null,
    sub: claims.sub || null,
  };
}

export function randomState() {
  return crypto.randomBytes(24).toString('base64url');
}

/** Strip anything that could echo a credential back into a log or response. */
function sanitize(text) {
  return String(text || '').replace(/[A-Za-z0-9_-]{20,}/g, '[redacted]').slice(0, 200);
}