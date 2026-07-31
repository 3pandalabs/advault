# AdVault

**AdVault by 3PandaLabs** — self-serve, hyper-local YouTube & Shorts advertising
for small local businesses.

Upload a few storefront photos, pick the zip codes you actually serve, set a
daily budget. AdVault writes the script, renders a 16:9 pre-roll and a 9:16
Shorts creative, and launches a geotargeted Google Ads campaign from your own
ad account.

- Web: https://advault.3pandalabs.com
- API: https://api.advault.3pandalabs.com

## Layout

```
web/     Next.js 16 (App Router) → Cloudflare Workers via @opennextjs/cloudflare
api/     Fastify 5 + Drizzle + Postgres, two containers from one workspace:
           Dockerfile           → advault-api      (HTTP, port 8080)
           Dockerfile.renderer  → advault-renderer (ffmpeg job worker)
infra/   Provisioning runbooks (Postgres, R2, Coolify, Google Ads, web deploy)
```

Conventions, gotchas and the security model live in [CLAUDE.md](CLAUDE.md).
Org-wide standards live in `3pandalabs/knowledge_base`.

## Local development

Postgres:

```bash
cd api
docker compose -f docker-compose.dev.yml up -d
```

API (port 8080):

```bash
cd api
cp .env.example .env        # then fill in JWT_SECRET, TOKEN_ENCRYPTION_KEY, R2_*
npm install
npm run db:migrate
npm run dev
```

Renderer (separate terminal — needs `ffmpeg` on PATH):

```bash
cd api
npm run dev:renderer
```

Web (port 3000):

```bash
cd web
npm install
npm run dev
```

## Deploying

There is no auto-deploy anywhere in the org. The API and renderer each deploy
from a button in Coolify; the web app deploys with `npm run cf:deploy` from
`web/`. See `infra/`.
