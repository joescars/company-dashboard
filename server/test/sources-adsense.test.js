import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { resetGoogleCredentials } from '../src/lib/google.js';
import {
  SOURCE_KEY,
  SCOPE,
  adsenseConfigFromApp,
  fetchAdSense,
  normalizeAccountId,
  paymentDateFor,
  periodFor,
  shapeReport,
} from '../src/sources/adsense.js';

/**
 * AdSense source tests — pure module level.
 *
 * globalThis.fetch is stubbed and restored; nothing hits the network. The
 * service-account key is generated per run (never a checked-in secret). Route
 * wiring is out of scope here (the router is shared and guarded elsewhere).
 */

const ACCOUNT_ID = 'pub-1234567890123456';

// A fake service-account key generated per run — never a checked-in secret.
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'test-key-id',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'test-runner@test-project.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
};

/** A fetch-shaped response: `ok`/`status`/`json()`/`text()`. */
function jsonResponse(body, { status = 200 } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

/** A response whose body is not JSON, to exercise the parse guard. */
function nonJsonResponse({ status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
    text: async () => '<html>not json</html>',
  };
}

/**
 * Stub global.fetch and install the fake credentials. Returns the captured
 * calls and a restore fn. Credential caches are cleared on both ends so no
 * stub token leaks between tests.
 */
function stubFetch(script) {
  const original = globalThis.fetch;
  const savedCreds = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  const calls = [];

  process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 = Buffer.from(
    JSON.stringify(SERVICE_ACCOUNT),
    'utf8',
  ).toString('base64');
  resetGoogleCredentials();

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const matcher = script.find((entry) => entry.match(String(url), init));
    if (!matcher) throw new Error(`unexpected fetch to ${url}`);
    return matcher.response(String(url), init);
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
      if (savedCreds === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
      else process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 = savedCreds;
      resetGoogleCredentials();
    },
  };
}

/** Always answer the OAuth token endpoint first. */
const TOKEN_ENTRY = {
  match: (url) => url.includes('oauth2.googleapis.com'),
  response: () => jsonResponse({ access_token: 'stub-access-token', expires_in: 3600 }),
};

/** A `ReportResult` header set + rows, canonical order (dimension first). */
function reportBody({ headersOrder = 'canonical' } = {}) {
  const canonical = [
    { name: 'DATE', type: 'DIMENSION' },
    { name: 'ESTIMATED_EARNINGS', type: 'METRIC_CURRENCY', currencyCode: 'USD' },
    { name: 'PAGE_VIEWS', type: 'METRIC_TALLY' },
    { name: 'IMPRESSIONS', type: 'METRIC_TALLY' },
    { name: 'CLICKS', type: 'METRIC_TALLY' },
    { name: 'PAGE_VIEWS_RPM', type: 'METRIC_CURRENCY', currencyCode: 'USD' },
  ];

  const values = {
    DATE: null,
    ESTIMATED_EARNINGS: null,
    PAGE_VIEWS: null,
    IMPRESSIONS: null,
    CLICKS: null,
    PAGE_VIEWS_RPM: null,
  };

  const dayRows = [
    { DATE: '2026-11-02', ESTIMATED_EARNINGS: '2500000', PAGE_VIEWS: '1500', IMPRESSIONS: '4000', CLICKS: '75', PAGE_VIEWS_RPM: '1666666' },
    { DATE: '2026-11-01', ESTIMATED_EARNINGS: '1000000', PAGE_VIEWS: '1000', IMPRESSIONS: '3000', CLICKS: '50', PAGE_VIEWS_RPM: '1000000' },
  ];

  const headers = headersOrder === 'canonical' ? canonical : [...canonical].reverse();
  const rows = dayRows.map((day) => ({
    cells: headers.map((h) => ({ value: String(day[h.name] ?? values[h.name] ?? '') })),
  }));

  return { headers, rows };
}

