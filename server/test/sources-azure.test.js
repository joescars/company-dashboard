import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  billingWindow,
  clearTokenCache,
  fetchAzure,
  getAccessToken,
  normalizeUsageDate,
  parseRetryAfter,
} from '../src/sources/azure.js';

/**
 * Azure source tests.
 *
 * globalThis.fetch is stubbed for every case and restored afterwards; no test
 * ever touches the network. Credential values are obvious fakes.
 */

const FAKE = {
  tenantId: 'tenant-fake-0000',
  clientId: 'client-fake-0000',
  clientSecret: 'secret-fake-0000',
  subscriptionId: 'sub-fake-0000',
  resourceIds: ['/subscriptions/sub-fake-0000/resourceGroups/rg/providers/Microsoft.Web/sites/app-1'],
  billingLagHours: 24,
};

const TOKEN_BODY = { access_token: 'arm-token-fake', expires_in: 3600, token_type: 'Bearer' };

/** Capture a JSON Response without a real network. */
function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const lowered = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lowered[String(name).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Install a scripted fetch; returns the recorder and a restore fn. */
function stubFetch(script) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const matcher = script.find((entry) => entry.match(String(url), init, calls.length));
    if (!matcher) throw new Error(`unexpected fetch to ${url}`);
    const response = typeof matcher.response === 'function'
      ? matcher.response(String(url), init, calls.length)
      : matcher.response;
    return response;
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const COST_BODY = {
  properties: {
    columns: [
      { name: 'PreTaxCost', type: 'Number' },
      { name: 'UsageDate', type: 'Number' },
      { name: 'Currency', type: 'String' },
    ],
    rows: [
      [1.25, 20261101, 'USD'],
      [2.5, 20261102, 'USD'],
    ],
  },
};

const METRICS_BODY = {
  value: [
    {
      name: { value: 'Requests' },
      unit: 'Count',
      timeseries: [{ data: [{ total: 10 }, { total: 5 }] }],
    },
    {
      name: { value: 'ResponseTime' },
      unit: 'Milliseconds',
      timeseries: [{ data: [{ average: 100 }, { average: 300 }] }],
    },
  ],
};

test.beforeEach(() => clearTokenCache());

test('parseRetryAfter understands seconds and HTTP-dates', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(''), null);

  const future = new Date(Date.now() + 5000).toUTCString();
  const parsed = parseRetryAfter(future);
  assert.ok(parsed !== null && parsed >= 0 && parsed <= 5000, 'date is converted to ms delay');
});

test('normalizeUsageDate converts the YYYYMMDD integer to an ISO date', () => {
  assert.equal(normalizeUsageDate(20261101), '2026-11-01');
  assert.equal(normalizeUsageDate('20261115'), '2026-11-15');
  assert.equal(normalizeUsageDate(null), null);
});

test('the access token is cached and reused until expiry', async () => {
  let tokenRequests = 0;
  const stub = stubFetch([
    {
      match: (url) => url.includes('/oauth2/v2.0/token'),
      response: () => {
        tokenRequests += 1;
        return jsonResponse(TOKEN_BODY);
      },
    },
  ]);

  try {
    const first = await getAccessToken(FAKE, { now: () => 1_000_000 });
    const second = await getAccessToken(FAKE, { now: () => 1_000_500 });
    assert.equal(first, 'arm-token-fake');
    assert.equal(second, 'arm-token-fake');
    assert.equal(tokenRequests, 1, 'the second call reuses the cached token');

    // Past the cache window (skew is 60s), a fresh token is requested.
    const now = () => 1_000_000 + 3_600_000;
    await getAccessToken(FAKE, { now });
    assert.equal(tokenRequests, 2, 'an expired token triggers re-authentication');
  } finally {
    stub.restore();
  }
});

test('a 429 is retried, honoring Retry-After, then succeeds', async () => {
  const delays = [];
  let attempts = 0;
  const stub = stubFetch([
    {
      match: (url) => url.includes('/oauth2/v2.0/token'),
      response: () => jsonResponse(TOKEN_BODY),
    },
    {
      match: (url) => url.includes('CostManagement/query'),
      response: () => {
        attempts += 1;
        if (attempts === 1) return jsonResponse({ error: { message: 'throttled' } }, { status: 429, headers: { 'retry-after': '3' } });
        return jsonResponse(COST_BODY);
      },
    },
    { match: () => true, response: () => jsonResponse(METRICS_BODY) },
  ]);

  try {
    const result = await fetchAzure(FAKE, { sleepFn: async (ms) => delays.push(ms) });
    assert.equal(result.ok, true, 'the source survives a transient 429');
    assert.equal(attempts, 2, 'cost was requested twice');
    assert.deepEqual(delays, [3000], 'Retry-After seconds became the sleep delay');
    assert.equal(result.sections.cost.ok, true);
    assert.equal(result.sections.cost.total, 3.75);
    assert.deepEqual(result.sections.cost.daily[0], { date: '2026-11-01', cost: 1.25, currency: 'USD' });
  } finally {
    stub.restore();
  }
});

