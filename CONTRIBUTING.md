# Contributing

## Development setup

Requires Node.js >= 22.5.0 (the server uses `node:sqlite`).

```bash
npm ci
cp .env.example .env      # fill in COMPANY_NAME at minimum
npm run dev               # server + Vite dev server
```

Verification commands, matching CI:

```bash
npm run typecheck
npm test
npm run build
```

## Layout

- `server/` — Express (ESM) API. `server/src/sources/` holds one module per
  integration; every integration is optional and stays inert without its
  credentials.
- `web/` — React 19 + TypeScript + Vite 7 + Tailwind v4. Material 3 tokens are
  defined in CSS custom properties; never hardcode colours, use the tokens.
- `Dockerfile` — multi-stage build; the runtime image runs as a non-root user.

## Ground rules

- **Configuration is environment-only.** No config file mounting. New settings
  go in `server/src/lib/env-manifest.js` and `.env.example`.
- **`/api/admin/env` is write-only.** It may report whether a variable is set,
  never its value. Do not add a read path, and do not log values.
- **Never commit** `.env`, `data/`, or `.docs/`.
- **Never spawn `docker compose` from inside the web container.**
- **Every source stays optional.** A missing credential hides its widget; it
  must not break the dashboard or surface an error.
- **Keep the repo generic.** No company-specific identifiers, hostnames, or
  credentials in code, docs, tests, or fixtures.

## Pull requests

- Branch from `main`, keep the change focused, and describe what you verified.
- CI must pass: typecheck, tests, build, and the Docker image build.
- Add tests for new source modules and for config parsing changes.