test('SOURCE_KEY and SCOPE are the AdSense readonly pair', () => {
  assert.equal(SOURCE_KEY, 'adsense');
  assert.equal(SCOPE, 'https://www.googleapis.com/auth/adsense.readonly');
});

test('happy path: report maps by header name, micros converted, daily sorted', async () => {
  const stub = stubFetch([
    TOKEN_ENTRY,
    { match: (url) => url.includes('/reports:generate'), response: () => jsonResponse(reportBody()) },
  ]);

  try {
    const result = await fetchAdSense({ accountId: ACCOUNT_ID }, { fetchImpl: globalThis.fetch });

    assert.equal(result.ok, true);
    assert.ok(result.fetchedAt, 'a fetch timestamp is recorded');
    assert.equal(typeof result.period.startDate, 'string');
    assert.equal(typeof result.period.endDate, 'string');

    // Summary totals: earnings in currency units, not micros.
    assert.equal(result.sections.summary.ok, true);
    assert.equal(result.sections.summary.currency, 'USD');
    assert.equal(result.sections.summary.estimatedEarnings, 3.5, '2500000 + 1000000 micros -> 3.5');
    assert.equal(result.sections.summary.pageViews, 2500);
    assert.equal(result.sections.summary.impressions, 7000);
    assert.equal(result.sections.summary.clicks, 125);

    // Daily is ascending by date and each row carries currency-unit earnings.
    assert.equal(result.sections.daily.ok, true);
    assert.equal(result.sections.daily.rows.length, 2);
    assert.deepEqual(
      result.sections.daily.rows.map((row) => row.date),
      ['2026-11-01', '2026-11-02'],
    );
    assert.equal(result.sections.daily.rows[0].estimatedEarnings, 1);
    assert.equal(result.sections.daily.rows[1].estimatedEarnings, 2.5);

    // The account id is embedded without the accounts/ prefix and the bearer
    // token is sent.
    const reportCall = stub.calls.find((c) => c.url.includes('/reports:generate'));
    assert.ok(reportCall.url.includes(`/accounts/${ACCOUNT_ID}/reports:generate`));
    assert.equal(reportCall.init.headers.authorization, 'Bearer stub-access-token');
    assert.ok(reportCall.url.includes('dimensions=DATE'));
    assert.ok(reportCall.url.includes('metrics=ESTIMATED_EARNINGS'));
  } finally {
    stub.restore();
  }
});

test('rows are mapped BY HEADER NAME even when the header order is shuffled', async () => {
  const stub = stubFetch([
    TOKEN_ENTRY,
    {
      match: (url) => url.includes('/reports:generate'),
      response: () => jsonResponse(reportBody({ headersOrder: 'reversed' })),
    },
  ]);

  try {
    const result = await fetchAdSense({ accountId: ACCOUNT_ID }, { fetchImpl: globalThis.fetch });

    assert.equal(result.sections.summary.ok, true);
    // Same numbers land on the same fields despite the reversed column order.
    assert.equal(result.sections.summary.pageViews, 2500);
    assert.equal(result.sections.summary.impressions, 7000);
    assert.equal(result.sections.summary.clicks, 125);
    assert.equal(result.sections.summary.estimatedEarnings, 3.5);

    const day = result.sections.daily.rows.find((row) => row.date === '2026-11-02');
    assert.equal(day.pageViews, 1500);
    assert.equal(day.impressions, 4000);
    assert.equal(day.clicks, 75);
    assert.equal(day.estimatedEarnings, 2.5);
  } finally {
    stub.restore();
  }
});

