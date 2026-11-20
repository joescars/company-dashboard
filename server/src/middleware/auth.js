import crypto from 'node:crypto';

/**
 * Access guards.
 *
 * requireAuth gates every non-public route; requireOperator narrows to the
 * allowlisted account. Both return JSON (never a redirect) for API callers so
 * the SPA can render an explicit signed-out state.
 */
export function requireAuth(req, res, next) {
  if (req.session?.user?.email) return next();

  res.status(401).json({
    error: 'authentication_required',
    message: 'Sign in to view this dashboard.',
  });
}

export function requireOperator(req, res, next) {
  if (req.session?.user?.email) return next();

  res.status(401).json({
    error: 'authentication_required',
    message: 'Sign in to view this dashboard.',
  });
}

/**
 * CSRF protection for state-changing requests.
 *
 * A per-session token is issued to the client and must be echoed back in the
 * X-CSRF-Token header. A cross-site form cannot read the token, so it cannot
 * forge an authenticated write.
 */
export function csrfProtection() {
  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

  return function csrfMiddleware(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();

    const expected = req.session?.csrfToken;
    const provided = req.get('x-csrf-token');

    if (!expected || !provided || !timingSafeEqual(expected, provided)) {
      return res.status(403).json({
        error: 'invalid_csrf_token',
        message: 'Request rejected: missing or invalid CSRF token.',
      });
    }

    return next();
  };
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}