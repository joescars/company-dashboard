/**
 * Simple Analytics source.
 *
 * Cookie-free traffic totals and a per-day series, used as a cross-check
 * against GA4. Two sections share one request:
 *   - `summary` — visitors / pageviews (and median seconds-on-page when the
 *                 API returns it).
 *   - `daily`   — a sorted `{ date, pageviews, visitors }` series.
 *
 * === VERIFIED CONTRACT ===
 * Endpoint (per the official Stats API docs,
 * https://docs.simpleanalytics.com/api/stats):
 *
 *   GET https://simpleanalytics.com/{site}.json
 *       ?version=6
 *       &fields=pageviews,visitors,histogram,seconds_on_page
 *       &start=YYYY-MM-DD
 *       &end=YYYY-MM-DD
 *       &info=false
 *   Header: 'Api-Key: sa_api_key_...'
 *
 * The site is a hostname in the URL path (`example.com.json`), NOT a query
 * param. Authentication is the `Api-Key` header (docs:
 * https://docs.simpleanalytics.com/api/authenticate); a public site needs no
 * key, but the top-pages field does, so the key is always sent when present.
 *
 * The parsing is deliberately DEFENSIVE: the docs pin the field names
 * (`pageviews`, `visitors`, `histogram: [{ date, pageviews, visitors }]`,
 * `seconds_on_page`), but a version bump or an unexpected deployment could
 * still surprise us, so several plausible shapes are accepted and an
 * unrecognized body returns `{ ok: false, error }` rather than throwing.
 */

export const SOURCE_KEY = 'simpleAnalytics';

const API_BASE = 'https://simpleanalytics.com';
const API_VERSION = '6';
const DEFAULT_LOOKBACK_DAYS = 28;

/** Fields requested in one Stats API call. */
const FIELDS = ['pageviews', 'visitors', 'histogram', 'seconds_on_page'];

/** Human-readable reason surfaced when the body matches none of our shapes. */
const UNRECOGNIZED = 'unrecognized response shape from Simple Analytics';

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;
}

/**
 * The trailing window to query. Simple Analytics takes plain ISO dates; the
 * window ends today and starts `days - 1` days back (both ends inclusive).
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

/** The site is a bare hostname in the path; strip any scheme/path/query. */
export function normalizeSite(site) {
  if (site === null || site === undefined) return null;
  let text = String(site).trim();
  if (text === '') return null;
  text = text.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  return text || null;
}

/** Build the documented Stats API URL for one site and window. */
export function buildStatsUrl(site, period = periodFor()) {
  const url = new URL(`${API_BASE}/${normalizeSite(site)}.json`);
  url.searchParams.set('version', API_VERSION);
  url.searchParams.set('fields', FIELDS.join(','));
  url.searchParams.set('start', period.startDate);
  url.searchParams.set('end', period.endDate);
  url.searchParams.set('info', 'false');
  return url.toString();
}

/**
 * Reduce the Stats API payload to `{ visitors, pageviews, secondsOnPage }`.
 *
 * Accepts the documented root object (`{ visitors, pageviews, seconds_on_page }`)
 * and a few plausible variants (camelCase keys, a `data` wrapper, or an array
 * of daily rows from which totals are summed). Returns null when nothing
 * recognizable is present.
 */
export function shapeSummary(data) {
  const source = unwrap(data);
  if (!source) return null;

  if (Array.isArray(source)) {
    return sumRows(source);
  }

  const visitors = num(source.visitors ?? source.unique_visitors ?? source.uniqueVisitors);
  const pageviews = num(source.pageviews ?? source.page_views ?? source.pageViews);
  const secondsOnPage = num(
    source.seconds_on_page ?? source.secondsOnPage ?? source.average_seconds_on_page,
  );

  if (visitors === null && pageviews === null && secondsOnPage === null) {
    return null;
  }

  return {
    visitors,
    pageviews,
    secondsOnPage: secondsOnPage === null ? null : round(secondsOnPage),
  };
}

/**
 * Reduce the Stats API payload to a sorted `{ date, pageviews, visitors }`
 * series, from the documented `histogram` array or a bare array of daily rows.
 * Returns [] when there is no usable series (never throws).
 */
export function shapeDaily(data) {
  const source = unwrap(data);
  if (!source || Array.isArray(source)) {
    return Array.isArray(source) ? normalizeDayRows(source) : [];
  }

  const histogram = source.histogram ?? source.histograms ?? source.by_day ?? source.days;
  if (Array.isArray(histogram)) return normalizeDayRows(histogram);

  // Some deployments nest the series under `data`.
  const nested = source.data;
  if (Array.isArray(nested)) return normalizeDayRows(nested);

  return [];
}