test('a persistent 429 falls back to exponential backoff and reports the failure', async () => {
  const delays = [];
  const stub = stubFetch([
    { match: (url) => url.includes('/oauth2/v2.0/token'), response: () => jsonResponse(TOKEN_BODY) },
    {
      match: (url) => url.includes('CostManagement/query'),
      response: () => jsonResponse({ error: { message: 'throttled' } }, { status: 429 }), // no Retry-After
    },
    { match: () => true, response: () => jsonResponse(METRICS_BODY) },
  ]);

  try {
    const result = await fetchAzure(FAKE, { sleepFn: async (ms) => delays.push(ms) });
    assert.ok(delays.length >= 1, 'backoff was applied at least once');
    assert.ok(
      delays.every((ms, i) => i === 0 || ms >= delays[i - 1]),
      'delays grow monotonically with exponential backoff',
    );
    assert.equal(result.sections.cost.ok, false);
    assert.match(result.sections.cost.error, /HTTP 429/);
    assert.equal(result.ok, true, 'metrics still succeeded, so the source is partially ok');
  } finally {
    stub.restore();
  }
});

test('a partial failure returns ok sections alongside a failed one', async () => {
  const stub = stubFetch([
    { match: (url) => url.includes('/oauth2/v2.0/token'), response: () => jsonResponse(TOKEN_BODY) },
    {
      match: (url) => url.includes('CostManagement/query'),
      response: () => jsonResponse({ error: { message: 'forbidden' } }, { status: 403 }),
    },
    { match: () => true, response: () => jsonResponse(METRICS_BODY) },
  ]);

  try {
    const result = await fetchAzure(FAKE, { sleepFn: async () => {} });
    assert.equal(result.ok, true, 'at least one section succeeded');
    assert.equal(result.sections.cost.ok, false);
    assert.match(result.sections.cost.error, /HTTP 403/);
    assert.equal(result.sections.metrics.ok, true);
    assert.equal(result.sections.metrics.resources[0].ok, true);
    assert.equal(result.errors.cost, result.sections.cost.error);
  } finally {
    stub.restore();
  }
});

test('a token failure degrades every section without throwing', async () => {
  const stub = stubFetch([
    {
      match: (url) => url.includes('/oauth2/v2.0/token'),
      response: () => jsonResponse({ error: 'invalid_client', error_description: 'bad secret' }, { status: 401 }),
    },
  ]);

  try {
    const result = await fetchAzure(FAKE, { sleepFn: async () => {} });
    assert.equal(result.ok, false);
    assert.equal(result.sections.cost.ok, false);
    assert.equal(result.sections.metrics.ok, false);
    assert.match(result.errors.auth, /token request rejected/);
  } finally {
    stub.restore();
  }
});

test('missing credentials throw a configuration error', async () => {
  await assert.rejects(
    () => fetchAzure({ ...FAKE, tenantId: null }, { fetchImpl: async () => jsonResponse({}) }),
    /missing required config field/,
  );
});

test('the payload carries a billing lag label and a dataThrough timestamp', async () => {
  const stub = stubFetch([
    { match: (url) => url.includes('/oauth2/v2.0/token'), response: () => jsonResponse(TOKEN_BODY) },
    { match: (url) => url.includes('CostManagement/query'), response: () => jsonResponse(COST_BODY) },
    { match: () => true, response: () => jsonResponse(METRICS_BODY) },
  ]);

  try {
    const fixed = new Date('2026-11-10T12:00:00.000Z');
    const result = await fetchAzure(FAKE, { sleepFn: async () => {}, clock: () => fixed });
    assert.equal(result.billingLagHours, 24);
    assert.equal(result.dataThrough, '2026-11-09T12:00:00.000Z', 'dataThrough is now minus the lag');
  } finally {
    stub.restore();
  }
});

test('billingWindow defaults the lag when unset', () => {
  const now = new Date('2026-11-10T00:00:00.000Z');
  const window = billingWindow({}, { now });
  assert.equal(window.billingLagHours, 24);
  assert.equal(window.dataThrough, '2026-11-09T00:00:00.000Z');
});