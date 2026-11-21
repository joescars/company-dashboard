import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type AdSensePayload,
  type AzurePayload,
  type Ga4Payload,
  type OpenRouterPayload,
  type PublicConfig,
  type SearchConsolePayload,
  type SimpleAnalyticsPayload,
  type SourceEnvelope,
  type SourceKey,
  fetchSource,
  refreshSource,
} from '../lib/api.js';
import {
  count,
  dateTime,
  money,
  num,
  percentFromRatio,
  position,
  relativeTime,
} from '../lib/format.js';
import { SourceCard, type CardStatus } from '../components/SourceCard.js';
import {
  AdSensePanel,
  AzurePanel,
  Ga4Panel,
  OpenRouterPanel,
  SearchConsolePanel,
  SimpleAnalyticsPanel,
} from '../components/SourcePanels.js';

/**
 * The overview page.
 *
 * Rules this page follows:
 * - A source that is not configured is *not shown*. The dashboard is a summary,
 *   not a configuration checklist.
 * - A source that is configured but has never been fetched shows "Not fetched"
 *   with a Refresh action — never a fake zero.
 * - A partially-failed fetch shows the sections that worked and names the ones
 *   that didn't. One broken API must not blank the whole tile.
 */

type SourceState = {
  status: 'loading' | 'ready' | 'unavailable';
  envelope?: SourceEnvelope<unknown>;
  refreshing?: boolean;
  error?: string;
};

const SOURCE_ORDER: { key: SourceKey; title: string }[] = [
  { key: 'ga4', title: 'Site traffic' },
  { key: 'searchConsole', title: 'Search performance' },
  { key: 'adsense', title: 'Ad revenue' },
  { key: 'azure', title: 'AI spend (Azure)' },
  { key: 'openrouter', title: 'AI spend (OpenRouter)' },
  { key: 'simpleAnalytics', title: 'Simple Analytics' },
];