/** Peel a single-level `{ data: ... }` wrapper, leaving other shapes alone. */
function unwrap(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const inner = data.data;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner;
    if (Array.isArray(inner)) return inner;
  }
  return data ?? null;
}

/** Normalize a list of per-day rows, dropping unusable entries. */
function normalizeDayRows(rows) {
  const byDate = new Map();
  for (const row of rows) {
    const date = row?.date ?? row?.day ?? row?.value ?? null;
    const pageviews = num(row?.pageviews ?? row?.page_views ?? row?.views);
    const visitors = num(row?.visitors ?? row?.unique_visitors ?? row?.uniqueVisitors);
    if (!date || (pageviews === null && visitors === null)) continue;

    const existing = byDate.get(date) ?? { date, pageviews: 0, visitors: 0 };
    existing.pageviews = round(existing.pageviews + (pageviews ?? 0));
    existing.visitors = round(existing.visitors + (visitors ?? 0));
    byDate.set(date, existing);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Sum a bare array of daily rows into a summary. */
function sumRows(rows) {
  const daily = normalizeDayRows(rows);
  if (daily.length === 0) return null;
  let pageviews = 0;
  let visitors = 0;
  for (const day of daily) {
    pageviews += day.pageviews;
    visitors += day.visitors;
  }
  return { visitors: round(visitors), pageviews: round(pageviews), secondsOnPage: null };
}

/** Extract a short upstream error message without leaking the request body. */
async function readErrorDetail(response) {
  try {
    const body = await response.json();
    const message = body?.error ?? body?.error?.message ?? body?.message;
    return message ? ` (${String(message).slice(0, 200)})` : '';
  } catch {
    return '';
  }
}

/**
 * Fetch the whole Simple Analytics source.
 *
 * Never throws for an upstream/HTTP error: both sections carry their own
 * `ok`/`error`. A missing `site` is a configuration mistake and does throw.
 *
 * @param {object} config
 * @param {string} config.site    required — the tracked hostname (e.g. example.com)
 * @param {string} [config.apiKey] the `Api-Key` credential (public sites work without one)
 * @returns {Promise<{ok:boolean, fetchedAt:string, period:object,
 *                    sections:{summary:object, daily:object}}>}
 */
export async function fetchSimpleAnalytics(
  config,
  { fetchImpl, now = () => new Date(), days } = {},
) {
  const site = normalizeSite(config?.site);
  if (!site) throw new Error('simpleAnalytics: missing required config field(s): site');

  const doFetch = fetchImpl ?? globalThis.fetch;
  const stamp = now() ?? new Date();
  const period = periodFor(days, stamp);
  const url = buildStatsUrl(site, period);

  const headers = { accept: 'application/json' };
  if (config?.apiKey) headers['Api-Key'] = config.apiKey;

  let response;
  try {
    response = await doFetch(url, { method: 'GET', headers });
  } catch (error) {
    const failure = { ok: false, error: `simpleanalytics request failed: ${error.message}` };
    return { ok: false, fetchedAt: stamp.toISOString(), period, sections: { summary: failure, daily: { ...failure } } };
  }

  if (!response || !response.ok) {
    const detail = await readErrorDetail(response);
    const failure = {
      ok: false,
      error: `simpleanalytics request failed with HTTP ${response?.status}${detail}`,
    };
    return { ok: false, fetchedAt: stamp.toISOString(), period, sections: { summary: failure, daily: { ...failure } } };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    const failure = { ok: false, error: 'simpleanalytics response was not valid JSON' };
    return { ok: false, fetchedAt: stamp.toISOString(), period, sections: { summary: failure, daily: { ...failure } } };
  }

  const summary = shapeSummary(payload);
  const daily = shapeDaily(payload);

  const sections = {
    summary: summary ? { ok: true, ...summary } : { ok: false, error: UNRECOGNIZED },
    daily: Array.isArray(daily) && daily.length ? { ok: true, days: daily } : { ok: false, error: UNRECOGNIZED },
  };

  // `summary` is the source of truth for the whole-source status; a usable
  // summary with an empty histogram is still a success.
  const ok = Boolean(sections.summary.ok || sections.daily.ok);

  return { ok, fetchedAt: stamp.toISOString(), period, sections };
}

/**
 * Adapt a loaded app config into the flat shape the fetcher expects. The site
 * identifier and API key both come from the environment; the app config is a
 * fallback for callers that pass one in explicitly.
 */
export function simpleAnalyticsConfigFromApp(appConfig, env = process.env) {
  return {
    site: env.SIMPLE_ANALYTICS_SITE ?? appConfig?.sources?.simpleAnalytics?.config?.site ?? null,
    apiKey: env.SIMPLE_ANALYTICS_API_KEY ?? null,
  };
}