test('an empty rows array is a legitimate empty result with zeros', async () => {
  const stub = stubFetch([
    TOKEN_ENTRY,
    {
      match: (url) => url.includes('/reports:generate'),
      response: () => jsonResponse({ headers: reportBody().headers, rows: [] }),
    },
  ]);

  try {
    const result = await fetchAdSense({ accountId: ACCOUNT_ID }, { fetchImpl: globalThis.fetch });

    assert.equal(result.ok, true, 'no rows is not an error');
    assert.equal(result.sections.summary.ok, true);
    assert.equal(result.sections.summary.estimatedEarnings, 0);
    assert.equal(result.sections.summary.pageViews, 0);
    assert.equal(result.sections.summary.impressions, 0);
    assert.equal(result.sections.summary.clicks, 0);
    assert.equal(result.sections.daily.ok, true);
    assert.deepEqual(result.sections.daily.rows, []);
  } finally {
    stub.restore();
  }
});

test('a missing rows key is treated the same as an empty result', async () => {
  const stub = stubFetch([
    TOKEN_ENTRY,
    { match: (url) => url.includes('/reports:generate'), response: () => jsonResponse({ headers: [] }) },
  ]);

  try {
    const result = await fetchAdSense({ accountId: ACCOUNT_ID }, { fetchImpl: globalThis.fetch });
    assert.equal(result.ok, true);
    assert.equal(result.sections.summary.pageViews, 0);
    assert.deepEqual(result.sections.daily.rows, []);
  } finally {
    stub.restore();
  }
});

test('an HTTP 500 fails with the status in the message', async () => {
  const stub = stubFetch([
    TOKEN_ENTRY,
    {
      match: (url) => url.includes('/reports:generate'),
      response: () => jsonResponse({ error: { message: 'backend error' } }, { status: 500 }),
    },
  ]);

  try {
    const result = await fetchAdSense({ accountId: ACCOUNT_ID }, { fetchImpl: globalThis.fetch });
    assert.equal(result.ok, false);
    assert.equal(result.sections.summary.ok, false);
    assert.equal(result.sections.daily.ok, false);
    assert.match(result.sections.summary.error, /HTTP 500/);
    assert.match(result.sections.summary.error, /backend error/);
  } finally {
    stub.restore();
  }
});

test('a non-JSON body fails with a "not valid JSON" error', async () => {
  const stub = stubFetch([
    TOKEN_ENTRY,
    { match: (url) => url.includes('/reports:generate'), response: () => nonJsonResponse() },
  ]);

  try {
    const result = await fetchAdSense({ accountId: ACCOUNT_ID }, { fetchImpl: globalThis.fetch });
    assert.equal(result.ok, false);
    assert.match(result.sections.summary.error, /not valid JSON/);
  } finally {
    stub.restore();
  }
});

test('a thrown network error is returned, not raised', async () => {
  const stub = stubFetch([
    TOKEN_ENTRY,
    {
      match: (url) => url.includes('/reports:generate'),
      response: () => {
        throw new Error('socket hang up');
      },
    },
  ]);

  try {
    const result = await fetchAdSense({ accountId: ACCOUNT_ID }, { fetchImpl: globalThis.fetch });
    assert.equal(result.ok, false);
    assert.match(result.sections.summary.error, /socket hang up/);
  } finally {
    stub.restore();
  }
});

test('fetchAdSense throws only when accountId is missing', async () => {
  await assert.rejects(
    () => fetchAdSense({}, { fetchImpl: async () => jsonResponse({}) }),
    /adsense: missing required config field\(s\): accountId/,
  );
  await assert.rejects(() => fetchAdSense(undefined, { fetchImpl: async () => jsonResponse({}) }));
});

test('an accounts/ prefix on the account id is stripped', async () => {
  const stub = stubFetch([
    TOKEN_ENTRY,
    { match: (url) => url.includes('/reports:generate'), response: () => jsonResponse(reportBody()) },
  ]);

  try {
    await fetchAdSense(
      { accountId: `accounts/${ACCOUNT_ID}` },
      { fetchImpl: globalThis.fetch },
    );
    const reportCall = stub.calls.find((c) => c.url.includes('/reports:generate'));
    assert.ok(
      reportCall.url.includes(`/accounts/${ACCOUNT_ID}/reports:generate`),
      'no doubled accounts/ prefix in the path',
    );
    assert.ok(!reportCall.url.includes('accounts/accounts/'));
  } finally {
    stub.restore();
  }
});

