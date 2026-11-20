# Company Dashboard

A self-hosted dashboard that pulls a company's key web metrics into one view: **site
traffic, search rank positions, ad revenue, and AI spend**. It is company-agnostic — the
company name, branding, and every integration ID are configuration, so any organization
using the same services can run its own instance from the same code.

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

- **Configurable, not forked.** Company name, logo, theme accent, and per-source IDs live
  in `config/company.json`. Nothing company-specific is hardcoded.
- **One page, many sources, degrade per tile.** The overview fans out to every enabled
  source in parallel; one failing API never blanks the dashboard.
- **Honest numbers.** Each tile carries a freshness label and distinguishes *actual billed*
  from *estimated*, per the lag of each provider's reporting.
- **Self-hosted and private.** Billing and raw query data stay on your machine; access is
  behind login.

## Status

Early — under active development. The architecture and integration plan are set; see
`docs/` as components land.

## Install (planned)

```sh
git clone <this-repo> company-dashboard
cd company-dashboard
cp .env.example .env                 # fill in credentials
cp config/company.example.json config/company.json   # set your company + IDs
# docker compose up -d --build
```

## Configuration

- **`config/company.json`** — company name, branding, and which sources are enabled, each
  with its non-secret identifiers (e.g. a GA4 property ID, a Search Console property, an
  AdSense account ID). Copy `config/company.example.json` to start.
- **`.env`** — all credentials. Copy `.env.example`, which documents every variable name
  and what it is for. Keep it mode `600`; never commit it.

## Privacy

Search Console query data can contain personal names. Raw query rows are cached locally
only (gitignored) and are never committed or published; only filtered aggregates are shown.

## License

See `LICENSE`.