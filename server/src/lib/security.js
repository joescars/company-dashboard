import crypto from 'node:crypto';

/**
 * Security headers + a per-request CSP nonce.
 *
 * The CSP is strict: no inline scripts except those carrying the request's
 * nonce. In development the Vite dev server needs 'unsafe-inline' styles and a
 * websocket connection, so a relaxed variant is used outside production.
 */
export function securityHeaders() {
  return function securityHeadersMiddleware(req, res, next) {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;

    const isProd = process.env.NODE_ENV === 'production';
    const scriptSrc = ["'self'", `'nonce-${nonce}'`];
    const styleSrc = ["'self'", "'unsafe-inline'"];
    const connectSrc = ["'self'"];

    if (!isProd) {
      // Vite HMR.
      connectSrc.push('ws:', 'http://localhost:5173');
      scriptSrc.push('http://localhost:5173');
      styleSrc.push('http://localhost:5173');
    }

    const csp = [
      "default-src 'self'",
      `script-src ${scriptSrc.join(' ')}`,
      `style-src ${styleSrc.join(' ')}`,
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      `connect-src ${connectSrc.join(' ')}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');

    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  };
}