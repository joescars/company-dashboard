import { Router } from 'express';

import { getSourceState, latestSnapshot, recordSourceResult, saveSnapshot } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import { SOURCE_KEY, fetchSearchConsole } from '../sources/searchConsole.js';

/**
 * Source data endpoints.
 *
 * Reads serve the latest cached snapshot alongside the source's health so the
 * UI can show stale-or-failed state without a live upstream call. Refreshes
 * fetch on demand and persist both the snapshot and the outcome, so a failed
 * fetch records an error while the last successful snapshot stays readable.
 *
 * Every route is auth-guarded; the refresh POST additionally passes through the
 * CSRF middleware mounted on /api before this router.
 */
export function sourcesRouter(config, { fetchImpl } = {}) {
  const router = Router();

  router.get('/searchConsole', requireAuth, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(viewOf('searchConsole', config));
  });

  router.post('/searchConsole/refresh', requireAuth, async (_req, res) => {
    const source = config?.sources?.searchConsole;
    if (!source?.enabled || !source.config?.siteUrl) {
      return res.status(503).json({
        error: 'source_not_configured',
        source: 'searchConsole',
        message:
          'Search Console is not enabled. Set GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 ' +
          'and GSC_SITE_URL to enable it.',
      });
    }

    const result = await fetchSearchConsole(source.config.siteUrl, { fetchImpl });

    if (!result.ok) {
      recordSourceResult(null, 'searchConsole', { ok: false, error: result.error });
      return res.status(502).json({
        error: 'source_fetch_failed',
        source: 'searchConsole',
        message: result.error,
        view: viewOf('searchConsole', config),
      });
    }

    saveSnapshot(null, 'searchConsole', result.data);
    recordSourceResult(null, 'searchConsole', { ok: true });

    return res.json(viewOf('searchConsole', config));
  });

  return router;
}

/** The latest snapshot plus health for one source, safe to send to a browser. */
function viewOf(key, config) {
  const snapshot = latestSnapshot(null, key);
  const state = getSourceState(null, key);
  const source = config?.sources?.[key];

  return {
    source: key,
    enabled: Boolean(source?.enabled),
    data: snapshot?.payload ?? null,
    fetchedAt: snapshot?.fetchedAt ?? null,
    health: {
      ok: Boolean(state?.lastSuccessAt) && !state?.lastError,
      lastSuccessAt: state?.lastSuccessAt ?? null,
      lastError: state?.lastError ?? null,
      lastErrorAt: state?.lastErrorAt ?? null,
    },
  };
}

export { SOURCE_KEY };