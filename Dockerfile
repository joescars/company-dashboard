# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — builder
#
# Installs every workspace dependency (server + web, dev included) and produces
# the built SPA at web/dist. The web toolchain (Vite/TypeScript/Tailwind) is
# only needed here, never in the runtime image.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy only the manifests first so the dependency layer is cached independently
# of source changes.
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json

# Deterministic, offline-safe install of all workspaces.
RUN npm ci --include=dev

# Now copy the rest of the sources and build the SPA bundle.
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — runtime
#
# Production dependencies only (no Vite/TypeScript/dev tooling) plus the built
# assets. Nothing company-specific is present: every value arrives via env vars
# at runtime. The base image satisfies node:sqlite (Node >= 22.5).
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

# Re-resolve production-only dependencies in a clean tree. npm workspaces
# hoists into the root node_modules, so installing the manifests here gives the
# runtime exactly what it needs — no dev dependencies.
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
RUN npm ci --omit=dev --workspace server --include-workspace-root && npm cache clean --force

# Application code and built assets from the builder stage.
COPY server ./server
COPY config ./config
COPY --from=builder /app/web/dist ./web/dist

# Writable data dir for the SQLite cache, owned by the non-root runtime user.
# The node image already ships uid/gid 1000 named "node"; we standardise on
# uid 1001 ('app') so the mount point is unambiguous.
RUN mkdir -p /app/data \
    && chown -R 1001:1001 /app/data

USER 1001:1001

# The SQLite cache lives here; mount a volume so it survives container swaps.
VOLUME ["/app/data"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]