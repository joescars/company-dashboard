import { Router } from 'express';

import { getSourceState, latestSnapshot, recordSourceResult, saveSnapshot } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import { azureConfigFromApp, fetchAzure } from '../sources/azure.js';
import { fetchOpenRouter, openRouterConfigFromApp } from '../sources/openrouter.js';
import { fetchSearchConsole } from '../sources/searchConsole.js';

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

/**
 * Registry: one entry per supported source, wiring config + fetcher.
 *
 * `payloadOf` lets a source store just its useful data in the snapshot row
 * instead of the whole fetch envelope (Search Console returns `{ok, data}`,
 * while Azure/OpenRouter already return the payload itself).
 */
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
  searchConsole: {
    label: 'Search Console',
    isEnabled: (config) => Boolean(config?.sources?.searchConsole?.enabled),
    buildFetcherConfig: (config) => ({
      siteUrl: config?.sources?.searchConsole?.config?.siteUrl ?? null,
    }),
    fetch: (fetcherConfig, { fetchImpl } = {}) =>
      fetchSearchConsole(fetcherConfig.siteUrl, { fetchImpl }),
    payloadOf: (result) => result.data ?? result,
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
    const payload = snapshot?.payload ?? null;

    return res.json({
      source: req.params.source,
      enabled: entry.isEnabled(config),
      health: healthOf(req.params.source),
      // `snapshot` is the envelope; `data`/`fetchedAt` mirror its payload so
      // callers can read either shape without unwrapping.
      snapshot: snapshot
        ? { id: snapshot.id, fetchedAt: snapshot.fetchedAt, payload: snapshot.payload }
        : null,
      data: payload,
      fetchedAt: snapshot?.fetchedAt ?? null,
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

    const payload = entry.payloadOf ? entry.payloadOf(result) : result;
    const saved = result.ok
      ? saveSnapshot(null, req.params.source, payload, {
          fetchedAt: result.fetchedAt || new Date().toISOString(),
        })
      : null;

    recordSourceResult(null, req.params.source, {
      ok: result.ok,
      error: result.ok ? null : summarizeErrors(result),
    });

    const body = {
      source: req.params.source,
      ok: result.ok,
      saved: Boolean(saved),
      fetchedAt: saved?.fetchedAt ?? result.fetchedAt ?? null,
      snapshotId: saved?.id ?? null,
      health: healthOf(req.params.source),
      data: payload,
    };

    if (!result.ok) {
      body.error = 'source_fetch_failed';
      body.message = summarizeErrors(result);
    }

    return res.status(result.ok ? 200 : 502).json(body);
  });

  return router;
}

function notFound(res, source) {
  return res.status(404).json({
    error: 'unknown_source',
    message: `There is no source named "${source}".`,
  });
}

/**
 * A normalized health object is always returned, even before the first fetch,
 * so the UI can render state without null checks.
 */
function healthOf(source) {
  const state = getSourceState(null, source);
  return {
    ok: Boolean(state?.lastSuccessAt) && !state?.lastError,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    lastError: state?.lastError ?? null,
    lastErrorAt: state?.lastErrorAt ?? null,
  };
}

/** Collapse a partial-failure result into one line for source_state. */
function summarizeErrors(result) {
  if (result.errors && typeof result.errors === 'object' && Object.keys(result.errors).length) {
    return Object.values(result.errors).join('; ').slice(0, 500);
  }
  return result.error || 'source fetch produced no successful section';
}
