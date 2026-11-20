/**
 * The environment manifest.
 *
 * Every variable the dashboard understands, grouped the way the operator
 * thinks about them. This list is the single source of truth for the admin
 * page: it drives the set/not-set table and the descriptions shown beside
 * each row.
 *
 * SECURITY: this module only ever describes *names*. It never holds, reads or
 * returns a value. The admin route reports whether a variable is set by
 * checking `process.env[name] !== undefined` — the value itself never leaves
 * the process.
 *
 * `live: true` means the variable is read per request and a write takes effect
 * immediately. `live: false` means it is read at boot, so a change needs a
 * restart. Almost everything here is boot-time because the config layer and
 * the session middleware resolve once at startup.
 */

export const ENV_GROUPS = [
  {
    id: 'company',
    label: 'Company & branding',
    variables: [
      {
        name: 'COMPANY_NAME',
        description: 'Shown in the header and browser tab. No company value is baked into the image.',
        live: false,
      },
      {
        name: 'COMPANY_SITE_URL',
        description: 'Canonical site URL, used to label links and build report links.',
        live: false,
      },
      {
        name: 'COMPANY_LOGO_URL',
        description: 'Optional URL or path to a logo served by the dashboard.',
        live: false,
      },
      {
        name: 'COMPANY_THEME_ACCENT',
        description: 'Material 3 accent color (default #0b57d0).',
        live: false,
      },
    ],
  },
  {
    id: 'app',
    label: 'Application',
    variables: [
      {
        name: 'PORT',
        description: 'Port the server listens on inside the container (default 8080).',
        live: false,
      },
      {
        name: 'NODE_ENV',
        description: 'Set to production in deployments; enables secure cookies and production warnings.',
        live: false,
      },
      {
        name: 'SESSION_SECRET',
        description: 'Signs session cookies. Generate with: openssl rand -hex 32.',
        live: false,
      },
      {
        name: 'COOKIE_SECURE',
        description: 'Set to false only when testing over plain HTTP on localhost; otherwise cookies require HTTPS.',
        live: false,
      },
    ],
  },
  {
    id: 'login',
    label: 'Login (Google OAuth)',
    variables: [
      {
        name: 'GOOGLE_CLIENT_ID',
        description: 'OAuth client ID from the Google Cloud console.',
        live: false,
      },
      {
        name: 'GOOGLE_CLIENT_SECRET',
        description: 'OAuth client secret from the Google Cloud console.',
        live: false,
      },
      {
        name: 'GOOGLE_CALLBACK_URL',
        description: 'Redirect URI registered for the OAuth client, e.g. https://dashboard.example.com/auth/google/callback.',
        live: false,
      },
      {
        name: 'ADMIN_EMAILS',
        description: 'Comma-separated Google accounts allowed to sign in and administer the instance.',
        live: false,
      },
    ],
  },
  {
    id: 'google',
    label: 'Google service account',
    variables: [
      {
        name: 'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64',
        description: 'Service-account key JSON as base64. One account can cover Search Console, Analytics and AdSense.',
        live: false,
      },
    ],
  },
  {
    id: 'searchConsole',
    label: 'Google Search Console',
    variables: [
      {
        name: 'GSC_SITE_URL',
        description: 'Property as it appears in Search Console, e.g. sc-domain:example.com.',
        live: false,
      },
    ],
  },
  {
    id: 'ga4',
    label: 'Google Analytics 4',
    variables: [
      {
        name: 'GA4_PROPERTY_ID',
        description: 'Numeric GA4 property ID.',
        live: false,
      },
    ],
  },
  {
    id: 'adsense',
    label: 'Google AdSense',
    variables: [
      {
        name: 'ADSENSE_ACCOUNT_ID',
        description: 'AdSense publisher account ID (pub-…).',
        live: false,
      },
    ],
  },
  {
    id: 'simpleAnalytics',
    label: 'Simple Analytics',
    variables: [
      {
        name: 'SIMPLE_ANALYTICS_SITE',
        description: 'Site identifier in Simple Analytics.',
        live: false,
      },
      {
        name: 'SIMPLE_ANALYTICS_API_KEY',
        description: 'API key for the Simple Analytics stats endpoint.',
        live: false,
      },
    ],
  },
  {
    id: 'azure',
    label: 'Azure (Foundry / Cost Management)',
    variables: [
      {
        name: 'AZURE_TENANT_ID',
        description: 'Entra tenant ID for the service principal.',
        live: false,
      },
      {
        name: 'AZURE_CLIENT_ID',
        description: 'Service-principal application (client) ID.',
        live: false,
      },
      {
        name: 'AZURE_CLIENT_SECRET',
        description: 'Service-principal client secret.',
        live: false,
      },
      {
        name: 'AZURE_SUBSCRIPTION_ID',
        description: 'Subscription to read Cost Management data from.',
        live: false,
      },
      {
        name: 'AZURE_RESOURCE_IDS',
        description: 'Comma-separated resource IDs to report AI usage for.',
        live: false,
      },
      {
        name: 'AZURE_BILLING_DAY_OF_MONTH',
        description: 'Day of month the Azure billing period rolls over (1-28; default 1).',
        live: false,
      },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    variables: [
      {
        name: 'OPENROUTER_API_KEY',
        description: 'Regular inference key; enables per-key usage.',
        live: false,
      },
      {
        name: 'OPENROUTER_MANAGEMENT_KEY',
        description: 'Management key; additionally enables account balance and 30-day per-model activity.',
        live: false,
      },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    variables: [
      {
        name: 'SOURCES_ENABLED',
        description: 'Optional explicit source toggles. Comma-separated, e.g. azure,searchConsole,ga4. Default: enabled when credentials are present.',
        live: false,
      },
      {
        name: 'COMPANY_CONFIG_PATH',
        description: 'Optional path to a config file mounted into the container. Env vars win when both are set.',
        live: false,
      },
    ],
  },
];

/** Flattened list, for lookups and tests. */
export const ENV_VARIABLES = ENV_GROUPS.flatMap((group) =>
  group.variables.map((variable) => ({ ...variable, group: group.id })),
);

/**
 * Report set/not-set for every variable. Values are never read, only presence.
 * A variable set to an empty string counts as "not set" — that is how the
 * .env template represents "leave blank to disable".
 */
export function manifestStatus(env = process.env) {
  return ENV_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    variables: group.variables.map((variable) => ({
      name: variable.name,
      description: variable.description,
      live: variable.live,
      set: Boolean(env[variable.name]),
    })),
  }));
}

/** Names only — used to validate incoming writes. */
export function knownVariableNames() {
  return new Set(ENV_VARIABLES.map((variable) => variable.name));
}
