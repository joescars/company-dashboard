import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  fetchGa4,
  ga4ConfigFromApp,
  isNumericPropertyId,
  normalizePropertyId,
  SCOPE,
  shapeTopPages,
  shapeTotals,
  SOURCE_KEY,
} from '../src/sources/ga4.js';
import { resetGoogleCredentials } from '../src/lib/google.js';

/**
 * GA4 source tests — pure fetcher level.
 *
 * globalThis.fetch is stubbed and restored; nothing hits the network. The
 * service-account credential helper needs a well-formed key (to sign the JWT
 * assertion) even though the token exchange itself is answered by the stub, so
 * a throwaway RSA key is generated per run — never a checked-in secret.
 */

// A fake service-account key generated per run.
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'test-key-id',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'test-runner@test-project.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
};
process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 = Buffer.from(
  JSON.stringify(SERVICE_ACCOUNT),
  'utf8',
).toString('base64');
resetGoogleCredentials();

const FAKE_TOKEN = '«redacted:ya29.…»';
const PROPERTY_ID = '123456789';

function jsonResponse(body, { status = 200 } = {}) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => text,
  };
}

/** A token-endpoint response so getAccessToken succeeds without credentials. */
function tokenResponse() {
  return jsonResponse({ access_token: FAKE_TOKEN, expires_in: 3600 });
}

const TOKEN_MATCH = { match: (url) => url.includes('oauth2.googleapis.com'), response: () => tokenResponse() };

/**
 * Replace globalThis.fetch with a scripted matcher. The matcher list is
 * consulted in order; the token exchange is appended automatically so callers
 * only describe the report calls they care about.
 */
function stubFetch(script) {
  const original = globalThis.fetch;
  const calls = [];
  const matchers = [
    TOKEN_MATCH,
    ...script.map((entry) => ({
      match: entry.match,
      response: typeof entry.response === 'function' ? entry.response : () => entry.response,
    })),
  ];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const matcher = matchers.find((entry) => entry.match(String(url), init));
    if (!matcher) throw new Error(`unexpected fetch to ${url}`);
    return matcher.response(String(url), init);
  };
  resetGoogleCredentials();
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
      resetGoogleCredentials();
    },
  };
}

/** Distinguish the totals report from the top-pages report by request body. */
function reportKind(url, init) {
  if (!url.includes(':runReport')) return null;
  const body = JSON.parse(init.body);
  return body.dimensions ? 'pages' : 'totals';
}

const TOTALS_BODY = {
  rows: [
    {
      metricValues: [
        { value: '1200' }, // sessions
        { value: '900' }, // totalUsers
        { value: '3400' }, // screenPageViews
        { value: '0.6123' }, // engagementRate
        { value: '95.4' }, // averageSessionDuration
      ],
    },
  ],
};

const PAGES_BODY = {
  rows: [
    { dimensionValues: [{ value: '/' }], metricValues: [{ value: '1500' }, { value: '800' }] },
    { dimensionValues: [{ value: '/pricing' }], metricValues: [{ value: '900' }, { value: '500' }] },
  ],
};

function totalsMatcher(body = TOTALS_BODY) {
  return { match: (url, init) => reportKind(url, init) === 'totals', response: () => jsonResponse(body) };
}
function pagesMatcher(body = PAGES_BODY) {
  return { match: (url, init) => reportKind(url, init) === 'pages', response: () => jsonResponse(body) };
}

test('SOURCE_KEY and SCOPE are the GA4 constants', () => {
  assert.equal(SOURCE_KEY, 'ga4');
  assert.equal(SCOPE, 'https://www.googleapis.com/auth/analytics.readonly');
});

