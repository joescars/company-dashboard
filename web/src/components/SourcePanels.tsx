import type {
  AdSensePayload,
  AzurePayload,
  Ga4Payload,
  OpenRouterPayload,
  SearchConsolePayload,
  SimpleAnalyticsPayload,
} from '../lib/api.js';
import {
  count,
  duration,
  money,
  num,
  percent,
  percentFromRatio,
  position,
} from '../lib/format.js';
import { DataTable, SectionError, Sparkline, Stat } from './SourceCard.js';

/**
 * One panel per source. These are deliberately not driven by a schema map:
 * GA4's "engagement rate" is a ratio, AdSense's earnings are money with a
 * currency code, Search Console's CTR arrives as a 0–100 percentage. Pretending
 * they share a shape would produce silently mislabelled numbers.
 */

/** Shared per-section error rendering: every panel shows what was lost. */
function sectionFailure(label: string, error: string) {
  return <SectionError>{label}: {error}</SectionError>;
}

/* ------------------------------- Azure ------------------------------- */

export function AzurePanel({ payload }: { payload: AzurePayload }) {
  const cost = payload.sections?.cost;
  const metrics = payload.sections?.metrics;

  const resourceMetrics =
    metrics?.ok
      ? metrics.resources
          .filter((resource) => resource.ok)
          .flatMap((resource) =>
            resource.metrics.map((metric) => ({
              resource: shortResource(resource.resourceId),
              metric: metric.name,
              average: metric.average === null ? '—' : count(metric.average),
            })),
          )
          .slice(0, 6)
      : [];

  return (
    <>
      <div className="stat-row">
        <Stat
          label="Billing this period"
          value={cost?.ok ? money(cost.total, cost.currency) : '—'}
          hint={payload.dataThrough ? `data through ${payload.dataThrough}` : undefined}
        />
        {cost?.ok && typeof cost.previousTotal === 'number' ? (
          <Stat
            label="Previous period"
            value={money(cost.previousTotal, cost.currency)}
            hint={deltaHint(cost.total, cost.previousTotal)}
          />
        ) : null}
      </div>

      {cost && !cost.ok ? sectionFailure('Billing', cost.error) : null}

      {resourceMetrics.length > 0 ? (
        <DataTable
          columns={[
            { key: 'resource', label: 'Resource' },
            { key: 'metric', label: 'Metric' },
            { key: 'average', label: 'Avg', align: 'end' },
          ]}
          rows={resourceMetrics.map((row) => ({
            resource: <code className="mono-clip">{row.resource}</code>,
            metric: row.metric,
            average: row.average,
          }))}
        />
      ) : null}

      {metrics && !metrics.ok ? sectionFailure('Azure Monitor', metrics.error) : null}

      {payload.errors
        ? Object.entries(payload.errors)
            .filter(([key]) => key !== 'cost' && key !== 'metrics')
            .map(([key, error]) => (
              <SectionError key={key}>
                {key}: {error}
              </SectionError>
            ))
        : null}
    </>
  );
}

/* ----------------------------- OpenRouter ---------------------------- */

export function OpenRouterPanel({ payload }: { payload: OpenRouterPayload }) {
  const credits = payload.sections?.credits;
  const key = payload.sections?.key;
  const activity = payload.sections?.activity;

  return (
    <>
      <div className="stat-row">
        <Stat
          label="Spend to date"
          value={credits?.ok ? money(credits.totalUsage, 'USD') : '—'}
        />
        <Stat
          label="Credits remaining"
          value={credits?.ok ? money(credits.remaining, 'USD') : '—'}
          hint={credits?.ok ? `of ${money(credits.totalCredits, 'USD')}` : undefined}
        />
        <Stat
          label="Requests (window)"
          value={activity?.ok ? count(activity.totals.requests) : '—'}
        />
      </div>

      {activity?.ok ? (
        <Sparkline
          values={activity.points.map((point) => point.usage)}
          label="Daily OpenRouter spend"
        />
      ) : null}

      {credits && !credits.ok ? sectionFailure('Credits', credits.error) : null}
      {key && !key.ok ? sectionFailure('API key', key.error) : null}
      {activity && !activity.ok ? sectionFailure('Activity', activity.error) : null}
    </>
  );
}

/* --------------------------- Search Console --------------------------- */

