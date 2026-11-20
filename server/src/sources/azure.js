/**
 * Azure source: subscription cost and per-resource telemetry.
 *
 * Authentication uses a service principal with the OAuth2 client-credentials
 * grant against Microsoft Entra ID (login.microsoftonline.com). The access
 * token is cached in-memory until shortly before it expires so a page refresh
 * or a scheduled poll does not re-authenticate on every request.
 *
 * Two independent sections are fetched, each with its own success/failure
 * envelope. A partial failure (one section down, the other fine) is reported
 * per-section so the dashboard can render whatever succeeded instead of going
 * blank — this module never throws for an upstream error, only for programmer
 * mistakes (a missing tenant, for example).
 *
 * Endpoints:
 *   - Token:      POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
 *   - Cost:       POST https://management.azure.com/subscriptions/{id}/providers/
 *                       Microsoft.CostManagement/query?...api-version=2023-11-01
 *   - Metrics:    GET  https://management.azure.com{resourceId}/providers/
 *                       Microsoft.Insights/metrics?...api-version=2018-01-01
 */

const LOGIN_BASE = 'https://login.microsoftonline.com';
const ARM_BASE = 'https://management.azure.com';
const ARM_SCOPE = 'https://management.azure.com/.default';
const COST_API_VERSION = '2023-11-01';
const METRICS_API_VERSION = '2018-01-01';

/**
 * Cost Management usage data is not real-time: the latest day is typically
 * incomplete and the tail of the window lags behind wall-clock time. We expose
 * this as a labelled lag so the UI can say "data through <date>" rather than
 * implying the number is live.
 */
export const DEFAULT_BILLING_LAG_HOURS = 24;

/** Refresh the cached token this many ms before it actually expires. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

/** Retry policy for HTTP 429 (and 5xx) responses. */
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

/**
 * Process-wide token cache, keyed by tenant + client so a single process
 * serving several deployments (or tests swapping credentials) never reuses a
 * token minted for different credentials.
 */
const tokenCache = new Map();

/** Test seam: forget every cached token. */
export function clearTokenCache() {
  tokenCache.clear();
}

function cacheKey(config) {
  return `${config.tenantId}\u0000${config.clientId}`;
}

/** Milliseconds to sleep, capped so a hostile Retry-After cannot hang a poll. */
function clampDelay(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(ms, MAX_DELAY_MS);
}

