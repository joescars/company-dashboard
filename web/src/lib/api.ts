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

export async function fetchConfig(signal?: AbortSignal): Promise<PublicConfig> {
  const response = await fetch('/api/config', { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`config request failed: ${response.status}`);
  return (await response.json()) as PublicConfig;
}