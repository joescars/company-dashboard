import { getAccessToken } from '../lib/google.js';

/**
 * Google Analytics 4 source.
 *
 * Queries the GA4 Data API (`runReport`) for two views of one property:
 *   a) `totals`   — 28-day summary metrics (sessions, users, page views,
 *                   engagement rate, average session duration).
 *   b) `topPages` — the ten most-viewed page paths over the same window.
 *
 * Both reports share one service-account access token from `../lib/google.js`
 * (Analytics Data API enabled; the service account added as Viewer on the
 * property). Nothing here throws for an upstream error: each section carries
 * its own `ok`/`error` so a partial outage renders what it can. A missing
 * `propertyId` is a configuration mistake and does throw — the caller treats
 * that as a programmer/deploy error, not a transient upstream failure.
 *
 * Endpoint:
 *   POST https://analyticsdata.googleapis.com/v1beta/properties/{propertyId}:runReport
 */

export const SOURCE_KEY = 'ga4';
export const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

const API_BASE = 'https://analyticsdata.googleapis.com/v1beta';

/** GA4 accepts these relative date literals in a `dateRanges` entry. */
export const DATE_RANGE = { startDate: '28daysAgo', endDate: 'today' };

/** Metrics requested for the 28-day totals report, in order. */
export const TOTAL_METRICS = [
  'sessions',
  'totalUsers',
  'screenPageViews',
  'engagementRate',
  'averageSessionDuration',
];

/** Metrics/dimensions requested for the top-pages report. */
export const TOP_PAGE_DIMENSIONS = ['pagePath'];
export const TOP_PAGE_METRICS = ['screenPageViews', 'sessions'];
export const TOP_PAGE_LIMIT = 10;

/**
 * Reduce a GA4 property identifier to its bare numeric form.
 *
 * Config may be given as `123456789` or `properties/123456789`; GA4 wants the
 * numeric id and the report path is built from it. A measurement id (`G-XXXX`)
 * is NOT a property id — it is returned unchanged so the caller/operator sees
 * the mistake instead of a silently-wrong report path.
 */
export function normalizePropertyId(propertyId) {
  if (propertyId === null || propertyId === undefined) return null;
  const text = String(propertyId).trim();
  if (text === '') return null;
  return text.startsWith('properties/') ? text.slice('properties/'.length) : text;
}

/**
 * Is this a usable GA4 property id? A numeric id (with or without the
 * `properties/` prefix) is valid; a `G-` measurement id is not.
 */
export function isNumericPropertyId(propertyId) {
  const bare = normalizePropertyId(propertyId);
  return bare !== null && /^\d+$/.test(bare);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;
}

/**
 * Pull the metric value at `index` out of a GA4 row, converting the string the
 * API returns into a number (or null when absent/non-numeric).
 */
function metricAt(row, index) {
  const raw = row?.metricValues?.[index]?.value;
  return num(raw);
}

/**
 * Reduce the totals `runReport` response to plain numbers.
 *
 * GA4 returns `{ rows: [{ metricValues: [{ value: "123" }, ...] }] }`; a report
 * with no rows (an empty property) returns `{}` — every metric is then null
 * rather than missing.
 */
export function shapeTotals(data) {
  const row = Array.isArray(data?.rows) ? data.rows[0] : null;
  return {
    sessions: metricAt(row, 0),
    totalUsers: metricAt(row, 1),
    screenPageViews: metricAt(row, 2),
    engagementRate: metricAt(row, 3),
    averageSessionDuration: metricAt(row, 4),
  };
}

/**
 * Reduce the top-pages `runReport` response to a sorted list of
 * `{ pagePath, screenPageViews, sessions }`. Order is preserved from the API
 * (already `screenPageViews` desc); ties fall back to the reported order.
 */
export function shapeTopPages(data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  return rows
    .map((row) => ({
      pagePath: row?.dimensionValues?.[0]?.value ?? null,
      screenPageViews: num(row?.metricValues?.[0]?.value),
      sessions: num(row?.metricValues?.[1]?.value),
    }))
    .sort((a, b) => (num(b.screenPageViews) ?? 0) - (num(a.screenPageViews) ?? 0));
}

/** Map a metric name to its 0-based position in the requested metric list. */
function metricIndex(metrics, name) {
  const index = metrics.indexOf(name);
  return index >= 0 ? index : metrics.length;
}

