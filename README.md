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
  environment variables. Nothing company-specific is hardcoded into the image.
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

# 2. Run the published image (replace OWNER with the publishing org/user).
docker run -d --name company-dashboard \
  --env-file .env \
  -p 8080:8080 \
  -v company-dashboard-data:/app/data \
  --restart unless-stopped \
  ghcr.io/OWNER/company-dashboard:latest

# 3. Open http://localhost:8080 and sign in with an address in ADMIN_EMAILS.
```

### docker compose

```yaml
services:
  dashboard:
    image: ghcr.io/OWNER/company-dashboard:latest
    env_file: .env
    ports: ["8080:8080"]
    volumes: ["dashboard-data:/app/data"]
    restart: unless-stopped
volumes:
  dashboard-data:
```

## Configuration

All configuration is environment variables. `.env.example` documents every one, and
**[docs/CREDENTIALS.md](docs/CREDENTIALS.md)** is a step-by-step guide to obtaining each
credential (where to click, what the IDs look like, and what permissions to grant).

- **Company + branding:** `COMPANY_NAME`, `COMPANY_SITE_URL`, `COMPANY_LOGO_URL`,
  `COMPANY_THEME_ACCENT`.
- **Per-source IDs:** e.g. `GA4_PROPERTY_ID`, `GSC_SITE_URL`, `ADSENSE_ACCOUNT_ID`,
  `SIMPLE_ANALYTICS_SITE`, `AZURE_RESOURCE_IDS`.
- **Credentials:** OAuth client, Google service-account JSON (base64), Azure service
  principal, OpenRouter keys, Simple Analytics key.
- **Enable/disable a source:** leave its variables blank to hide it, or set
  `SOURCES_ENABLED` explicitly.

### Which credentials do I need?

| Source | Credentials required |
|---|---|
| Login (all setups) | Google OAuth client — `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `ADMIN_EMAILS` |
| Search Console | Service account + `GSC_SITE_URL` |
| Google Analytics 4 | Service account + `GA4_PROPERTY_ID` |
| AdSense | Service account + `ADSENSE_ACCOUNT_ID` |
| Simple Analytics | `SIMPLE_ANALYTICS_API_KEY` + `SIMPLE_ANALYTICS_SITE` |
| Azure | Service principal + `AZURE_SUBSCRIPTION_ID` + `AZURE_RESOURCE_IDS` |
| OpenRouter | `OPENROUTER_API_KEY` (management key optional) |

Plus, always: `SESSION_SECRET` (generate with `openssl rand -hex 32`).

Each credential is obtained differently and the details matter — a service account must be
*granted access* per property, not just created. See
**[docs/CREDENTIALS.md](docs/CREDENTIALS.md)** for the full walkthrough, and for the
troubleshooting table covering the usual failures (redirect loops, `redirect_uri_mismatch`,
a tile that stays empty because a role is missing).

## Privacy

Search Console query data can contain personal names. Raw query rows are cached locally
only (in the container's `data/` volume) and are never committed or published; only
filtered aggregates are shown.

## Development

Source checkout and local build are supported for contributors; see `CONTRIBUTING.md`.
End users should not need to build.

**Releasing:** images are published by GitHub Actions — pushing a release tag builds
multi-arch (linux/amd64 + linux/arm64) images and pushes them to GHCR. There is no
local/manual image build in the release path.

## License

See `LICENSE`.