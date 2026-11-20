import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve all instance configuration.
 *
 * Precedence (highest first):
 *   1. environment variables
 *   2. config/company.json (optional mounted override)
 *   3. built-in defaults
 *
 * No company-specific value is ever baked into the image; a deployment with
 * nothing set still boots with generic defaults.
 */

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), 'config/company.json');

/** Source keys used throughout the app. */
export const SOURCES = ['azure', 'openrouter', 'searchConsole', 'ga4', 'adsense', 'simpleAnalytics'];

function readConfigFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    // A malformed optional override must not take the app down, but the
    // operator needs to know it was ignored.
    // eslint-disable-next-line no-console
    console.warn(`[config] ignoring ${filePath}: ${error.message}`);
    return {};
  }
}

/** Treat empty / whitespace-only env values as "unset". */
function envStr(name) {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
}

function envList(name) {
  const value = envStr(name);
  return value ? value.split(',').map((entry) => entry.trim()).filter(Boolean) : undefined;
}

/**
 * A source is enabled only when it has the credentials it needs. Identifiers
 * alone (or defaults) are not enough — a half-filled config must hide the tile
 * rather than render a broken one.
 */
function resolveSources(fileSources = {}, env = {}) {
  const explicit = env.SOURCES_ENABLED;
  const resolved = {};

  for (const key of SOURCES) {
    const fileEntry = fileSources[key] || {};
    const identifiers = idsFor(key, env, fileEntry);
    const hasCredentials = checkCredentials(key, env);
    const hasIdentifiers = hasRequiredIdentifiers(key, identifiers);

    // Explicit enable still requires credentials; otherwise the source is on
    // only when it is both credentialed and identified.
    const enabled = explicit ? explicit.includes(key) && hasCredentials : hasCredentials && hasIdentifiers;

    resolved[key] = { enabled, config: identifiers };
  }

  return resolved;
}

function idsFor(key, env, fileEntry = {}) {
  switch (key) {
    case 'azure':
      return {
        subscriptionId: env.AZURE_SUBSCRIPTION_ID ?? fileEntry.subscriptionId ?? null,
        resourceIds: envList('AZURE_RESOURCE_IDS') ?? fileEntry.resourceIds ?? [],
        billingDayOfMonth: Number(env.AZURE_BILLING_DAY_OF_MONTH ?? fileEntry.billingDayOfMonth ?? 1),
      };
    case 'openrouter':
      return {
        hasManagementKey: Boolean(env.OPENROUTER_MANAGEMENT_KEY),
      };
    case 'searchConsole':
      return { siteUrl: env.GSC_SITE_URL ?? fileEntry.siteUrl ?? null };
    case 'ga4':
      return { propertyId: env.GA4_PROPERTY_ID ?? fileEntry.propertyId ?? null };
    case 'adsense':
      return { accountId: env.ADSENSE_ACCOUNT_ID ?? fileEntry.accountId ?? null };
    case 'simpleAnalytics':
      return { site: env.SIMPLE_ANALYTICS_SITE ?? fileEntry.site ?? null };
    default:
      return {};
  }
}

function checkCredentials(key, env) {
  switch (key) {
    case 'azure':
      return Boolean(env.AZURE_TENANT_ID && env.AZURE_CLIENT_ID && env.AZURE_CLIENT_SECRET);
    case 'openrouter':
      return Boolean(env.OPENROUTER_API_KEY);
    case 'searchConsole':
    case 'ga4':
    case 'adsense':
      return Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64);
    case 'simpleAnalytics':
      return Boolean(env.SIMPLE_ANALYTICS_API_KEY);
    default:
      return false;
  }
}

/** Required, non-secret identifiers per source (credentials are checked separately). */
function hasRequiredIdentifiers(key, identifiers) {
  switch (key) {
    case 'azure':
      return Boolean(identifiers.subscriptionId) && identifiers.resourceIds.length > 0;
    case 'openrouter':
      // The API key is the whole requirement; no extra identifiers needed.
      return true;
    case 'searchConsole':
      return Boolean(identifiers.siteUrl);
    case 'ga4':
      return Boolean(identifiers.propertyId);
    case 'adsense':
      return Boolean(identifiers.accountId);
    case 'simpleAnalytics':
      return Boolean(identifiers.site);
    default:
      return false;
  }
}

export function loadConfig({ configPath } = {}) {
  const filePath = configPath || envStr('COMPANY_CONFIG_PATH') || DEFAULT_CONFIG_PATH;
  const file = readConfigFile(filePath);

  const env = {
    COMPANY_NAME: envStr('COMPANY_NAME'),
    COMPANY_SITE_URL: envStr('COMPANY_SITE_URL'),
    COMPANY_LOGO_URL: envStr('COMPANY_LOGO_URL'),
    COMPANY_THEME_ACCENT: envStr('COMPANY_THEME_ACCENT'),
    SOURCES_ENABLED: envList('SOURCES_ENABLED'),
    AZURE_SUBSCRIPTION_ID: envStr('AZURE_SUBSCRIPTION_ID'),
    AZURE_RESOURCE_IDS: envStr('AZURE_RESOURCE_IDS'),
    AZURE_BILLING_DAY_OF_MONTH: envStr('AZURE_BILLING_DAY_OF_MONTH'),
    AZURE_TENANT_ID: envStr('AZURE_TENANT_ID'),
    AZURE_CLIENT_ID: envStr('AZURE_CLIENT_ID'),
    AZURE_CLIENT_SECRET: envStr('AZURE_CLIENT_SECRET'),
    OPENROUTER_API_KEY: envStr('OPENROUTER_API_KEY'),
    OPENROUTER_MANAGEMENT_KEY: envStr('OPENROUTER_MANAGEMENT_KEY'),
    GSC_SITE_URL: envStr('GSC_SITE_URL'),
    GA4_PROPERTY_ID: envStr('GA4_PROPERTY_ID'),
    ADSENSE_ACCOUNT_ID: envStr('ADSENSE_ACCOUNT_ID'),
    SIMPLE_ANALYTICS_SITE: envStr('SIMPLE_ANALYTICS_SITE'),
    SIMPLE_ANALYTICS_API_KEY: envStr('SIMPLE_ANALYTICS_API_KEY'),
    GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: envStr('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64'),
  };

  return {
    companyName: env.COMPANY_NAME ?? file.companyName ?? 'Company Dashboard',
    siteUrl: env.COMPANY_SITE_URL ?? file.siteUrl ?? null,
    logoUrl: env.COMPANY_LOGO_URL ?? file.logoUrl ?? null,
    theme: {
      accent: env.COMPANY_THEME_ACCENT ?? file.theme?.accent ?? '#0b57d0',
    },
    sources: resolveSources(file.sources, env),
  };
}

/**
 * The safe subset sent to the browser: what the UI needs to render, never a
 * credential or secret. Deliberately omits subscription/resource IDs.
 */
export function publicConfig(config) {
  return {
    companyName: config.companyName,
    siteUrl: config.siteUrl,
    logoUrl: config.logoUrl,
    theme: config.theme,
    sources: Object.fromEntries(
      SOURCES.map((key) => [key, { enabled: Boolean(config.sources[key]?.enabled) }]),
    ),
  };
}