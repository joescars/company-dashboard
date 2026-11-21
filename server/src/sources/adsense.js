import { getAccessToken } from '../lib/google.js';

/**
 * Google AdSense source: 30-day estimated earnings, page views and audience.
 *
 * One report request against the AdSense Management API v2:
 *
 *   GET https://adsense.googleapis.com/v2/accounts/{accountId}/reports:generate
 *       ?dimensions[]=DATE
 *       &metrics[]=ESTIMATED_EARNINGS,PAGE_VIEWS,IMPRESSIONS,CLICKS,PAGE_VIEWS_RPM
 *       &startDate.year=&startDate.month=&startDate.day=
 *       &endDate.year=&endDate.month=&endDate.day=
 *
 * Metric names confirmed against the AdSense v2 `Metric` enum
 * (developers.google.com/adsense/management/reference/rest/v2/Metric):
 * ESTIMATED_EARNINGS, PAGE_VIEWS, IMPRESSIONS, CLICKS, PAGE_VIEWS_RPM all exist.
 *
 * We pass an explicit `startDate`/`endDate` pair (the `Date {year, month, day}`
 * object form) rather than `dateRange=LAST_30_DAYS`: the explicit form is
 * unambiguous about the inclusive window, matches what `periodFor` reports
 * back, and avoids relying on the server's interpretation of a named range.
 *
 * Unlike Search Console, this source never throws for an upstream error —
 * missing credentials, a non-2xx response, an unparseable body are all
 * returned as `{ ok: false, error }` on the failing section so the caller can
 * persist a source error without a try/catch around the fetch.
 */

export const SOURCE_KEY = 'adsense';
export const SCOPE = 'https://www.googleapis.com/auth/adsense.readonly';

const API_BASE = 'https://adsense.googleapis.com/v2';
const DEFAULT_LOOKBACK_DAYS = 30;

/** Report dimensions requested — one row per calendar date. */
const DIMENSIONS = ['DATE'];

/**
 * Metrics requested, in the order the AdSense v2 reports API documents them.
 * We map cells back to fields BY HEADER NAME, never by position, so this order
 * only affects the request, not how the response is decoded.
 */
const METRICS = ['ESTIMATED_EARNINGS', 'PAGE_VIEWS', 'IMPRESSIONS', 'CLICKS', 'PAGE_VIEWS_RPM'];

/** Earnings arrive in micros (1e6 units of the account currency). */
const MICROS_PER_UNIT = 1e6;

/**
 * The trailing window to report on. Unlike Search Console the AdSense data is
 * available for the full reporting window, so we include `days` calendar days
 * ending today (inclusive of both ends), matching the LAST_30_DAYS default.
 */
export function periodFor(days = DEFAULT_LOOKBACK_DAYS, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));

  return { startDate: isoDate(start), endDate: isoDate(end) };
}

