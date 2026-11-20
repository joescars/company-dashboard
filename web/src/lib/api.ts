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
