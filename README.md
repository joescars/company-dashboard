# Company Dashboard

A self-hosted dashboard that pulls a company's key web metrics into one view: **site
traffic, search rank positions, ad revenue, and AI spend**. It is company-agnostic — the
company name, branding, and every integration ID are configuration, so any organization
using the same services can run its own instance from the same image.

It ships as a **Docker image**: pull the image, set your `.env`, run the container. No
Node install, no build step, no source checkout.

## What it aggregates

| Category | Source |
|---|---|
| Site traffic | **Google Analytics 4** |
| Site traffic | **Simple Analytics** |
| Search rank positions | **Google Search Console** |
| Ad revenue | **Google AdSense** |
| AI spend | **Azure (Foundry / Cost Management)** |
| AI spend | **OpenRouter** |

Every source is **optional**. An instance enables only the sources it has credentials for;
the others are simply not shown. A company that runs no ads has no AdSense tile.

## Design goals

- **Configurable, not forked.** Company name, branding, and all per-source IDs come from
  environment variables (an optional config file is supported for advanced setups).
  Nothing company-specific is hardcoded into the image.
- **Deploy by pulling an image.** The supported install is: pull → configure `.env` → run.
- **One page, many sources, degrade per tile.** The overview fans out to every enabled
  source in parallel; one failing API never blanks the dashboard.
- **Honest numbers.** Each tile carries a freshness label and distinguishes *actual billed*
  from *estimated*, per the lag of each provider's reporting.
- **Self-hosted and private.** Billing and raw query data stay on your machine; access is
  behind login.

## Quick start (Docker)

```sh
# 1. Get the env template and fill it in (company name, IDs, credentials).
curl -fsSLO https://raw.githubusercontent.com/joescars/company-dashboard/main/.env.example
cp .env.example .env
$EDITOR .env                 # set COMPANY_NAME and the sources you have
chmod 600 .env

# 2. Run the published image.
docker run -d --name company-dashboard \
  --env-file .env \
  -p 8080:8080 \
  -v company-dashboard-data:/app/data \
  --restart unless-stopped \
  ghcr.io/joescars/company-dashboard:latest

# 3. Open http://localhost:8080 and sign in with an address in ADMIN_EMAILS.
```

### docker compose

```yaml
services:
  dashboard:
    image: ghcr.io/joescars/company-dashboard:latest
    env_file: .env
    ports: ["8080:8080"]
    volumes: ["dashboard-data:/app/data"]
    restart: unless-stopped
volumes:
  dashboard-data:
```

## Configuration

All configuration is environment variables. `.env.example` documents every one.

- **Company + branding:** `COMPANY_NAME`, `COMPANY_SITE_URL`, `COMPANY_LOGO_URL`,
  `COMPANY_THEME_ACCENT`.
- **Per-source IDs:** e.g. `GA4_PROPERTY_ID`, `GSC_SITE_URL`, `ADSENSE_ACCOUNT_ID`,
  `SIMPLE_ANALYTICS_SITE`, `AZURE_RESOURCE_IDS`.
- **Credentials:** OAuth client, Google service-account JSON (base64), Azure service
  principal, OpenRouter keys, Simple Analytics key.
- **Enable/disable a source:** leave its variables blank to hide it, or set
  `SOURCES_ENABLED` explicitly.

An optional `config/company.json` (mounted into the container) can be used instead of the
company/ID env vars for advanced or version-controlled setups; see
`config/company.example.json`. Env vars take precedence when both are present.

## Privacy

Search Console query data can contain personal names. Raw query rows are cached locally
only (in the container's `data/` volume) and are never committed or published; only
filtered aggregates are shown.

## Development

Source checkout and local build are supported for contributors; see `CONTRIBUTING.md`.
End users should not need to build.

## License

See `LICENSE`.