/** Alias matching the task's required export name; mirrors `periodFor`. */
export function paymentDateFor(days = DEFAULT_LOOKBACK_DAYS, now = new Date()) {
  return periodFor(days, now);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Normalize an account id to the bare `pub-…` form. Accepts the id with or
 * without an `accounts/` prefix and strips the prefix when present.
 */
export function normalizeAccountId(accountId) {
  const value = String(accountId ?? '').trim();
  return value.startsWith('accounts/') ? value.slice('accounts/'.length) : value;
}

/** `{year, month, day}` object from an ISO `YYYY-MM-DD` string. */
function dateObject(iso) {
  const [year, month, day] = iso.split('-').map((part) => Number(part));
  return { year, month, day };
}

/**
 * Turn a `headers[]` array into a name -> index map. The AdSense API documents
 * headers as `{ name, type, currencyCode? }`; we key on the name so a row can
 * be decoded regardless of the order the server returns columns in.
 */
function headerIndex(headers) {
  const index = new Map();
  (Array.isArray(headers) ? headers : []).forEach((header, position) => {
    const name = header?.name;
    if (name) index.set(name, position);
  });
  return index;
}

/** A currency header's ISO-4217 code, from whichever column carries it. */
function currencyFromHeaders(headers) {
  const header = (Array.isArray(headers) ? headers : []).find(
    (entry) => entry?.name === 'ESTIMATED_EARNINGS' && entry?.currencyCode,
  );
  return header?.currencyCode ?? null;
}

/**
 * Read one raw row (positional) into a name-keyed map using the header index.
 *
 * The API returns each row as `{ cells: [{ value }] }`. A bare array of cells
 * (as some client libraries and fixtures produce) is also accepted so the
 * decoder is not coupled to one serialization.
 */
function decodeRow(row, index) {
  const cells = Array.isArray(row) ? row : (row?.cells ?? []);
  const valueAt = (position) =>
    position === undefined ? undefined : (cells[position]?.value ?? cells[position]);
  const pick = (name) => valueAt(index.get(name));

  return {
    date: pick('DATE') ?? null,
    estimatedEarningsMicros: num(pick('ESTIMATED_EARNINGS')),
    pageViews: num(pick('PAGE_VIEWS')),
    impressions: num(pick('IMPRESSIONS')),
    clicks: num(pick('CLICKS')),
    rpm: num(pick('PAGE_VIEWS_RPM')),
  };
}

/**
 * Reduce a `reports:generate` `ReportResult` into a per-day series plus the
 * 30-day totals. Rows are decoded by header name; a missing or empty `rows`
 * array is a legitimate empty result (zeros), not an error.
 *
 * Earnings are converted from micros to currency units (÷ 1e6) and the
 * currency code carried through.
 */
export function shapeReport(report, { days = DEFAULT_LOOKBACK_DAYS } = {}) {
  const headers = report?.headers ?? [];
  const index = headerIndex(headers);
  const currency = currencyFromHeaders(headers) ?? report?.currencyCode ?? null;

  const rawRows = Array.isArray(report?.rows) ? report.rows : [];
  const decoded = rawRows.map((row) => decodeRow(row, index));

  let earningsMicros = 0;
  let pageViews = 0;
  let impressions = 0;
  let clicks = 0;

  const daily = decoded
    .map((row) => {
      earningsMicros += row.estimatedEarningsMicros ?? 0;
      pageViews += row.pageViews ?? 0;
      impressions += row.impressions ?? 0;
      clicks += row.clicks ?? 0;

      return {
        date: row.date,
        estimatedEarnings: microsToUnits(row.estimatedEarningsMicros),
        pageViews: row.pageViews,
        impressions: row.impressions,
        clicks: row.clicks,
        rpm: round(row.rpm),
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // The summary rolls the per-day numbers up. RPM is a ratio, so recompute it
  // from the summed totals rather than summing per-day RPMs.
  const estimatedEarnings = microsToUnits(earningsMicros);
  const rpm =
    pageViews > 0 && Number.isFinite(estimatedEarnings)
      ? round((estimatedEarnings / pageViews) * 1000)
      : null;

  return {
    windowDays: days,
    currency,
    summary: {
      estimatedEarnings,
      pageViews,
      impressions,
      clicks,
      rpm,
    },
    daily,
  };
}

/** Micros (1e6 units) -> currency units, rounded to 6 dp; null stays null. */
function microsToUnits(micros) {
  if (micros === null || micros === undefined || !Number.isFinite(micros)) return null;
  return round(micros / MICROS_PER_UNIT);
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;
}

/** Append repeated query params (`dimensions[]=DATE`) in order. */
function appendList(params, key, values) {
  for (const value of values) params.append(key, value);
}

function buildReportUrl(accountId, period) {
  const params = new URLSearchParams();
  appendList(params, 'dimensions', DIMENSIONS);
  appendList(params, 'metrics', METRICS);

  const start = dateObject(period.startDate);
  const end = dateObject(period.endDate);
  params.append('startDate.year', String(start.year));
  params.append('startDate.month', String(start.month));
  params.append('startDate.day', String(start.day));
  params.append('endDate.year', String(end.year));
  params.append('endDate.month', String(end.month));
  params.append('endDate.day', String(end.day));

  return `${API_BASE}/accounts/${encodeURIComponent(accountId)}/reports:generate?${params.toString()}`;
}

/** A short upstream error detail, without leaking the request body. */
function errorDetail(parsed, text, status) {
  return parsed?.error?.message || text || `HTTP ${status}`;
}

/**
 * Fetch one report section. Returns `{ ok: true, report }` on success or
 * `{ ok: false, error }` on any failure — never throws for an upstream error.
 */
async function getReport({ accountId, token, period, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(buildReportUrl(accountId, period), {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (error) {
    return { ok: false, error: `adsense request failed: ${error.message}` };
  }

  if (!response || !response.ok) {
    let detail = '';
    try {
      detail = ` (${String(errorDetail(await response.json(), '', response?.status)).slice(0, 200)})`;
    } catch {
      detail = '';
    }
    return { ok: false, error: `adsense request failed with HTTP ${response?.status}${detail}` };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: 'adsense response was not valid JSON' };
  }

  return { ok: true, report: payload ?? {} };
}

/**
 * Fetch the AdSense source for `accountId`.
 *
 * @param {object} config
 * @param {string} config.accountId  required — `pub-…` (with/without prefix)
 * @returns {Promise<{ok:boolean, fetchedAt:string, period:object,
 *                    sections:{summary:object, daily:object}}>}
 */
export async function fetchAdSense(
  config,
  { fetchImpl, now = () => new Date(), days = DEFAULT_LOOKBACK_DAYS, tokenFn } = {},
) {
  if (!config?.accountId) {
    throw new Error('adsense: missing required config field(s): accountId');
  }

  const doFetch = fetchImpl ?? globalThis.fetch;
  const accountId = normalizeAccountId(config.accountId);
  const stamp = now() ?? new Date();
  const period = periodFor(days, stamp);

  const getToken = tokenFn ?? ((scope, options) => getAccessToken(scope, options));

  const sections = {};
  let token;
  try {
    token = await getToken(SCOPE, { fetchImpl: doFetch, now: stamp.getTime?.() });
  } catch (error) {
    const failure = { ok: false, error: error.message || String(error) };
    sections.summary = failure;
    sections.daily = failure;
    return { ok: false, fetchedAt: stamp.toISOString(), period, sections };
  }

  const reportResult = await getReport({ accountId, token, period, fetchImpl: doFetch });

  if (!reportResult.ok) {
    // Both sections derive from the one report; a fetch failure fails both.
    sections.summary = { ok: false, error: reportResult.error };
    sections.daily = { ok: false, error: reportResult.error };
    return { ok: false, fetchedAt: stamp.toISOString(), period, sections };
  }

  const shaped = shapeReport(reportResult.report, { days });
  sections.summary = {
    ok: true,
    currency: shaped.currency,
    ...shaped.summary,
  };
  sections.daily = { ok: true, currency: shaped.currency, rows: shaped.daily };

  // The whole source is ok if any section succeeded.
  const ok = Boolean(sections.summary?.ok || sections.daily?.ok);

  return { ok, fetchedAt: stamp.toISOString(), period, sections };
}

/**
 * Adapt a loaded app config into the flat shape the fetcher expects. The
 * account id is read from the environment first, then the mounted config.
 */
export function adsenseConfigFromApp(appConfig, env = process.env) {
  return {
    accountId:
      env.ADSENSE_ACCOUNT_ID ?? appConfig?.sources?.adsense?.config?.accountId ?? null,
  };
}