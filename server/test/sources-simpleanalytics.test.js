import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStatsUrl,
  fetchSimpleAnalytics,
  normalizeSite,
  periodFor,
  shapeDaily,
  shapeSummary,
  simpleAnalyticsConfigFromApp,
  SOURCE_KEY,
} from '../src/sources/simpleAnalytics.js';

/**
 * Simple Analytics source tests — pure fetcher level.
 *
 * globalThis.fetch is stubbed and restored; nothing hits the network. The
 * parsing is exercised against every plausible response shape the module
 * accepts, plus a garbage body that must not throw.
 */

const FAKE_KEY = '«redacted:sa_api_key_…»';
const SITE = 'example.com';

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

function stubFetch(script) {
  const original = globalThis.fetch;
  const calls = [];
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
    },
  };
}

/** The documented v6 response: root totals + a per-day histogram. */
const DOCUMENTED_BODY = {
  pageviews: 3400,
  visitors: 900,
  seconds_on_page: 26,
  histogram: [
    { date: '2026-11-02', pageviews: 200, visitors: 120 },
    { date: '2026-11-01', pageviews: 150, visitors: 90 },
  ],
};

test('SOURCE_KEY is the simpleAnalytics constant', () => {
  assert.equal(SOURCE_KEY, 'simpleAnalytics');
});

test('fetches summary and a sorted daily series from the documented shape', async () => {
  const stub = stubFetch([{ match: () => true, response: () => jsonResponse(DOCUMENTED_BODY) }]);
  try {
    const result = await fetchSimpleAnalytics(
      { site: SITE, apiKey: FAKE_KEY },
      { fetchImpl: globalThis.fetch },
    );

    assert.equal(result.ok, true);
    assert.match(result.period.startDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(result.period.endDate, /^\d{4}-\d{2}-\d{2}$/);

    const summary = result.sections.summary;
    assert.equal(summary.ok, true);
    assert.equal(summary.visitors, 900);
    assert.equal(summary.pageviews, 3400);
    assert.equal(typeof summary.visitors, 'number');
    assert.equal(typeof summary.pageviews, 'number');
    assert.equal(summary.secondsOnPage, 26);

    const daily = result.sections.daily;
    assert.equal(daily.ok, true);
    assert.equal(daily.days.length, 2);
    assert.deepEqual(daily.days[0], { date: '2026-11-01', pageviews: 150, visitors: 90 });
    assert.deepEqual(daily.days[1], { date: '2026-11-02', pageviews: 200, visitors: 120 });

    // Documented request shape: hostname in the path, version 6, fields,
    // ISO dates, info=false, and the Api-Key header.
    const call = stub.calls[0];
    const url = new URL(call.url);
    assert.equal(url.origin, 'https://simpleanalytics.com');
    assert.equal(url.pathname, `/${SITE}.json`);
    assert.equal(url.searchParams.get('version'), '6');
    assert.match(url.searchParams.get('fields'), /pageviews/);
    assert.match(url.searchParams.get('fields'), /histogram/);
    assert.equal(url.searchParams.get('info'), 'false');
    assert.match(url.searchParams.get('start'), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.headers['Api-Key'], FAKE_KEY);
  } finally {
    stub.restore();
  }
});

test('an Api-Key header is omitted when no key is configured', async () => {
  const stub = stubFetch([{ match: () => true, response: () => jsonResponse(DOCUMENTED_BODY) }]);
  try {
    await fetchSimpleAnalytics({ site: SITE }, { fetchImpl: globalThis.fetch });
    assert.equal(stub.calls[0].init.headers['Api-Key'], undefined);
  } finally {
    stub.restore();
  }
});

test('a bare array of daily rows normalizes to a summary and a series', async () => {
  const rows = [
    { date: '2026-11-01', visitors: 10, pageviews: 20 },
    { date: '2026-11-02', visitors: 5, pageviews: 8 },
  ];
  const stub = stubFetch([{ match: () => true, response: () => jsonResponse(rows) }]);
  try {
    const result = await fetchSimpleAnalytics({ site: SITE }, { fetchImpl: globalThis.fetch });
    assert.equal(result.ok, true);
    assert.equal(result.sections.summary.ok, true);
    assert.equal(result.sections.summary.visitors, 15);
    assert.equal(result.sections.summary.pageviews, 28);
    assert.equal(result.sections.daily.ok, true);
    assert.equal(result.sections.daily.days.length, 2);
    assert.deepEqual(result.sections.daily.days[0], { date: '2026-11-01', pageviews: 20, visitors: 10 });
  } finally {
    stub.restore();
  }
});

test('a camelCase / data-wrapped shape also normalizes', async () => {
  const body = {
    data: {
      pageViews: 500,
      uniqueVisitors: 200,
      secondsOnPage: 12.5,
      by_day: [
        { day: '2026-11-01', views: 300, uniqueVisitors: 120 },
        { day: '2026-11-02', views: 200, uniqueVisitors: 80 },
      ],
    },
  };
  const stub = stubFetch([{ match: () => true, response: () => jsonResponse(body) }]);
  try {
    const result = await fetchSimpleAnalytics({ site: SITE }, { fetchImpl: globalThis.fetch });
    assert.equal(result.ok, true);
    assert.equal(result.sections.summary.pageviews, 500);
    assert.equal(result.sections.summary.visitors, 200);
    assert.equal(result.sections.daily.ok, true);
    assert.equal(result.sections.daily.days.length, 2);
  } finally {
    stub.restore();
  }
});

test('an unrecognized shape returns ok:false rather than throwing', async () => {
  const stub = stubFetch([{ match: () => true, response: () => jsonResponse({ hello: 'world' }) }]);
  try {
    const result = await fetchSimpleAnalytics({ site: SITE }, { fetchImpl: globalThis.fetch });
    assert.equal(result.ok, false);
    assert.equal(result.sections.summary.ok, false);
    assert.match(result.sections.summary.error, /unrecognized response shape/);
    assert.equal(result.sections.daily.ok, false);
  } finally {
    stub.restore();
  }
});

test('a non-JSON body reports "not valid JSON"', async () => {
  const stub = stubFetch([
    {
      match: () => true,
      response: () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      }),
    },
  ]);
  try {
    const result = await fetchSimpleAnalytics({ site: SITE }, { fetchImpl: globalThis.fetch });
    assert.equal(result.ok, false);
    assert.equal(result.sections.summary.ok, false);
    assert.match(result.sections.summary.error, /not valid JSON/);
    assert.match(result.sections.daily.error, /not valid JSON/);
  } finally {
    stub.restore();
  }
});