export function SearchConsolePanel({ payload }: { payload: SearchConsolePayload }) {
  if (payload.ok === false) {
    return <SectionError>Search Console: {payload.error ?? 'request failed'}</SectionError>;
  }

  const totals = payload.totals;
  const rows = (payload.queries ?? []).slice(0, 8).map((row) => ({
    query: row.keys?.[0] ?? '—',
    clicks: count(row.clicks),
    impressions: count(row.impressions),
    ctr: percentFromRatio(row.ctr, 1),
    position: position(row.position),
  }));

  return (
    <>
      <div className="stat-row">
        <Stat label="Clicks" value={count(totals?.clicks)} />
        <Stat label="Impressions" value={count(totals?.impressions)} />
        <Stat label="CTR" value={percentFromRatio(totals?.ctr, 1)} />
        <Stat label="Avg. position" value={position(totals?.position)} />
      </div>

      <DataTable
        columns={[
          { key: 'query', label: 'Top query' },
          { key: 'clicks', label: 'Clicks', align: 'end' },
          { key: 'impressions', label: 'Impr.', align: 'end' },
          { key: 'position', label: 'Pos.', align: 'end' },
        ]}
        rows={rows}
        emptyLabel="No search queries reported for this period."
      />
    </>
  );
}

/* -------------------------------- GA4 -------------------------------- */

export function Ga4Panel({ payload }: { payload: Ga4Payload }) {
  const totals = payload.sections?.totals;
  const topPages = payload.sections?.topPages;

  return (
    <>
      <div className="stat-row">
        <Stat label="Sessions" value={totals?.ok ? count(totals.sessions) : '—'} />
        <Stat label="Users" value={totals?.ok ? count(totals.totalUsers) : '—'} />
        <Stat label="Page views" value={totals?.ok ? count(totals.screenPageViews) : '—'} />
        <Stat
          label="Engagement"
          value={totals?.ok ? percentFromRatio(totals.engagementRate) : '—'}
        />
        <Stat
          label="Avg. session"
          value={totals?.ok ? duration(totals.averageSessionDuration) : '—'}
        />
      </div>

      {totals && !totals.ok ? sectionFailure('Totals', totals.error) : null}

      {topPages?.ok ? (
        <DataTable
          columns={[
            { key: 'page', label: 'Top page' },
            { key: 'views', label: 'Views', align: 'end' },
            { key: 'sessions', label: 'Sessions', align: 'end' },
          ]}
          rows={topPages.pages.slice(0, 6).map((page) => ({
            page: <code className="mono-clip">{page.pagePath ?? '—'}</code>,
            views: count(page.screenPageViews),
            sessions: count(page.sessions),
          }))}
          emptyLabel="No page data for this period."
        />
      ) : null}

      {topPages && !topPages.ok ? sectionFailure('Top pages', topPages.error) : null}
    </>
  );
}

/* ------------------------------ AdSense ------------------------------ */

export function AdSensePanel({ payload }: { payload: AdSensePayload }) {
  const summary = payload.sections?.summary;
  const daily = payload.sections?.daily;

  return (
    <>
      <div className="stat-row">
        <Stat
          label="Estimated earnings"
          value={summary?.ok ? money(summary.estimatedEarnings, summary.currency) : '—'}
        />
        <Stat label="RPM" value={summary?.ok ? money(summary.rpm, summary.currency) : '—'} />
        <Stat label="Clicks" value={summary?.ok ? count(summary.clicks) : '—'} />
        <Stat label="Impressions" value={summary?.ok ? count(summary.impressions) : '—'} />
      </div>

      {daily?.ok ? (
        <Sparkline
          values={daily.days.map((day) => day.estimatedEarnings ?? 0)}
          label="Daily estimated earnings"
        />
      ) : null}

      {summary && !summary.ok ? sectionFailure('Summary', summary.error) : null}
      {daily && !daily.ok ? sectionFailure('Daily trend', daily.error) : null}
    </>
  );
}

/* --------------------------- Simple Analytics ------------------------- */

export function SimpleAnalyticsPanel({ payload }: { payload: SimpleAnalyticsPayload }) {
  const summary = payload.sections?.summary;
  const daily = payload.sections?.daily;

  return (
    <>
      <div className="stat-row">
        <Stat label="Visitors" value={summary?.ok ? count(summary.visitors) : '—'} />
        <Stat label="Page views" value={summary?.ok ? count(summary.pageviews) : '—'} />
        <Stat
          label="Time on page"
          value={summary?.ok ? duration(summary.secondsOnPage) : '—'}
        />
      </div>

      {daily?.ok ? (
        <Sparkline
          values={daily.days.map((day) => day.pageviews)}
          label="Daily page views"
        />
      ) : null}

      {summary && !summary.ok ? sectionFailure('Summary', summary.error) : null}
      {daily && !daily.ok ? sectionFailure('Daily trend', daily.error) : null}
    </>
  );
}

/* ------------------------------ helpers ------------------------------ */

/** `/subscriptions/xxx/resourceGroups/rg/providers/.../sites/name` → `name` */
function shortResource(resourceId: string): string {
  const parts = resourceId.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? resourceId;
}

function deltaHint(current: number | null, previous: number | null): string | undefined {
  const now = num(current);
  const before = num(previous);
  if (now === null || before === null || before === 0) return undefined;
  const change = ((now - before) / before) * 100;
  const arrow = change >= 0 ? '▲' : '▼';
  return `${arrow} ${percent(Math.abs(change), 0)} vs previous`;
}
