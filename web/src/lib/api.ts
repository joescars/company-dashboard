/** Shape of the safe configuration returned by GET /api/config. */
export type SourceKey =
  | 'azure'
  | 'openrouter'
  | 'searchConsole'
  | 'ga4'
  | 'adsense'
  | 'simpleAnalytics';

export interface PublicConfig {
  companyName: string;
  siteUrl: string | null;
  logoUrl: string | null;
  theme: { accent: string };
  sources: Record<SourceKey, { enabled: boolean }>;
}

export interface AuthUser {
  email: string;
  name: string;
}

export interface AuthStatus {
  configured: boolean;
  user: AuthUser | null;
  csrfToken: string;
}

export interface EnvVariable {
  name: string;
  description: string;
  set: boolean;
  live: boolean;
  required?: boolean;
}

export interface EnvGroup {
  key: string;
  label: string;
  description: string;
  variables: EnvVariable[];
}

export interface EnvManifest {
  groups: EnvGroup[];
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function fetchConfig(signal?: AbortSignal): Promise<PublicConfig> {
  const response = await fetch('/api/config', { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`config request failed: ${response.status}`);
  return (await response.json()) as PublicConfig;
}

export async function fetchAuthStatus(signal?: AbortSignal): Promise<AuthStatus> {
  return json<AuthStatus>(
    await fetch('/api/auth/status', { signal, headers: { Accept: 'application/json' } }),
  );
}

export async function signOut(csrfToken: string): Promise<void> {
  await json(
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': csrfToken, Accept: 'application/json' },
    }),
  );
}

export async function fetchEnvManifest(signal?: AbortSignal): Promise<EnvManifest> {
  return json<EnvManifest>(
    await fetch('/api/admin/env', { signal, headers: { Accept: 'application/json' } }),
  );
}

/* ------------------------------------------------------------------ *
 * Source data
 *
 * Every fetchable source returns the same outer envelope. Sections are
 * optional and independently fallible, so a partial outage renders a partial
 * tile instead of an empty one.
 * ------------------------------------------------------------------ */

/** A section that either carries data or carries the reason it doesn't. */
export type Section<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface SourceHealth {
  ok: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface SourceEnvelope<T> {
  source: SourceKey;
  enabled: boolean;
  health: SourceHealth;
  snapshot: { id: number; fetchedAt: string; payload: T } | null;
  data: T | null;
  fetchedAt: string | null;
}

export interface RefreshResult<T> {
  source: SourceKey;
  ok: boolean;
  saved: boolean;
  fetchedAt: string | null;
  snapshotId: number | null;
  health: SourceHealth;
  data: T | null;
  error?: string;
  message?: string;
}

/* Per-source payloads, mirroring server/src/sources/*.js. */

export interface AzurePayload {
  ok: boolean;
  fetchedAt: string;
  billingLagHours?: number;
  dataThrough?: string | null;
  sections: {
    cost?: Section<{
      currency: string | null;
      total: number;
      previousTotal?: number | null;
      byService?: { name: string | null; cost: number }[];
    }>;
    metrics?: Section<{
      resources: {
        resourceId: string;
        ok: boolean;
        error?: string;
        metrics: { name: string; unit: string | null; average: number | null; maximum: number | null }[];
      }[];
    }>;
  };
  errors: Record<string, string> | null;
}

export interface OpenRouterPayload {
  ok: boolean;
  fetchedAt: string;
  hasManagementKey?: boolean;
  sections: {
    key?: Section<{ label: string | null; limit: number | null; usage: number | null; remaining: number | null }>;
    credits?: Section<{ totalCredits: number | null; totalUsage: number | null; remaining: number | null }>;
    activity?: Section<{
      points: { date: string; requests: number; usage: number }[];
      totals: { requests: number; usage: number };
    }>;
  };
  errors: Record<string, string> | null;
}

export interface SearchConsolePayload {
  ok: boolean;
  period?: { startDate: string; endDate: string };
  /** `ctr` is a ratio (0.0336), exactly as the Search Console API returns it. */
  totals?: { clicks: number; impressions: number; ctr: number; position: number };
  queries?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[];
  pages?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[];
  error?: string;
}

export interface Ga4Payload {
  ok: boolean;
  fetchedAt: string;
  period: { startDate: string; endDate: string };
  sections: {
    totals?: Section<{
      sessions: number | null;
      totalUsers: number | null;
      screenPageViews: number | null;
      engagementRate: number | null;
      averageSessionDuration: number | null;
    }>;
    topPages?: Section<{
      pages: { pagePath: string | null; screenPageViews: number | null; sessions: number | null }[];
    }>;
  };
  errors: Record<string, string> | null;
}

export interface AdSensePayload {
  ok: boolean;
  fetchedAt: string;
  period: { startDate: string; endDate: string };
  sections: {
    summary?: Section<{
      currency: string | null;
      estimatedEarnings: number | null;
      pageViews: number | null;
      impressions: number | null;
      clicks: number | null;
      rpm: number | null;
    }>;
    daily?: Section<{
      currency: string | null;
      days: {
        date: string;
        estimatedEarnings: number | null;
        pageViews: number | null;
        impressions: number | null;
        clicks: number | null;
      }[];
    }>;
  };
  errors: Record<string, string> | null;
}

export interface SimpleAnalyticsPayload {
  ok: boolean;
  fetchedAt: string;
  period: { startDate: string; endDate: string };
  sections: {
    summary?: Section<{
      visitors: number | null;
      pageviews: number | null;
      secondsOnPage: number | null;
    }>;
    daily?: Section<{ days: { date: string; pageviews: number; visitors: number }[] }>;
  };
  errors: Record<string, string> | null;
}

export interface SourcePayloadMap {
  azure: AzurePayload;
  openrouter: OpenRouterPayload;
  searchConsole: SearchConsolePayload;
  ga4: Ga4Payload;
  adsense: AdSensePayload;
  simpleAnalytics: SimpleAnalyticsPayload;
}

export async function fetchSource<K extends SourceKey>(
  source: K,
  signal?: AbortSignal,
): Promise<SourceEnvelope<SourcePayloadMap[K]>> {
  return json<SourceEnvelope<SourcePayloadMap[K]>>(
    await fetch(`/api/sources/${source}`, { signal, headers: { Accept: 'application/json' } }),
  );
}

export async function refreshSource<K extends SourceKey>(
  source: K,
  csrfToken: string,
  signal?: AbortSignal,
): Promise<RefreshResult<SourcePayloadMap[K]>> {
  const response = await fetch(`/api/sources/${source}/refresh`, {
    method: 'POST',
    signal,
    headers: { 'x-csrf-token': csrfToken, Accept: 'application/json' },
  });
  const body = (await response.json().catch(() => ({}))) as RefreshResult<SourcePayloadMap[K]>;
  // A 502 still carries a usable envelope (health + per-section errors), so it
  // is returned rather than thrown: the tile shows what failed, not a dead tile.
  if (response.status === 503) {
    throw new Error(body.message ?? 'source is not configured');
  }
  return body;
}


export async function saveEnvValues(
  csrfToken: string,
  values: Record<string, string>,
): Promise<{ applied: string[]; restartRequired: string[] }> {
  return json(
    await fetch('/api/admin/env', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
        Accept: 'application/json',
      },
      body: JSON.stringify(values),
    }),
  );
}
