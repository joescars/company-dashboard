import { getAccessToken } from '../lib/google.js';

/**
 * Google Search Console source.
 *
 * Queries the Search Analytics API for the last 28 days grouped by query and
 * by page, and validates the configured site against the account's site list.
 *
 * `fetchSearchConsole` never throws: every failure — missing credentials, an
 * unknown site, a non-2xx response — is returned as `{ ok: false, error }` so
 * the caller can persist a source error without a try/catch around the fetch.
 */

export const SOURCE_KEY = 'searchConsole';
export const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

const API_BASE = 'https://searchconsole.googleapis.com/webmasters/v3';
const DEFAULT_LOOKBACK_DAYS = 28;

/** Dimensions returned per request. */
const QUERY_DIMENSIONS = ['query'];
const PAGE_DIMENSIONS = ['page'];
const ROW_LIMIT = 100;

/** Metric keys carried through from the API response. */
const METRICS = ['clicks', 'impressions', 'ctr', 'position'];

/**
 * The trailing window to query. Search Console data lags a few days, so the
 * window ends today and starts `days - 1` days back (inclusive of both ends).
 */
export function periodFor(days = DEFAULT_LOOKBACK_DAYS, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));

  return { startDate: isoDate(start), endDate: isoDate(end) };
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/** Search Console site identifiers are URLs; only path/query need escaping. */
function encodeSite(siteUrl) {
  return encodeURIComponent(siteUrl);
}

async function postJson(url, token, body, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const detail = parsed?.error?.message || text || `HTTP ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }

  return parsed ?? {};
}

async function getJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}` },
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const detail = parsed?.error?.message || text || `HTTP ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }

  return parsed ?? {};
}

/** Map API rows to plain metric objects, dropping the dimension label. */
function mapRows(rows) {
  return (rows || []).map((row) => {
    const entry = {};
    for (const metric of METRICS) {
      entry[metric] = row[metric] ?? null;
    }
    entry.keys = row.keys ?? [];
    return entry;
  });
}

/** Sum clicks and impressions, and weight ctr/position by impressions. */
export function sumTotals(rows) {
  let clicks = 0;
  let impressions = 0;
  let weightedCtr = 0;
  let weightedPosition = 0;

  for (const row of rows || []) {
    const rowImpressions = Number(row.impressions) || 0;
    clicks += Number(row.clicks) || 0;
    impressions += rowImpressions;
    weightedCtr += (Number(row.ctr) || 0) * rowImpressions;
    weightedPosition += (Number(row.position) || 0) * rowImpressions;
  }

  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? weightedCtr / impressions : 0,
    position: impressions > 0 ? weightedPosition / impressions : 0,
  };
}

/**
 * Fetch the last 28 days of Search Console data for `siteUrl`.
 *
 * @returns {Promise<{ok: boolean, data: object|null, error: string|null}>}
 */
export async function fetchSearchConsole(siteUrl, { fetchImpl = fetch, days, now } = {}) {
  if (!siteUrl) {
    return { ok: false, data: null, error: 'Search Console site URL is not configured.' };
  }

  const period = periodFor(days, now);

  try {
    const token = await getAccessToken(SCOPE, { fetchImpl });

    // Validate the configured site exists on the account before querying it;
    // a typo then reports a clear "unknown site" rather than an opaque 403.
    const sites = await getJson(`${API_BASE}/sites`, token, fetchImpl);
    const known = (sites.siteEntry || []).map((entry) => entry.siteUrl);
    if (known.length && !known.includes(siteUrl)) {
      return {
        ok: false,
        data: null,
        error: `Configured site "${siteUrl}" is not available to this service account.`,
      };
    }

    const queryBody = {
      startDate: period.startDate,
      endDate: period.endDate,
      rowLimit: ROW_LIMIT,
    };

    const byQuery = await postJson(
      `${API_BASE}/sites/${encodeSite(siteUrl)}/searchAnalytics/query`,
      token,
      { ...queryBody, dimensions: QUERY_DIMENSIONS },
      fetchImpl,
    );
    const byPage = await postJson(
      `${API_BASE}/sites/${encodeSite(siteUrl)}/searchAnalytics/query`,
      token,
      { ...queryBody, dimensions: PAGE_DIMENSIONS },
      fetchImpl,
    );

    return {
      ok: true,
      data: {
        queries: mapRows(byQuery.rows),
        pages: mapRows(byPage.rows),
        totals: sumTotals(byQuery.rows),
        period,
      },
      error: null,
    };
  } catch (error) {
    return { ok: false, data: null, error: error.message || String(error) };
  }
}