test('normalizeAccountId strips a leading accounts/ prefix only', () => {
  assert.equal(normalizeAccountId(ACCOUNT_ID), ACCOUNT_ID);
  assert.equal(normalizeAccountId(`accounts/${ACCOUNT_ID}`), ACCOUNT_ID);
  assert.equal(normalizeAccountId('  accounts/pub-999  '), 'pub-999');
  assert.equal(normalizeAccountId(''), '');
  assert.equal(normalizeAccountId(null), '');
});

test('shapeReport normalizes rows, converts micros and sorts ascending', () => {
  const shaped = shapeReport({
    headers: [
      { name: 'DATE', type: 'DIMENSION' },
      { name: 'ESTIMATED_EARNINGS', type: 'METRIC_CURRENCY', currencyCode: 'EUR' },
      { name: 'PAGE_VIEWS', type: 'METRIC_TALLY' },
    ],
    rows: [
      { cells: [{ value: '2026-11-03' }, { value: '500000' }, { value: '10' }] },
      { cells: [{ value: '2026-11-01' }, { value: '1000000' }, { value: '5' }] },
    ],
  });

  assert.equal(shaped.currency, 'EUR');
  assert.deepEqual(
    shaped.daily.map((row) => row.date),
    ['2026-11-01', '2026-11-03'],
  );
  assert.equal(shaped.daily[0].estimatedEarnings, 1);
  assert.equal(shaped.summary.estimatedEarnings, 1.5);
  assert.equal(shaped.summary.pageViews, 15);
  // RPM recomputed from the summed totals: 1.5 / 15 * 1000.
  assert.equal(shaped.summary.rpm, 100);
});

test('shapeReport tolerates a bare-array row shape and missing headers', () => {
  const shaped = shapeReport({
    headers: [{ name: 'ESTIMATED_EARNINGS', type: 'METRIC_CURRENCY', currencyCode: 'USD' }],
    rows: [['2000000']],
  });
  assert.equal(shaped.daily.length, 1);
  assert.equal(shaped.daily[0].date, null, 'a row with no DATE header has a null date');
  assert.equal(shaped.daily[0].estimatedEarnings, 2);

  const empty = shapeReport(null);
  assert.deepEqual(empty.daily, []);
  assert.equal(empty.summary.estimatedEarnings, 0);
  assert.equal(empty.currency, null);
});

test('periodFor / paymentDateFor produce an inclusive 30-day ISO window', () => {
  const now = new Date('2026-11-21T15:00:00Z');
  const period = periodFor(30, now);
  assert.match(period.startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(period.endDate, '2026-11-21');
  assert.equal(period.startDate, '2026-10-23', '30 inclusive days back from Nov 21');

  // The alias matches periodFor exactly.
  assert.deepEqual(paymentDateFor(30, now), period);

  const span = (Date.parse(period.endDate) - Date.parse(period.startDate)) / 86400000;
  assert.equal(span, 29, '30 inclusive days spans 29 boundaries');
});

test('adsenseConfigFromApp reads the environment first, then config', () => {
  assert.deepEqual(adsenseConfigFromApp({}, { ADSENSE_ACCOUNT_ID: ACCOUNT_ID }), {
    accountId: ACCOUNT_ID,
  });

  const fromFile = { sources: { adsense: { config: { accountId: 'pub-from-file' } } } };
  assert.deepEqual(adsenseConfigFromApp(fromFile, {}), { accountId: 'pub-from-file' });

  // The environment wins over the mounted config.
  assert.deepEqual(adsenseConfigFromApp(fromFile, { ADSENSE_ACCOUNT_ID: ACCOUNT_ID }), {
    accountId: ACCOUNT_ID,
  });

  assert.deepEqual(adsenseConfigFromApp(undefined, {}), { accountId: null });
});