# Getting started — credentials

Everything the dashboard needs lives in **one `.env` file**. There is no config file
to mount and no account to sign up for beyond the services you already use.

**Every source is optional.** Fill in only the groups you want; anything left blank is
disabled and simply does not appear on the dashboard. A misconfigured source is never a
broken page — it is a hidden tile.

---

## Contents

1. [Minimum viable setup](#1-minimum-viable-setup) — the 5 minutes before you can log in
2. [Choosing which sources to run](#2-choosing-which-sources-to-run)
3. [Google OAuth (login)](#3-google-oauth--login)
4. [Google service account (Search Console, Analytics, AdSense)](#4-google-service-account)
5. [Google Search Console](#5-google-search-console)
6. [Google Analytics 4](#6-google-analytics-4)
7. [Google AdSense](#7-google-adsense)
8. [Simple Analytics](#8-simple-analytics)
9. [Azure — Foundry / Cost Management](#9-azure--foundry--cost-management)
10. [OpenRouter](#10-openrouter)
11. [Troubleshooting](#troubleshooting)

---

## 1. Minimum viable setup

You can boot the dashboard with no integrations at all and add them later.

```sh
curl -fsSLO https://raw.githubusercontent.com/OWNER/company-dashboard/main/.env.example
cp .env.example .env
chmod 600 .env
```

Then set these five values:

| Variable | What to put |
|---|---|
| `COMPANY_NAME` | Your company name. Shown in the header and browser tab. |
| `COMPANY_SITE_URL` | Your canonical site URL, e.g. `https://example.com`. |
| `SESSION_SECRET` | Output of `openssl rand -hex 32`. |
| `ADMIN_EMAILS` | Your Google address — the account allowed to log in. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL` | See [§3](#3-google-oauth--login). |

`ADMIN_EMAILS` and the OAuth trio are what make login work. Without them the sign-in page
says the instance is not configured rather than showing a dead button.

Three optional cosmetics, all safe to leave out:

```sh
# A logo shown in the header. URL or path served by the dashboard.
COMPANY_LOGO_URL=
# Material 3 accent colour (default #0b57d0, Google blue).
COMPANY_THEME_ACCENT=#0b57d0
# Port inside the container. Only change it if you also remap with -p.
PORT=8080
```

Run it:

```sh
docker run -d --name company-dashboard \
  --env-file .env \
  -p 8080:8080 \
  -v company-dashboard-data:/app/data \
  --restart unless-stopped \
  ghcr.io/OWNER/company-dashboard:latest
```

Open <http://localhost:8080> and sign in. The dashboard renders with zero tiles until you
add a source.

> **Testing over plain HTTP?** Cookies are marked `Secure` whenever `NODE_ENV=production`,
> so on `http://localhost` set `COOKIE_SECURE=false` or you will get a login redirect loop.
> Never set it on a real deployment.

---

## 2. Choosing which sources to run

You do **not** need to declare which sources are on. A source turns itself on when its
credentials and IDs are present, and stays hidden otherwise.

| Source | Turns on when all of these are set |
|---|---|
| Search Console | `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` + `GSC_SITE_URL` |
| Google Analytics 4 | `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` + `GA4_PROPERTY_ID` |
| AdSense | `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` + `ADSENSE_ACCOUNT_ID` |
| Simple Analytics | `SIMPLE_ANALYTICS_API_KEY` + `SIMPLE_ANALYTICS_SITE` |
| Azure | `AZURE_TENANT_ID` + `AZURE_CLIENT_ID` + `AZURE_CLIENT_SECRET` + `AZURE_SUBSCRIPTION_ID` + `AZURE_RESOURCE_IDS` |
| OpenRouter | `OPENROUTER_API_KEY` |

Optional override: `SOURCES_ENABLED` takes an explicit comma-separated list using the keys
`azure`, `openrouter`, `searchConsole`, `ga4`, `adsense`, `simpleAnalytics`. Note it can only
*narrow* the list — naming a source there that has no credentials will not turn it on.

---

## 3. Google OAuth — login

This is how **you** sign in. It is separate from the service account in §4, which is how the
dashboard reads data. You need both.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create (or pick) a project.
2. **APIs & Services → OAuth consent screen.** Choose *Internal* if you have Google Workspace
   (simplest — no verification needed), otherwise *External* and add yourself as a test user.
   Fill in the app name and support email.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID.**
4. Application type: **Web application**.
5. Under **Authorized redirect URIs**, add exactly the callback your instance will serve:
   - Local testing: `http://localhost:8080/auth/google/callback`
   - Production: `https://dashboard.yourdomain.com/auth/google/callback`

   It must match `GOOGLE_CALLBACK_URL` character for character, including scheme and trailing
   path. A mismatch is the single most common cause of `redirect_uri_mismatch`.
6. Copy the client ID and secret into `.env`:

```sh
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxx
GOOGLE_CALLBACK_URL=https://dashboard.yourdomain.com/auth/google/callback
ADMIN_EMAILS=you@example.com,teammate@example.com
```

`ADMIN_EMAILS` is a comma-separated allowlist, re-checked on every login. Only these
addresses get in — everyone else is rejected (`?auth=denied`).

---

## 4. Google service account

One service account covers Search Console, Analytics and AdSense. This is a **robot
identity**, not your own account, so no personal token expires or needs re-consenting.

1. In the same Cloud project: **APIs & Services → Library**, and enable each API you need:
   - *Google Search Console API*
   - *Google Analytics Data API*
   - *AdSense Management API*
2. **IAM & Admin → Service Accounts → Create service account.** Name it something like
   `dashboard-reader`. No IAM roles are required at the project level.
3. Open it → **Keys → Add key → Create new key → JSON**. A `.json` file downloads.
4. Convert it to base64 and paste the result into `.env` as one long line:

```sh
base64 -w0 service-account.json
# on macOS use: base64 -i service-account.json
```

```sh
GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=eyJ0eXBlIjoic2VydmljZV9hY2NvdW50Iiwi...
```

5. **Grant the robot access, per service.** Creating the key is not enough — the service
   account has no access to anything until you invite it. Copy its email
   (`dashboard-reader@your-project.iam.gserviceaccount.com`) and:

   - **Search Console:** for each property, *Settings → Users and permissions → Add user*,
     paste the service-account email, permission **Full** or **Restricted** (read is enough).
   - **Analytics:** in GA4 *Admin → Property access management → Add users*, paste the
     service-account email, role **Viewer**.
   - **AdSense:** *Account → Access and authorization → Users → Add user*, paste the
     service-account email, role **Reporting**.

> A service account added at the *account* level in Analytics but not the *property* level
> will return empty data, not an error. Grant it on the property.

---

## 5. Google Search Console

Reads the last 28 days of impressions, clicks and average position, broken down by query
and by page.

**You need:**

```sh
GSC_SITE_URL=sc-domain:example.com
```

This must match the property **exactly as it is written in Search Console**. There are two
forms and they are not interchangeable:

| In Search Console | Use |
|---|---|
| *Domain property* covering all subdomains and protocols | `sc-domain:example.com` |
| *URL-prefix property* | `https://example.com/` — with scheme and trailing slash |

Open Search Console → the property dropdown shows both forms verbatim. Copy from there.

The service account from §4 must be a user on this property, or the dashboard reports the
site is not available to the service account.

> **Privacy:** Search Console query data can contain personal names. Raw query rows are
> cached locally in the container's `data/` volume only and never leave your machine.

---

## 6. Google Analytics 4

Reads sessions, users, pageviews and engagement for a property.

**You need the numeric property ID**, not the `G-XXXXXXX` measurement ID:

```sh
GA4_PROPERTY_ID=123456789
```

Find it in GA4: **Admin → Property settings → Property details**, or the property dropdown
at the top left — the number after `properties/` in its URL (`.../a123456789p123456789/`).

Enable the *Google Analytics Data API* in the Cloud project (§4 step 1) and add the service
account as a **Viewer** on the property.

---

## 7. Google AdSense

Reads estimated earnings, page views and impressions.

**You need your publisher account ID:**

```sh
ADSENSE_ACCOUNT_ID=pub-1234567890123456
```

It is shown in AdSense under **Account → Account information**, and also appears in the ad
code snippet you paste into your site. Include the `pub-` prefix.

Enable the *AdSense Management API* and add the service account as a **Reporting** user (§4).

> AdSense earnings are **estimates** and typically finalise a day or two behind. The tile
> labels this rather than presenting estimates as settled revenue. Requiring AdSense and
> being approved for it are separate — an unapproved account returns no data.

---

## 8. Simple Analytics

A cookie-free, privacy-focused analytics provider. If you use it instead of (or as well as)
GA4:

**You need the site identifier and an API key:**

```sh
SIMPLE_ANALYTICS_SITE=example.com
SIMPLE_ANALYTICS_API_KEY=sa_xxxxxxxxxxxxxxxx
```

- The **site** is the domain as registered in your Simple Analytics dashboard (with or
  without `www` — match what the dashboard lists).
- The **API key** comes from *Settings → API keys* in Simple Analytics. This is a paid-plan
  feature; the stats endpoint requires it.

---

## 9. Azure — Foundry / Cost Management

Reports AI spend and resource usage from Azure Monitor and Cost Management.

### Create a service principal

The dashboard authenticates with a client secret, so you need an app registration with
credentials. In the [Azure portal](https://portal.azure.com/):

1. **Microsoft Entra ID → App registrations → New registration.** Name it
   `company-dashboard-reader`. No redirect URI needed.
2. Copy the **Application (client) ID** and **Directory (tenant) ID** from the overview.
3. **Certificates & secrets → New client secret.** Copy the **Value** immediately — it is
   hidden once you leave the page. (The *Secret ID* is not what you want.)

```sh
AZURE_TENANT_ID=00000000-0000-0000-0000-000000000000
AZURE_CLIENT_ID=00000000-0000-0000-0000-000000000000
AZURE_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Grant the two roles

Two different roles at two different scopes. Missing either means that half of the tile is
empty.

1. **Cost Management Reader** — at the **subscription** scope, so billing can be read.
   Subscriptions → your subscription → *Access control (IAM) → Add role assignment* →
   search *Cost Management Reader* → assign to the app registration.

2. **Monitoring Reader** — on each resource you want usage for. Open the resource (e.g. an
   Azure OpenAI / Foundry deployment) → *Access control (IAM) → Add role assignment* →
   *Monitoring Reader*.

```sh
AZURE_SUBSCRIPTION_ID=00000000-0000-0000-0000-000000000000
AZURE_RESOURCE_IDS=/subscriptions/.../resourceGroups/.../providers/Microsoft.CognitiveServices/accounts/my-ai
AZURE_BILLING_DAY_OF_MONTH=1
```

`AZURE_SUBSCRIPTION_ID` is on the subscription's overview page. `AZURE_RESOURCE_IDS` is a
**comma-separated** list of full resource IDs — not their names. Get one from the resource's
*Properties → Resource ID*.

> Cost Management frequently returns HTTP 429 when throttled. The dashboard treats that as
> transient and still renders usage data independently rather than blanking the tile.

---

## 10. OpenRouter

Reports credit balance, per-key usage and 30-day per-model activity.

1. Sign in at [openrouter.ai](https://openrouter.ai/).
2. **Keys** page → *Create key* for the inference key:

```sh
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxx
```

3. A **management key** is optional and adds account balance and per-model activity:

```sh
OPENROUTER_MANAGEMENT_KEY=xxxxxxxx
```

Management keys are provisioned separately from the OpenRouter provisioning API; if you only
have a normal key, leave this blank and the per-key usage sections still work.

> The two keys are not interchangeable, and the management key is not a substitute for the
> inference key — set `OPENROUTER_API_KEY` either way.

---

## Troubleshooting

**Sign-in redirect loop.** `NODE_ENV=production` with `COOKIE_SECURE` unset over plain HTTP.
Set `COOKIE_SECURE=false` for local testing only.

**`redirect_uri_mismatch` on Google login.** The redirect URI in the Cloud console does not
match `GOOGLE_CALLBACK_URL`. They must be identical.

**Signed out after every restart.** `SESSION_SECRET` is unset, so an ephemeral secret is
generated each boot. Set it and restart.

**A source is missing entirely.** One of its required variables in the §2 table is blank.
A variable set to an empty string counts as unset.

**A source is on but returns no data.** Almost always a missing grant, not a code problem.
Recheck that the service account was invited *on the specific property/account*, and that
the right API is enabled in the Cloud project.

**Search Console says the site is unavailable.** `GSC_SITE_URL` does not exactly match the
property string, or the service account was not added to it.

**Azure billing tile is empty, usage is fine.** The service principal is missing
**Cost Management Reader** at the subscription scope. Retry after a minute — throttling
(HTTP 429) is treated as transient.

**Checking what the app sees.** The admin page at `/admin/env` lists every variable and
whether it is set. It is **write-only** by design: it reports set/not-set and can update
values, but never displays an existing value.