/** Parse a Retry-After header: seconds, or an HTTP-date. Null when absent. */
export function parseRetryAfter(header) {
  if (header === null || header === undefined || header === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return clampDelay(Math.round(seconds * 1000));
  const date = Date.parse(header);
  if (Number.isFinite(date)) return clampDelay(Math.max(0, date - Date.now()));
  return null;
}

function sleep(ms, { sleepFn } = {}) {
  if (typeof sleepFn === 'function') return sleepFn(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with bounded retries on 429/5xx, honoring Retry-After when present and
 * falling back to exponential backoff (base * 2^attempt, jittered) otherwise.
 * Returns the final Response regardless of status so the caller decides how to
 * interpret a persistent failure.
 */
export async function fetchWithRetry(
  url,
  { init, fetchImpl, sleepFn, maxRetries = DEFAULT_MAX_RETRIES, baseDelayMs = DEFAULT_BASE_DELAY_MS, onRetry } = {},
) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  let attempt = 0;

  for (;;) {
    let response;
    try {
      response = await doFetch(url, init);
    } catch (error) {
      // A network error is transient. Retry it like a 5xx.
      if (attempt >= maxRetries) throw error;
      const delay = clampDelay(baseDelayMs * 2 ** attempt + jitter(baseDelayMs));
      attempt += 1;
      if (onRetry) onRetry({ attempt, delay, reason: 'network_error' });
      await sleep(delay, { sleepFn });
      continue;
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= maxRetries) return response;

    const retryAfter = parseRetryAfter(response.headers?.get?.('retry-after'));
    const delay = retryAfter ?? clampDelay(baseDelayMs * 2 ** attempt + jitter(baseDelayMs));

    // Drain the body so the socket can be reused before the next attempt.
    try {
      await response.text?.();
    } catch {
      /* ignore */
    }

    attempt += 1;
    if (onRetry) onRetry({ attempt, delay, status: response.status });
    await sleep(delay, { sleepFn });
  }
}

function jitter(base) {
  // Deterministic-free jitter without Math.random leaking into assertions is
  // overkill here; a small bounded pseudo-random spread avoids thundering
  // herds while keeping delays predictable in tests via injected sleepFn.
  return Math.floor(Math.random() * base * 0.25);
}

/** Read a JSON body, never throwing on a malformed payload. */
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Build a short, non-secret upstream error description. */
function httpError(section, response) {
  const status = response?.status ?? 'unknown';
  return `${section} request failed with HTTP ${status}`;
}

/**
 * Acquire (or reuse) an ARM access token for the service principal.
 *
 * Cached until it is within TOKEN_EXPIRY_SKEW_MS of expiry. Throws only when
 * the credentials themselves are missing/invalid — the caller treats that as a
 * configuration error, not a transient upstream failure.
 */
export async function getAccessToken(config, { fetchImpl, now = Date.now, force = false, sleepFn } = {}) {
  const missing = ['tenantId', 'clientId', 'clientSecret'].filter((field) => !config?.[field]);
  if (missing.length) {
    throw new Error(`azure: missing credential field(s): ${missing.join(', ')}`);
  }

  const key = cacheKey(config);
  if (!force) {
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt - TOKEN_EXPIRY_SKEW_MS > now()) return cached.token;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: ARM_SCOPE,
  });

  const url = `${LOGIN_BASE}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;
  const response = await fetchWithRetry(url, {
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    fetchImpl,
    sleepFn,
  });

  if (!response || !response.ok) {
    const payload = await readJson(response);
    const detail = payload?.error_description || payload?.error || `HTTP ${response?.status}`;
    throw new Error(`azure: token request rejected (${detail})`);
  }

  const payload = await readJson(response);
  if (!payload?.access_token) throw new Error('azure: token response had no access_token');

  // expires_in is seconds; default to 1h when the field is absent.
  const expiresInMs = Number(payload.expires_in) > 0 ? Number(payload.expires_in) * 1000 : 3_600_000;
  tokenCache.set(key, { token: payload.access_token, expiresAt: now() + expiresInMs });

  return payload.access_token;
}

/**
 * Cost Management query: actual pre-tax cost, per day, month-to-date.
 *
 * The response uses the "rows + columns" shape from the Query API, so the
 * mapping is done by column name rather than fixed index (the column order
 * depends on the aggregation/dimension requested).
 */
export async function fetchCost(config, { token, fetchImpl, sleepFn } = {}) {
  const url = `${ARM_BASE}/subscriptions/${encodeURIComponent(config.subscriptionId)}` +
    `/providers/Microsoft.CostManagement/query?api-version=${COST_API_VERSION}`;

  const body = {
    type: 'ActualCost',
    timeframe: 'MonthToDate',
    dataset: {
      granularity: 'Daily',
      aggregation: {
        totalCost: { name: 'PreTaxCost', function: 'Sum' },
      },
    },
  };

  const response = await fetchWithRetry(url, {
    init: {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
    sleepFn,
  });

  if (!response || !response.ok) throw new Error(httpError('cost', response));

  const payload = await readJson(response);
  const columns = (payload?.properties?.columns ?? []).map((column) => column.name);
  const rows = payload?.properties?.rows ?? [];

  const costIndex = columns.indexOf('PreTaxCost');
  const dateIndex = columns.indexOf('UsageDate');
  const currencyIndex = columns.indexOf('Currency');

  let total = 0;
  const daily = [];

  for (const row of rows) {
    const cost = costIndex >= 0 ? Number(row[costIndex]) : Number(row[row.length - 1]);
    if (Number.isFinite(cost)) total += cost;

    const usageDate = dateIndex >= 0 ? row[dateIndex] : undefined;
    daily.push({
      date: normalizeUsageDate(usageDate),
      cost: Number.isFinite(cost) ? cost : null,
      currency: currencyIndex >= 0 ? row[currencyIndex] : null,
    });
  }

  return {
    currency: currencyIndex >= 0 ? rows[0]?.[currencyIndex] ?? null : null,
    total: round(total),
    daily,
    granularity: 'Daily',
    timeframe: 'MonthToDate',
  };
}

/**
 * Cost Management returns UsageDate as a YYYYMMDD integer. Convert to an ISO
 * date string, leaving anything already formatted untouched.
 */
export function normalizeUsageDate(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  return text;
}

/** Whole-percent rounding for money so JSON stays readable. */
function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;
}

/**
 * Azure Monitor metrics for one resource: requests and average response time.
 *
 * Metrics that do not exist on a resource (a storage account has no
 * Requests metric) simply come back empty; that is not an error for the whole
 * section. The names are requested together and missing ones are omitted.
 */
export async function fetchMetrics(config, { token, fetchImpl, sleepFn } = {}) {
  const metricNames = ['Requests', 'ResponseTime'];
  const resources = [];

  for (const resourceId of config.resourceIds ?? []) {
    const url = `${ARM_BASE}${resourceId}/providers/Microsoft.Insights/metrics` +
      `?api-version=${METRICS_API_VERSION}` +
      `&metricnames=${encodeURIComponent(metricNames.join(','))}` +
      `&aggregation=average,total,count` +
      `&interval=PT1H&timespan=PT24H`;

    const response = await fetchWithRetry(url, {
      init: { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      fetchImpl,
      sleepFn,
    });

    if (!response || !response.ok) {
      resources.push({ resourceId, ok: false, error: httpError('metrics', response), metrics: [] });
      continue;
    }

    const payload = await readJson(response);
    resources.push({
      resourceId,
      ok: true,
      metrics: (payload?.value ?? []).map(shapeMetric).filter(Boolean),
    });
  }

  return { resources };
}

/** Reduce one Azure Monitor metric to the summary the tile needs. */
function shapeMetric(metric) {
  if (!metric?.name?.value) return null;
  const series = (metric.timeseries ?? []).flatMap((entry) => entry.data ?? []);

  const sums = { total: 0, count: 0, average: 0 };
  let averageSamples = 0;

  for (const point of series) {
    if (Number.isFinite(Number(point.total))) sums.total += Number(point.total);
    if (Number.isFinite(Number(point.count))) sums.count += Number(point.count);
    if (Number.isFinite(Number(point.average))) {
      sums.average += Number(point.average);
      averageSamples += 1;
    }
  }

  return {
    name: metric.name.value,
    unit: metric.unit ?? null,
    timeseries: series.length,
    total: metric.name.value === 'Requests' ? sums.total : null,
    average: averageSamples > 0 ? round(sums.average / averageSamples) : null,
  };
}

/**
 * Compute the cost-data lag label. Azure does not return a "data through"
 * timestamp, so we derive it from the query window: month-to-date data is
 * considered complete up to now minus the billing lag.
 */
export function billingWindow(config = {}, { now = new Date() } = {}) {
  const lagHours = Number.isFinite(Number(config.billingLagHours))
    ? Number(config.billingLagHours)
    : DEFAULT_BILLING_LAG_HOURS;
  const dataThrough = new Date(now.getTime() - lagHours * 3_600_000);
  return { billingLagHours: lagHours, dataThrough: dataThrough.toISOString() };
}

/**
 * Fetch the whole Azure source.
 *
 * Never throws for an upstream/HTTP error: each section carries its own
 * `ok`/`error`. Returns `{ ok, fetchedAt, sections }` where `ok` is true when
 * at least one section succeeded, so the route can decide whether to persist a
 * snapshot. A missing configuration throws instead (programmer/deploy error).
 */
export async function fetchAzure(config, { fetchImpl, now = Date.now, sleepFn, clock } = {}) {
  const missing = ['tenantId', 'clientId', 'clientSecret', 'subscriptionId'].filter(
    (field) => !config?.[field],
  );
  if (missing.length) {
    throw new Error(`azure: missing required config field(s): ${missing.join(', ')}`);
  }

  const sections = { cost: null, metrics: null };
  const errors = {};

  let token;
  try {
    token = await getAccessToken(config, { fetchImpl, now, sleepFn });
  } catch (error) {
    const message = error.message;
    errors.auth = message;
    sections.cost = { ok: false, error: message };
    sections.metrics = { ok: false, error: message };
    return { ok: false, fetchedAt: new Date(now()).toISOString(), sections, errors };
  }

  try {
    sections.cost = { ok: true, ...(await fetchCost(config, { token, fetchImpl, sleepFn })) };
  } catch (error) {
    sections.cost = { ok: false, error: error.message };
    errors.cost = error.message;
  }

  try {
    const metrics = await fetchMetrics(config, { token, fetchImpl, sleepFn });
    // Metrics section is "ok" when at least one resource succeeded; per-resource
    // errors are still carried inside.
    const anyOk = metrics.resources.some((entry) => entry.ok);
    sections.metrics = {
      ok: metrics.resources.length === 0 ? false : anyOk,
      ...metrics,
    };
    if (!anyOk && metrics.resources.length > 0) {
      errors.metrics = 'all resource metric queries failed';
    }
  } catch (error) {
    sections.metrics = { ok: false, error: error.message, resources: [] };
    errors.metrics = error.message;
  }

  const ok = Boolean(sections.cost?.ok || sections.metrics?.ok);
  const stamp = clock ? clock() : new Date(now());
  const window = billingWindow(config, { now: stamp });

  return {
    ok,
    fetchedAt: stamp.toISOString(),
    billingLagHours: window.billingLagHours,
    dataThrough: window.dataThrough,
    sections,
    errors: Object.keys(errors).length ? errors : null,
  };
}

/**
 * Adapt a loaded app config into the flat shape the fetchers expect. Reads
 * credentials from the environment only — never from a payload or the client.
 */
export function azureConfigFromApp(appConfig, env = process.env) {
  const config = appConfig?.sources?.azure?.config ?? {};
  return {
    tenantId: env.AZURE_TENANT_ID ?? null,
    clientId: env.AZURE_CLIENT_ID ?? null,
    clientSecret: env.AZURE_CLIENT_SECRET ?? null,
    subscriptionId: config.subscriptionId ?? env.AZURE_SUBSCRIPTION_ID ?? null,
    resourceIds: Array.isArray(config.resourceIds) ? config.resourceIds : [],
    billingDayOfMonth: config.billingDayOfMonth ?? 1,
  };
}