/**
 * POST one `runReport` and normalize the response into a section envelope.
 * Returns `{ ok: true, ...data }` or `{ ok: false, error }`.
 */
async function runReport(section, propertyId, body, { token, fetchImpl } = {}) {
  const url = `${API_BASE}/properties/${encodeURIComponent(propertyId)}:runReport`;

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, error: `${section} request failed: ${error.message}` };
  }

  if (!response || !response.ok) {
    const detail = await readErrorDetail(response);
    return { ok: false, error: `${section} request failed with HTTP ${response?.status}${detail}` };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: `${section} response was not valid JSON` };
  }

  return { ok: true, data: payload };
}

/** Extract a short upstream error message without leaking the request body. */
async function readErrorDetail(response) {
  try {
    const body = await response.json();
    const message = body?.error?.message ?? body?.error ?? body?.message;
    return message ? ` (${String(message).slice(0, 200)})` : '';
  } catch {
    return '';
  }
}

/**
 * Fetch both GA4 reports for one property.
 *
 * @param {object} config
 * @param {string} config.propertyId  required — numeric property id (or
 *                                    `properties/<id>`); a `G-` measurement id
 *                                    is rejected as a configuration error.
 * @returns {Promise<{ok:boolean, fetchedAt:string, period:object,
 *                    sections:{totals:object, topPages:object}}>}
 */
export async function fetchGa4(config, { fetchImpl, now = () => new Date(), ...rest } = {}) {
  const propertyId = normalizePropertyId(config?.propertyId);
  if (!propertyId) throw new Error('ga4: missing required config field(s): propertyId');
  if (!isNumericPropertyId(propertyId)) {
    throw new Error(
      `ga4: propertyId "${propertyId}" is not a numeric GA4 property id ` +
        '(a G- measurement id is not accepted)',
    );
  }

  const doFetch = fetchImpl ?? globalThis.fetch;
  const stamp = now() ?? new Date();

  /** Read the token once; a credential failure fails both sections alike. */
  let token;
  try {
    token = await getAccessToken(SCOPE, { fetchImpl: doFetch, ...rest });
  } catch (error) {
    const failure = { ok: false, error: error.message || String(error) };
    return {
      ok: false,
      fetchedAt: stamp.toISOString(),
      period: { ...DATE_RANGE },
      sections: { totals: failure, topPages: { ...failure } },
    };
  }

  const sections = {};
  const errors = {};

  const totalsResult = await runReport(
    'totals',
    propertyId,
    {
      dateRanges: [DATE_RANGE],
      metrics: TOTAL_METRICS.map((name) => ({ name })),
    },
    { token, fetchImpl: doFetch },
  );
  sections.totals = totalsResult.ok
    ? { ok: true, ...shapeTotals(totalsResult.data) }
    : totalsResult;
  if (!sections.totals.ok) errors.totals = sections.totals.error;

  const topPagesResult = await runReport(
    'topPages',
    propertyId,
    {
      dateRanges: [DATE_RANGE],
      dimensions: TOP_PAGE_DIMENSIONS.map((name) => ({ name })),
      metrics: TOP_PAGE_METRICS.map((name) => ({ name })),
      limit: TOP_PAGE_LIMIT,
      orderBys: [
        { metric: { metricName: 'screenPageViews' }, desc: true },
      ],
    },
    { token, fetchImpl: doFetch },
  );
  sections.topPages = topPagesResult.ok
    ? { ok: true, pages: shapeTopPages(topPagesResult.data) }
    : topPagesResult;
  if (!sections.topPages.ok) errors.topPages = sections.topPages.error;

  const ok = Boolean(sections.totals?.ok || sections.topPages?.ok);

  return {
    ok,
    fetchedAt: stamp.toISOString(),
    period: { ...DATE_RANGE },
    sections,
    errors: Object.keys(errors).length ? errors : null,
  };
}

/**
 * Adapt a loaded app config into the flat shape the fetcher expects.
 * Identifiers come from the environment; the app config is a fallback for
 * callers that pass one in explicitly.
 */
export function ga4ConfigFromApp(appConfig, env = process.env) {
  return {
    propertyId: env.GA4_PROPERTY_ID ?? appConfig?.sources?.ga4?.config?.propertyId ?? null,
  };
}