test('an HTTP 500 fails both sections with the status in the message', async () => {
  const stub = stubFetch([
    {
      match: () => true,
      response: () => jsonResponse({ ok: false, error: 'server error' }, { status: 500 }),
    },
  ]);
  try {
    const result = await fetchSimpleAnalytics({ site: SITE }, { fetchImpl: globalThis.fetch });
    assert.equal(result.ok, false);
    assert.equal(result.sections.summary.ok, false);
    assert.match(result.sections.summary.error, /HTTP 500/);
    assert.equal(result.sections.daily.ok, false);
  } finally {
    stub.restore();
  }
});

test('fetchSimpleAnalytics throws when site is missing', async () => {
  await assert.rejects(
    () => fetchSimpleAnalytics({}, { fetchImpl: async () => jsonResponse({}) }),
    /simpleAnalytics: missing required config field\(s\): site/,
  );
});

test('shapeSummary handles the documented, camelCase and array shapes', () => {
  assert.deepEqual(shapeSummary(DOCUMENTED_BODY), {
    visitors: 900,
    pageviews: 3400,
    secondsOnPage: 26,
  });
  assert.deepEqual(shapeSummary({ visitors: 5 }), { visitors: 5, pageviews: null, secondsOnPage: null });
  assert.deepEqual(shapeSummary([{ date: '2026-11-01', visitors: 3, pageviews: 7 }]), {
    visitors: 3,
    pageviews: 7,
    secondsOnPage: null,
  });
  assert.equal(shapeSummary({ nope: true }), null);
  assert.equal(shapeSummary(null), null);
});

test('shapeDaily sorts rows by date and merges duplicates', () => {
  const daily = shapeDaily({
    histogram: [
      { date: '2026-11-02', pageviews: 5, visitors: 2 },
      { date: '2026-11-01', pageviews: 3, visitors: 1 },
      { date: '2026-11-01', pageviews: 4, visitors: 1 },
    ],
  });
  assert.equal(daily.length, 2);
  assert.deepEqual(daily[0], { date: '2026-11-01', pageviews: 7, visitors: 2 });
  assert.deepEqual(daily[1], { date: '2026-11-02', pageviews: 5, visitors: 2 });
  assert.deepEqual(shapeDaily({}), []);
  assert.deepEqual(shapeDaily(null), []);
});

test('buildStatsUrl and normalizeSite follow the documented hostname-in-path contract', () => {
  const period = { startDate: '2026-11-01', endDate: '2026-11-28' };
  const url = new URL(buildStatsUrl(SITE, period));
  assert.equal(url.pathname, '/example.com.json');
  assert.equal(url.searchParams.get('start'), '2026-11-01');
  assert.equal(url.searchParams.get('end'), '2026-11-28');

  assert.equal(normalizeSite('https://example.com/some/path'), 'example.com');
  assert.equal(normalizeSite('example.com'), 'example.com');
  assert.equal(normalizeSite('  '), null);
});

test('periodFor returns an inclusive window of the requested length', () => {
  const period = periodFor(28, new Date('2026-11-28T12:00:00Z'));
  assert.equal(period.endDate, '2026-11-28');
  assert.equal(period.startDate, '2026-11-01');
});

test('simpleAnalyticsConfigFromApp prefers the environment, then the config file', () => {
  assert.deepEqual(
    simpleAnalyticsConfigFromApp(
      { sources: { simpleAnalytics: { config: { site: 'file.example' } } } },
      {},
    ),
    { site: 'file.example', apiKey: null },
  );
  assert.deepEqual(
    simpleAnalyticsConfigFromApp(
      { sources: { simpleAnalytics: { config: { site: 'file.example' } } } },
      { SIMPLE_ANALYTICS_SITE: 'env.example', SIMPLE_ANALYTICS_API_KEY: FAKE_KEY },
    ),
    { site: 'env.example', apiKey: FAKE_KEY },
  );
  assert.deepEqual(simpleAnalyticsConfigFromApp(undefined, {}), { site: null, apiKey: null });
});