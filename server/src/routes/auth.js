import { Router } from 'express';

import {
  authSettings,
  authorizeUser,
  buildAuthUrl,
  decodeIdToken,
  exchangeCode,
  isAuthConfigured,
  randomState,
} from '../lib/auth.js';

/**
 * Google OAuth endpoints.
 *
 *   GET  /api/auth/status  — public: is login configured, and who am I
 *   GET  /api/auth/login   — redirect to Google
 *   GET  /api/auth/callback— exchange the code, apply the allowlist
 *   POST /api/auth/logout  — destroy the session
 */
export function authRouter({ settings = authSettings() } = {}) {
  const router = Router();

  router.get('/status', (req, res) => {
    ensureCsrfToken(req.session);
    res.json({
      configured: isAuthConfigured(settings),
      user: req.session?.user ?? null,
      csrfToken: req.session.csrfToken,
    });
  });

  router.get('/login', (req, res) => {
    if (!isAuthConfigured(settings)) {
      return res.status(503).json({
        error: 'auth_not_configured',
        message:
          'Login is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ' +
          'GOOGLE_CALLBACK_URL and ADMIN_EMAILS, then restart.',
      });
    }

    const state = randomState();
    req.session.oauthState = state;
    req.session.save((error) => {
      if (error) {
        return res.status(500).json({ error: 'session_error', message: 'Could not start login.' });
      }
      return res.redirect(buildAuthUrl(settings, state));
    });
  });

  router.get('/callback', async (req, res) => {
    const { code, state, error: providerError } = req.query;

    if (providerError) {
      return res.redirect('/?auth=denied');
    }

    if (!code || !state || state !== req.session?.oauthState) {
      return res.redirect('/?auth=state_mismatch');
    }
    delete req.session.oauthState;

    try {
      const tokens = await exchangeCode(settings, String(code));
      const user = authorizeUser(decodeIdToken(tokens.id_token), settings);

      // Re-issue the session identifier on privilege change to defeat fixation.
      return req.session.regenerate((regenError) => {
        if (regenError) return res.redirect('/?auth=session_error');

        req.session.user = user;
        ensureCsrfToken(req.session);
        return req.session.save(() => res.redirect('/'));
      });
    } catch {
      // Never surface provider detail to the browser.
      return res.redirect('/?auth=unauthorized');
    }
  });

  router.post('/logout', (req, res) => {
    if (!req.session) return res.json({ ok: true });

    req.session.destroy(() => {
      res.clearCookie('cd.sid');
      res.json({ ok: true });
    });
  });

  return router;
}

function ensureCsrfToken(session) {
  if (!session) return;
  if (!session.csrfToken) {
    session.csrfToken = randomState();
  }
}