test('fetches totals and top pages and converts every metric to a number', async () => {
  const stub = stubFetch([totalsMatcher(), pagesMatcher()]);
  try {
    const result = await fetchGa4({ propertyId: PROPERTY_ID }, { fetchImpl: globalThis.fetch });

    assert.equal(result.ok, true);
    assert.equal(result.period.startDate, '28daysAgo');
    assert.equal(result.period.endDate, 'today');

    const totals = result.sections.totals;
    assert.equal(totals.ok, true);
    assert.equal(totals.sessions, 1200);
    assert.equal(totals.totalUsers, 900);
    assert.equal(totals.screenPageViews, 3400);
    assert.equal(typeof totals.engagementRate, 'number');
    assert.equal(totals.engagementRate, 0.6123);
    assert.equal(totals.averageSessionDuration, 95.4);

    const topPages = result.sections.topPages;
    assert.equal(topPages.ok, true);
    assert.equal(topPages.pages.length, 2);
    assert.deepEqual(topPages.pages[0], { pagePath: '/', screenPageViews: 1500, sessions: 800 });
    assert.equal(typeof topPages.pages[0].screenPageViews, 'number');

    // Both report calls hit the property-scoped runReport endpoint with a
    // bearer token from the shared helper.
    const reports = stub.calls.filter((c) => c.url.includes(':runReport'));
    assert.equal(reports.length, 2);
    for (const call of reports) {
      assert.match(call.url, new RegExp(`/properties/${PROPERTY_ID}:runReport$`));
      assert.equal(call.init.headers.authorization, `Bearer ${FAKE_TOKEN}`);
    }
  } finally {
    stub.restore();
  }
});

test('a properties/ prefix is stripped from the report path', async () => {
  const stub = stubFetch([totalsMatcher(), pagesMatcher()]);
  try {
    const result = await fetchGa4(
      { propertyId: `properties/${PROPERTY_ID}` },
      { fetchImpl: globalThis.fetch },
    );
    assert.equal(result.ok, true);
    const report = stub.calls.find((c) => c.url.includes(':runReport'));
    assert.ok(report.url.endsWith(`/properties/${PROPERTY_ID}:runReport`), 'prefix removed once');
    assert.ok(!report.url.includes('properties/properties/'));
  } finally {
    stub.restore();
  }
});

test('a G- measurement id is NOT accepted as a property id', async () => {
  const stub = stubFetch([totalsMatcher(), pagesMatcher()]);
  try {
    await assert.rejects(
      () => fetchGa4({ propertyId: 'G-ABCDEF1234' }, { fetchImpl: globalThis.fetch }),
      /not a numeric GA4 property id/,
    );
    assert.equal(
      stub.calls.filter((c) => c.url.includes(':runReport')).length,
      0,
      'no report is issued for a measurement id',
    );
  } finally {
    stub.restore();
  }
});

test('an HTTP 500 on the totals report leaves top pages ok', async () => {
  const stub = stubFetch([
    {
      match: (url, init) => reportKind(url, init) === 'totals',
      response: () => jsonResponse({ error: { message: 'backend error' } }, { status: 500 }),
    },
    pagesMatcher(),
  ]);
  try {
    const result = await fetchGa4({ propertyId: PROPERTY_ID }, { fetchImpl: globalThis.fetch });
    assert.equal(result.ok, true, 'topPages still succeeded');
    assert.equal(result.sections.totals.ok, false);
    assert.match(result.sections.totals.error, /HTTP 500/);
    assert.equal(result.sections.topPages.ok, true);
    assert.equal(result.sections.topPages.pages.length, 2);
  } finally {
    stub.restore();
  }
});

test('an HTTP 500 on the top-pages report leaves totals ok', async () => {
  const stub = stubFetch([
    totalsMatcher(),
    {
      match: (url, init) => reportKind(url, init) === 'pages',
      response: () => jsonResponse({ error: { message: 'quota exceeded' } }, { status: 500 }),
    },
  ]);
  try {
    const result = await fetchGa4({ propertyId: PROPERTY_ID }, { fetchImpl: globalThis.fetch });
    assert.equal(result.ok, true);
    assert.equal(result.sections.totals.ok, true);
    assert.equal(result.sections.topPages.ok, false);
    assert.match(result.sections.topPages.error, /HTTP 500/);
  } finally {
    stub.restore();
  }
});

