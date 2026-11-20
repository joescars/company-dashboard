import crypto from 'node:crypto';

import express from 'express';
import session from 'express-session';

import { loadConfig } from './lib/config.js';
import { securityHeaders } from './lib/security.js';
import { SqliteSessionStore } from './lib/session-store.js';
import { shellHandler } from './lib/shell.js';
import { csrfProtection } from './middleware/auth.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { configRouter } from './routes/config.js';
import { healthRouter } from './routes/health.js';
import { sourcesRouter } from './routes/sources.js';

/**
 * Assemble middleware and routes. Kept as a factory so tests can build an
 * app without binding a port, and so the config is resolved per instance.
 */
export function createApp({ config = loadConfig(), sessionStore, sessionSecret } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(securityHeaders());
  app.use(express.json({ limit: '256kb' }));

  // Sessions are backed by SQLite so logins survive a container restart.
  app.use(
    session({
      name: 'cd.sid',
      secret: resolveSessionSecret(sessionSecret),
      store: sessionStore || new SqliteSessionStore(),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    }),
  );

  // Public, non-sensitive endpoints.
  app.use('/api/health', healthRouter());
  app.use('/api/auth', authRouter());

  // Branding and the enabled-source flags only — never IDs or secrets. Public
  // so the sign-in screen can render the company name.
  app.use('/api/config', configRouter(config));

  // Any write must carry the session's CSRF token.
  app.use('/api', csrfProtection());

  // Operator-only. Write-only by design: reports set/not-set, never values.
  app.use('/api/admin', adminRouter());

  // Source data: reads are auth-gated, refresh writes are auth + CSRF gated.
  app.use('/api/sources', sourcesRouter(config));

  // SPA: serves the built bundle and falls back to index.html for client routes.
  app.use(shellHandler(config));

  return app;
}

/**
 * The session secret. In production a real secret is expected — falling back to
 * an ephemeral one is safe (it only invalidates sessions on restart) but the
 * operator is told about it rather than silently degraded.
 */
function resolveSessionSecret(explicit) {
  if (explicit) return explicit;
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;

  if (process.env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.warn(
      '[auth] SESSION_SECRET is not set; using an ephemeral secret. ' +
        'Users will be signed out whenever the process restarts. ' +
        'Generate one with: openssl rand -hex 32',
    );
  }

  return crypto.randomBytes(32).toString('hex');
}