export function Dashboard({ config, csrfToken }: { config: PublicConfig; csrfToken: string }) {
  const [states, setStates] = useState<Record<string, SourceState>>({});
  const [refreshingAll, setRefreshingAll] = useState(false);
  const mounted = useRef(true);

  const enabledSources = useMemo(
    () => SOURCE_ORDER.filter((source) => config.sources?.[source.key]?.enabled),
    [config],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Initial read is local-only: it returns the most recent stored snapshot and
  // never calls a provider, so opening the page costs nothing upstream.
  useEffect(() => {
    if (enabledSources.length === 0) return;
    let cancelled = false;

    for (const { key } of enabledSources) {
      setStates((previous) => ({ ...previous, [key]: { status: 'loading' } }));
      fetchSource(key)
        .then((envelope) => {
          if (cancelled) return;
          setStates((previous) => ({
            ...previous,
            [key]: { status: 'ready', envelope: envelope as SourceEnvelope<unknown> },
          }));
        })
        .catch((error: Error) => {
          if (cancelled) return;
          setStates((previous) => ({
            ...previous,
            [key]: { status: 'unavailable', error: error.message },
          }));
        });
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledSources.map((source) => source.key).join(',')]);

  const refreshOne = useCallback(
    async (key: SourceKey) => {
      setStates((previous) => ({
        ...previous,
        [key]: { ...(previous[key] ?? { status: 'ready' }), refreshing: true, error: undefined },
      }));
      try {
        const result = await refreshSource(key, csrfToken);
        if (!mounted.current) return;
        setStates((previous) => ({
          ...previous,
          [key]: {
            status: 'ready',
            refreshing: false,
            envelope: {
              source: key,
              enabled: true,
              health: result.health,
              snapshot:
                result.data && result.fetchedAt
                  ? { id: result.snapshotId ?? 0, fetchedAt: result.fetchedAt, payload: result.data }
                  : null,
              data: result.data,
              fetchedAt: result.fetchedAt,
            } as SourceEnvelope<unknown>,
          },
        }));
      } catch (error) {
        if (!mounted.current) return;
        setStates((previous) => ({
          ...previous,
          [key]: {
            ...(previous[key] ?? { status: 'ready' }),
            refreshing: false,
            error: (error as Error).message,
          },
        }));
      }
    },
    [csrfToken],
  );

  const refreshAll = useCallback(async () => {
    setRefreshingAll(true);
    try {
      // Sequential on purpose: these are rate-limited third-party APIs, and a
      // burst of parallel calls is the fastest way to get throttled.
      for (const { key } of enabledSources) {
        await refreshOne(key);
      }
    } finally {
      if (mounted.current) setRefreshingAll(false);
    }
  }, [enabledSources, refreshOne]);

  const newestFetch = useMemo(() => {
    const stamps = Object.values(states)
      .map((state) => state.envelope?.fetchedAt)
      .filter((value): value is string => Boolean(value));
    if (stamps.length === 0) return null;
    return stamps.sort().at(-1) ?? null;
  }, [states]);

  const summary = useMemo(() => buildSummary(states), [states]);

  return (
    <div className="dashboard">
      <header className="dashboard__head">
        <div>
          <h1 className="dashboard__title">{config.companyName}</h1>
          <p className="dashboard__subtitle">
            {newestFetch
              ? `Most recent data ${relativeTime(newestFetch)}`
              : 'No data fetched yet'}
            {config.siteUrl ? ` · ${hostOf(config.siteUrl)}` : ''}
          </p>
        </div>
        {enabledSources.length > 0 ? (
          <button
            type="button"
            className="md-button md-button--filled"
            onClick={refreshAll}
            disabled={refreshingAll}
          >
            {refreshingAll ? 'Refreshing…' : 'Refresh all'}
          </button>
        ) : null}
      </header>

      {summary.length > 0 ? (
        <section className="summary-strip" aria-label="Headline numbers">
          {summary.map((item) => (
            <div className="summary-strip__item" key={item.label}>
              <span className="summary-strip__label">{item.label}</span>
              <span className="summary-strip__value">{item.value}</span>
              <span className="summary-strip__hint">{item.hint}</span>
            </div>
          ))}
        </section>
      ) : null}

      {enabledSources.length === 0 ? (
        <div className="md-card dashboard__empty">
          <h2 style={{ marginTop: 0 }}>No data sources configured</h2>
          <p style={{ color: 'var(--md-on-surface-variant)' }}>
            This dashboard stays empty until at least one source has credentials. See{' '}
            <code>docs/CREDENTIALS.md</code> for how to obtain each one, then set them in{' '}
            <code>.env</code> and restart.
          </p>
        </div>
      ) : (
        <div className="dashboard__grid">
          {enabledSources.map(({ key, title }) => {
            const state = states[key];
            return (
              <SourceCard
                key={key}
                title={title}
                status={cardStatus(state)}
                fetchedAt={state?.envelope?.fetchedAt ?? null}
                error={state?.error ?? stateError(state)}
                refreshing={state?.refreshing ?? false}
                onRefresh={() => void refreshOne(key)}
                subtitle={periodFor(state?.envelope?.data) ?? subtitleFor(key)}
              >
                {renderPanel(key, state?.envelope?.data)}
              </SourceCard>
            );
          })}
        </div>
      )}

      <footer className="dashboard__footer">
        <span>
          Data is read from the local cache; “Refresh” re-fetches from each provider.
        </span>
        {newestFetch ? <span title={newestFetch}>Last updated {dateTime(newestFetch)}</span> : null}
      </footer>
    </div>
  );
}

/* ------------------------------ headline ------------------------------ */

type SummaryItem = { label: string; value: string; hint: string };

/**
 * The strip above the tiles. Each entry comes from the payload that is already
 * on the page — it never triggers a fetch, and a source that has no data is
 * simply absent rather than showing a zero that implies "no traffic".
 */
function buildSummary(states: Record<string, SourceState>): SummaryItem[] {
  const items: SummaryItem[] = [];

  const ga4 = states.ga4?.envelope?.data as Ga4Payload | null | undefined;
  const sa = states.simpleAnalytics?.envelope?.data as SimpleAnalyticsPayload | null | undefined;
  if (ga4?.sections?.totals?.ok) {
    items.push({
      label: 'Sessions',
      value: count(ga4.sections.totals.sessions),
      hint: ga4.period ? periodSpan(ga4.period) : 'Google Analytics 4',
    });
  } else if (sa?.sections?.summary?.ok) {
    items.push({
      label: 'Visitors',
      value: count(sa.sections.summary.visitors),
      hint: sa.period ? periodSpan(sa.period) : 'Simple Analytics',
    });
  }

  const gsc = states.searchConsole?.envelope?.data as SearchConsolePayload | null | undefined;
  if (gsc?.totals) {
    items.push({
      label: 'Search clicks',
      value: count(gsc.totals.clicks),
      hint: `CTR ${percentFromRatio(gsc.totals.ctr)} · position ${position(gsc.totals.position)}`,
    });
  }

  const ads = states.adsense?.envelope?.data as AdSensePayload | null | undefined;
  const adsSummary = ads?.sections?.summary;
  if (adsSummary?.ok && adsSummary.estimatedEarnings !== undefined) {
    items.push({
      label: 'Ad revenue',
      value: money(adsSummary.estimatedEarnings, adsSummary.currency),
      hint: adsSummary.rpm === undefined ? 'Estimated earnings' : `RPM ${money(adsSummary.rpm, adsSummary.currency)}`,
    });
  }

  const azure = states.azure?.envelope?.data as AzurePayload | null | undefined;
  const azureCost = azure?.sections?.cost;
  const or = states.openrouter?.envelope?.data as OpenRouterPayload | null | undefined;
  const orKey = or?.sections?.key;
  const azureTotal = azureCost?.ok ? num(azureCost.total) : null;
  const orTotal = orKey?.ok ? num(orKey.usage) : null;
  if (azureTotal !== null || orTotal !== null) {
    const total = (azureTotal ?? 0) + (orTotal ?? 0);
    const parts = [
      azureTotal !== null ? 'Azure' : null,
      orTotal !== null ? 'OpenRouter' : null,
    ].filter(Boolean);
    const currency = azureCost?.ok ? azureCost.currency : null;
    items.push({
      label: 'AI spend',
      value: money(total, currency ?? 'USD'),
      hint: parts.join(' + '),
    });
  }

  return items;
}

function periodSpan(period: { startDate?: string | null; endDate?: string | null }): string {
  const start = period.startDate ? shortDate(period.startDate) : null;
  const end = period.endDate ? shortDate(period.endDate) : null;
  if (start && end) return `${start} – ${end}`;
  return start ?? end ?? '';
}

/* ------------------------------------------------------------------ */

function cardStatus(state: SourceState | undefined): CardStatus {
  if (!state) return 'loading';
  if (state.status === 'loading') return 'loading';
  if (state.status === 'unavailable') return 'error';
  if (state.refreshing) return 'loading';
  const health = state.envelope?.health;
  if (health && health.ok === false && health.lastError) return 'error';
  if (!state.envelope?.data) return 'idle';
  return payloadIsPartial(state.envelope.data) ? 'partial' : 'ok';
}

/** A payload is partial when any section failed, even if the envelope is ok. */
function payloadIsPartial(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as {
    ok?: boolean;
    errors?: unknown;
    sections?: Record<string, { ok?: boolean } | undefined>;
  };
  if (record.ok === false) return true;
  if (record.errors && Object.keys(record.errors).length > 0) return true;
  return Object.values(record.sections ?? {}).some((section) => section?.ok === false);
}

function stateError(state: SourceState | undefined): string | null {
  if (!state?.envelope) return null;
  const health = state.envelope.health;
  if (health.lastError) return health.lastError;
  const payload = state.envelope.data as { errors?: Record<string, string> } | null;
  const messages = payload?.errors ? Object.values(payload.errors) : [];
  return messages.length > 0 ? messages.join(' · ') : null;
}

function periodFor(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const period = (payload as { period?: { startDate?: string; endDate?: string } }).period;
  if (!period?.startDate && !period?.endDate) return null;
  const start = period.startDate ? shortDate(period.startDate) : null;
  const end = period.endDate ? shortDate(period.endDate) : null;
  if (start && end) return `${start} – ${end}`;
  return start ?? end;
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function subtitleFor(key: SourceKey): string {
  switch (key) {
    case 'ga4':
      return 'Last 28 days · Google Analytics 4';
    case 'searchConsole':
      return 'Last 28 days · Search Console';
    case 'adsense':
      return 'Last 30 days · AdSense';
    case 'azure':
      return 'Azure Cost Management + Monitor';
    case 'openrouter':
      return 'OpenRouter credits and usage';
    case 'simpleAnalytics':
      return 'Simple Analytics';
    default:
      return '';
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Payloads are fetched with a known source key, so the cast is a narrowing, not
 * a guess: the server contract per key is asserted by server/test/sources-*.js.
 */
function renderPanel(key: SourceKey, payload: unknown) {
  if (!payload) return null;
  switch (key) {
    case 'ga4':
      return <Ga4Panel payload={payload as Ga4Payload} />;
    case 'adsense':
      return <AdSensePanel payload={payload as AdSensePayload} />;
    case 'searchConsole':
      return <SearchConsolePanel payload={payload as SearchConsolePayload} />;
    case 'azure':
      return <AzurePanel payload={payload as AzurePayload} />;
    case 'openrouter':
      return <OpenRouterPanel payload={payload as OpenRouterPayload} />;
    case 'simpleAnalytics':
      return <SimpleAnalyticsPanel payload={payload as SimpleAnalyticsPayload} />;
    default:
      return null;
  }
}