test('both sections failing makes the source non-ok', async () => {
  const stub = stubFetch([
    {
      match: (url, init) => reportKind(url, init) === 'totals',
      response: () => jsonResponse({}, { status: 403 }),
    },
    {
      match: (url, init) => reportKind(url, init) === 'pages',
      response: () => jsonResponse({}, { status: 403 }),
    },
  ]);
  try {
    const result = await fetchGa4({ propertyId: PROPERTY_ID }, { fetchImpl: globalThis.fetch });
    assert.equal(result.ok, false);
    assert.equal(result.sections.totals.ok, false);
    assert.equal(result.sections.topPages.ok, false);
  } finally {
    stub.restore();
  }
});

test('a non-JSON report body reports "not valid JSON"', async () => {
  const stub = stubFetch([
    {
      match: (url, init) => reportKind(url, init) === 'totals',
      response: () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      }),
    },
    pagesMatcher(),
  ]);
  try {
    const result = await fetchGa4({ propertyId: PROPERTY_ID }, { fetchImpl: globalThis.fetch });
    assert.equal(result.sections.totals.ok, false);
    assert.match(result.sections.totals.error, /not valid JSON/);
    assert.equal(result.sections.topPages.ok, true);
  } finally {
    stub.restore();
  }
});

test('fetchGa4 throws when propertyId is missing', async () => {
  await assert.rejects(
    () => fetchGa4({}, { fetchImpl: async () => jsonResponse({}) }),
    /ga4: missing required config field\(s\): propertyId/,
  );
});

test('shapeTotals reads metrics in order and tolerates an empty report', () => {
  assert.deepEqual(shapeTotals(TOTALS_BODY), {
    sessions: 1200,
    totalUsers: 900,
    screenPageViews: 3400,
    engagementRate: 0.6123,
    averageSessionDuration: 95.4,
  });

  assert.deepEqual(shapeTotals({}), {
    sessions: null,
    totalUsers: null,
    screenPageViews: null,
    engagementRate: null,
    averageSessionDuration: null,
  });
});

test('shapeTopPages normalizes rows and sorts by page views desc', () => {
  const pages = shapeTopPages({
    rows: [
      { dimensionValues: [{ value: '/a' }], metricValues: [{ value: '10' }, { value: '5' }] },
      { dimensionValues: [{ value: '/b' }], metricValues: [{ value: '99' }, { value: '40' }] },
    ],
  });
  assert.equal(pages[0].pagePath, '/b');
  assert.equal(pages[0].screenPageViews, 99);
  assert.equal(pages[1].pagePath, '/a');
  assert.equal(typeof pages[1].sessions, 'number');
});

test('normalizePropertyId / isNumericPropertyId', () => {
  assert.equal(normalizePropertyId('properties/42'), '42');
  assert.equal(normalizePropertyId('42'), '42');
  assert.equal(normalizePropertyId(null), null);
  assert.equal(isNumericPropertyId('properties/42'), true);
  assert.equal(isNumericPropertyId('42'), true);
  assert.equal(isNumericPropertyId('G-ABC'), false);
});

test('ga4ConfigFromApp prefers the environment, then the config file', () => {
  assert.deepEqual(ga4ConfigFromApp({ sources: { ga4: { config: { propertyId: 'from-file' } } } }, {}), {
    propertyId: 'from-file',
  });
  assert.deepEqual(
    ga4ConfigFromApp({ sources: { ga4: { config: { propertyId: 'from-file' } } } }, { GA4_PROPERTY_ID: 'from-env' }),
    { propertyId: 'from-env' },
  );
  assert.deepEqual(ga4ConfigFromApp(undefined, {}), { propertyId: null });
});

// The module exposes its pure normalizers for unit testing; guard that surface.
test('module exports its pure normalizers', () => {
  assert.equal(typeof shapeTotals, 'function');
  assert.equal(typeof shapeTopPages, 'function');
});