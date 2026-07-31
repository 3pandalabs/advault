# API container (Coolify resource `advault-api`). Multi-stage: compile
# TypeScript in a full node image, run on a slim one.
#
# Deliberately does NOT install ffmpeg. Encoding belongs in the renderer
# (Dockerfile.renderer) — an API image with ffmpeg on PATH is an invitation to
# render inline, which pins a core for ~30s on a box shared with Postgres and
# three other apps.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle

# Coolify/Traefik terminates TLS in front of this container; it only ever needs
# to listen on plain HTTP inside the private Docker network.
RUN addgroup -S advault && adduser -S advault -G advault
USER advault

EXPOSE 8080

# Migrate-on-start, and ONLY here — Dockerfile.renderer deliberately does not
# migrate, or the two containers would race the same `drizzle` bookkeeping table
# on every deploy.
#
# Every migration in drizzle/ must be idempotent (CREATE TABLE IF NOT EXISTS,
# ADD COLUMN IF NOT EXISTS, DO $$ ... WHEN duplicate_object guards): a migration
# that fails on re-run crash-loops this container and takes the API down, which
# is exactly what happened to RentVault on 2026-07-24.
#
# migrate.js runs as the runtime role (DATABASE_URL). `advault_app` owns the
# `advault` database and can run DDL. Do NOT set MIGRATION_DATABASE_URL to a
# superuser: with no default privileges configured on the shared instance,
# tables it created would be owned by `postgres` and unreadable by the runtime
# role. See src/db/migrate.ts for the 42501 ownership gotcha.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
