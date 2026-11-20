/**
 * OpenRouter source: per-key usage, account credits and 30-day activity.
 *
 * Three sections, each independently optional:
 *   - key usage:   GET https://openrouter.ai/api/v1/key      (API key)
 *   - credits:     GET https://openrouter.ai/api/v1/credits  (management key)
 *   - activity:    GET https://openrouter.ai/api/v1/activity (management key,
 *                                                             last 30 UTC days)
 *
 * The API key is the only hard requirement; it is enough for the key-usage
 * section. A management key — a strictly stronger credential — unlocks the
 * account-wide credits balance and the 30-day activity rollup. When the
 * management key is absent those two sections are simply marked unavailable
 * rather than failing the source: the dashboard should still show key usage.
 *
 * Nothing here throws for an upstream error. Each section carries its own
 * `ok`/`error` so a partial outage renders what it can.
 */

const API_BASE = 'https://openrouter.ai/api/v1';

/** Section availability reasons, surfaced verbatim in the payload. */
const REASON_NO_MANAGEMENT_KEY = 'management key not configured';

/**
 * Fetch one OpenRouter endpoint and normalize the result into a section
 * envelope. Returns `{ ok: true, ...data }` or `{ ok: false, error }`.
 */
async function getSection(section, path, { apiKey, fetchImpl, sleepFn, unavailableReason } = {}) {
  if (unavailableReason) return { ok: false, unavailable: true, error: unavailableReason };

  let response;
  try {
    response = await fetchImpl(`${API_BASE}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
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

  return { ok: true, data: payload?.data ?? payload ?? null };
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

/** Reduce a `/key` response to the fields the dashboard renders. */
export function shapeKeyUsage(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    label: data.label ?? null,
    usage: num(data.usage),
    usageDaily: num(data.usage_daily),
    usageWeekly: num(data.usage_weekly),
    usageMonthly: num(data.usage_monthly),
    limit: num(data.limit),
    limitRemaining: num(data.limit_remaining),
    limitReset: data.limit_reset ?? null,
    isFreeTier: Boolean(data.is_free_tier),
    isManagementKey: Boolean(data.is_management_key),
  };
}

/** Reduce a `/credits` response to purchased/used/remaining. */
export function shapeCredits(data) {
  if (!data || typeof data !== 'object') return null;
  const total = num(data.total_credits);
  const used = num(data.total_usage);
  const remaining = Number.isFinite(total) && Number.isFinite(used) ? round(total - used) : null;
  return { totalCredits: total, totalUsage: used, remaining };
}

/**
 * Roll a `/activity` response (one row per date/model/endpoint) into a
 * 30-day summary plus a per-day usage series.
 */
export function shapeActivity(data, { days = 30 } = {}) {
  const rows = Array.isArray(data) ? data : [];
  let usage = 0;
  let requests = 0;
  const byDay = new Map();
  const byModel = new Map();

  for (const row of rows) {
    const rowUsage = num(row?.usage) ?? 0;
    const rowRequests = num(row?.requests) ?? 0;
    usage += rowUsage;
    requests += rowRequests;

    const date = row?.date ?? null;
    if (date) {
      const day = byDay.get(date) ?? { date, usage: 0, requests: 0 };
      day.usage = round(day.usage + rowUsage);
      day.requests += rowRequests;
      byDay.set(date, day);
    }

    const model = row?.model ?? 'unknown';
    const modelEntry = byModel.get(model) ?? { model, usage: 0, requests: 0 };
    modelEntry.usage = round(modelEntry.usage + rowUsage);
    modelEntry.requests += rowRequests;
    byModel.set(model, modelEntry);
  }

  const daily = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const models = [...byModel.values()].sort((a, b) => b.usage - a.usage);

  return {
    windowDays: days,
    usage: round(usage),
    requests,
    daily,
    models,
  };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;
}

/**
 * Fetch the whole OpenRouter source.
 *
 * @param {object} config
 * @param {string} config.apiKey            required — the per-key credential
 * @param {string} [config.managementKey]   optional — unlocks credits/activity
 * @returns {Promise<{ok:boolean, fetchedAt:string, hasManagementKey:boolean,
 *                    sections:{key:object, credits:object, activity:object}}>}
 */
export async function fetchOpenRouter(
  config,
  { fetchImpl, now = () => new Date(), sleepFn, activityDays = 30 } = {},
) {
  if (!config?.apiKey) throw new Error('openrouter: missing required config field(s): apiKey');

  const doFetch = fetchImpl ?? globalThis.fetch;
  const managementKey = config.managementKey || null;
  const hasManagementKey = Boolean(managementKey);
  const stamp = now() ?? new Date();

  const sections = {};

  const keyResult = await getSection('key', '/key', { apiKey: config.apiKey, fetchImpl: doFetch, sleepFn });
  sections.key = keyResult.ok ? { ok: true, ...shapeKeyUsage(keyResult.data) } : keyResult;

  // Both remaining sections require the management key. Without it they are
  // reported as unavailable — an expected, non-fatal state.
  const creditsResult = await getSection('credits', '/credits', {
    apiKey: managementKey ?? config.apiKey,
    fetchImpl: doFetch,
    sleepFn,
    unavailableReason: hasManagementKey ? undefined : REASON_NO_MANAGEMENT_KEY,
  });
  sections.credits = creditsResult.ok ? { ok: true, ...shapeCredits(creditsResult.data) } : creditsResult;

  const activityResult = await getSection('activity', '/activity', {
    apiKey: managementKey ?? config.apiKey,
    fetchImpl: doFetch,
    sleepFn,
    unavailableReason: hasManagementKey ? undefined : REASON_NO_MANAGEMENT_KEY,
  });
  sections.activity = activityResult.ok
    ? { ok: true, ...shapeActivity(activityResult.data, { days: activityDays }) }
    : activityResult;

  // The source "ok" as long as the credential that is present worked; an
  // unavailable optional section never makes the whole source fail.
  const ok = Boolean(sections.key?.ok || sections.credits?.ok || sections.activity?.ok);

  return {
    ok,
    fetchedAt: stamp.toISOString(),
    hasManagementKey,
    sections,
  };
}

/**
 * Adapt a loaded app config into the flat shape the fetcher expects. Reads
 * credentials from the environment only.
 */
export function openRouterConfigFromApp(_appConfig, env = process.env) {
  return {
    apiKey: env.OPENROUTER_API_KEY ?? null,
    managementKey: env.OPENROUTER_MANAGEMENT_KEY ?? null,
  };
}