import { Router } from 'express';

import { getSourceState, latestSnapshot, recordSourceResult, saveSnapshot } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import { azureConfigFromApp, fetchAzure } from '../sources/azure.js';
import { fetchOpenRouter, openRouterConfigFromApp } from '../sources/openrouter.js';

/**
 * Source data endpoints.
 *
 * Every route here is guarded by requireAuth. The refresh route is a write:
 * it sits behind the app-level CSRF middleware (mounted on /api before this
 * router), so a state-changing POST must carry the session's X-CSRF-Token.
 *
 *   GET  /api/sources/:source          latest cached snapshot + source health
 *   POST /api/sources/:source/refresh  fetch now, persist, return the result
 *
 * A disabled/unconfigured source returns 503 with a clear reason rather than
 * pretending to have data.
 */

/** Registry: one entry per supported source, wiring config + fetcher. */
const SOURCES = {
  azure: {
    label: 'Azure',
    isEnabled: (config) => Boolean(config?.sources?.azure?.enabled),
    buildFetcherConfig: (config, env) => azureConfigFromApp(config, env),
    fetch: fetchAzure,
  },
  openrouter: {
    label: 'OpenRouter',
    isEnabled: (config) => Boolean(config?.sources?.openrouter?.enabled),
    buildFetcherConfig: (config, env) => openRouterConfigFromApp(config, env),
    fetch: fetchOpenRouter,
  },
};

/** Allow tests (and callers) to inject a fetch implementation. */
export function sourcesRouter(config, { fetchImpl, env = process.env, now } = {}) {
  const router = Router();

  router.use(requireAuth);

  router.get('/:source', (req, res) => {
    const entry = SOURCES[req.params.source];
    if (!entry) return notFound(res, req.params.source);

    res.setHeader('Cache-Control', 'no-store');
    const snapshot = latestSnapshot(null, req.params.source);
    const state = getSourceState(null, req.params.source);

    return res.json({
      source: req.params.source,
      enabled: entry.isEnabled(config),
      health: state,
      snapshot: snapshot
        ? { id: snapshot.id, fetchedAt: snapshot.fetchedAt, payload: snapshot.payload }
        : null,
    });
  });

  router.post('/:source/refresh', async (req, res) => {
    const entry = SOURCES[req.params.source];
    if (!entry) return notFound(res, req.params.source);

    if (!entry.isEnabled(config)) {
      return res.status(503).json({
        error: 'source_not_configured',
        message: `${entry.label} is not enabled. Add its credentials and identifiers to enable it.`,
      });
    }

    let result;
    try {
      const fetcherConfig = entry.buildFetcherConfig(config, env);
      result = await entry.fetch(fetcherConfig, { fetchImpl, ...(now ? { now: () => now() } : {}) });
    } catch (error) {
      // A configuration/programmer error, not an upstream failure.
      recordSourceResult(null, req.params.source, { ok: false, error: error.message });
      return res.status(500).json({
        error: 'source_fetch_failed',
        message: error.message,
      });
    }

    const saved = result.ok
      ? saveSnapshot(null, req.params.source, result, {
          fetchedAt: result.fetchedAt || new Date().toISOString(),
        })
      : null;

    recordSourceResult(null, req.params.source, {
      ok: result.ok,
      error: result.ok ? null : summarizeErrors(result),
    });

    return res.status(result.ok ? 200 : 502).json({
      source: req.params.source,
      ok: result.ok,
      saved: Boolean(saved),
      fetchedAt: result.fetchedAt ?? null,
      snapshotId: saved?.id ?? null,
      health: getSourceState(null, req.params.source),
      data: result,
    });
  });

  return router;
}

function notFound(res, source) {
  return res.status(404).json({
    error: 'unknown_source',
    message: `There is no source named "${source}".`,
  });
}

/** Collapse a partial-failure result into one line for source_state. */
function summarizeErrors(result) {
  if (result.errors && typeof result.errors === 'object' && Object.keys(result.errors).length) {
    return Object.values(result.errors).join('; ').slice(0, 500);
  }
  return 'source fetch produced no successful section';
}