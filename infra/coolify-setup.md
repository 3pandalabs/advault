# Coolify — DNS, two containers, env vars

AdVault is the first 3PandaLabs app with **two** backend containers built from
one `api/` workspace. Create them both.

## 1. DNS first — before any deploy

The ACME challenge needs the hostname to resolve, so do this before pointing
Coolify at the repo.

Cloudflare DNS, both A records → `167.233.223.241`:

| Record | Proxy | Why |
|---|---|---|
| `api.advault` | **Proxied (orange)** | The public API hostname the browser calls. |
| `api-internal.advault` | **DNS-only (grey)** | Server-side Worker calls. Cloudflare blocks same-account "orange-to-orange" fetches before any WAF rule can allow them. |

Do **not** create a record for `advault.3pandalabs.com` — wrangler owns that one
(see [web-deploy.md](web-deploy.md)).

The grey-cloud record bypasses the Hetzner firewall's Cloudflare-only source
restriction, so `api-internal` **will time out from a dev laptop**. That is the
firewall working, not a fault. Test it from the box with a `Host:` header.

## 2. `advault-api`

Coolify → New Resource → Application → Public Repository →
`https://github.com/3pandalabs/advault`.

| Setting | Value |
|---|---|
| Branch | `main` |
| Build Pack | Dockerfile |
| **Base Directory** | `api` |
| **Dockerfile Location** | `Dockerfile` |
| Ports Exposes | `8080` |
| Domains | `https://api.advault.3pandalabs.com`, `https://api-internal.advault.3pandalabs.com` |

**Dockerfile Location is `Dockerfile`, not `api/Dockerfile`** — it is relative
to the Base Directory, so the latter resolves to `api/api/Dockerfile`. Enter
both domains **with the `https://` scheme**.

The repo must be **public**, and `main` must already contain `api/`. Coolify's
"Public Repository" source carries no credentials, so a private repo fails the
first deploy with `could not read Username` — not an obvious error message for
"your repo is private".

### Environment variables

```
DATABASE_URL=postgres://advault_app:<password>@<postgres-service>:5432/advault
PORT=8080
JWT_SECRET=<openssl rand -hex 32>
TOKEN_ENCRYPTION_KEY=<openssl rand -hex 32>
CORS_ORIGINS=https://advault.3pandalabs.com
WEB_ORIGIN=https://advault.3pandalabs.com
R2_ACCOUNT_ID=<account id>
R2_ACCESS_KEY_ID=<from r2-setup.md>
R2_SECRET_ACCESS_KEY=<from r2-setup.md>
R2_BUCKET=advault-assets
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
METRICS_TOKEN=<shared org value — same as the other four apps>
ANTHROPIC_API_KEY=<optional; unset falls back to the script template>
GOOGLE_ADS_CLIENT_ID=<optional; see google-ads-setup.md>
GOOGLE_ADS_CLIENT_SECRET=
GOOGLE_ADS_DEVELOPER_TOKEN=
GOOGLE_ADS_LOGIN_CUSTOMER_ID=
```

`TOKEN_ENCRYPTION_KEY` is **required** and must be 64 hex characters. It
encrypts Google Ads refresh tokens at rest, and a refresh token authorises
spending an advertiser's budget — there is no degrade-gracefully-and-store-it-
in-plaintext option, so both containers refuse to boot without it. Rotating it
invalidates every stored token and every advertiser has to reconnect.

**Do NOT set `MIGRATION_DATABASE_URL`.**

## 3. `advault-renderer`

A second Application resource against the **same repository**.

| Setting | Value |
|---|---|
| Branch | `main` |
| Build Pack | Dockerfile |
| **Base Directory** | `api` |
| **Dockerfile Location** | `Dockerfile.renderer` |
| Ports Exposes | *(leave empty)* |
| Domains | *(none)* |

It is not an HTTP service — no port, no domain, no health check URL.

### Environment variables

Everything the API has **except** the HTTP and Google Ads ones, plus:

```
RENDER_CONCURRENCY=1
RENDER_POLL_INTERVAL_MS=5000
RENDER_WORK_DIR=/tmp/advault-render
```

**Keep `RENDER_CONCURRENCY` at 1.** The shared cx33 has 4 vCPUs and also runs
Postgres, three other API containers and the whole monitoring stack. An
unbounded ffmpeg pool is the fastest way to take the box down for four apps at
once.

`DATABASE_URL`, `TOKEN_ENCRYPTION_KEY` and all five `R2_*` values are required
here too — `env.ts` is shared by both containers. `JWT_SECRET` is required to
boot even though the renderer never verifies a token; that is the cost of one
shared env module and it is cheaper than two.

> This is the mistake RentVault made in reverse: its worker was deployed before
> the DB/JWT/R2 vars were added to the worker's own Coolify environment. Set
> them at creation time.

## 4. Backups

Coolify → `3pandalabs-postgres` → Backups → add a schedule for the `advault`
database targeting the `advault-backups` S3 storage. The tab only offers
storages registered globally and validated first (see r2-setup.md).

RsvpVault shipped without this and it is still open — do not repeat it.

## 5. Verify

```bash
curl -s https://api.advault.3pandalabs.com/health
# {"ok":true}

# api-internal is grey-cloud, so check it from the box, not your laptop:
ssh root@167.233.223.241 \
  "curl -s -H 'Host: api-internal.advault.3pandalabs.com' http://localhost/health"
```

Renderer health is not an endpoint — it is the log line and the queue depth:

```bash
ssh root@167.233.223.241 "docker logs --tail 20 \$(docker ps -qf name=advault-renderer)"
# {"worker":"...","msg":"renderer started","extra":{"concurrency":1,...}}
```

The real signal is `counts.queuedRenderJobs` on `GET /metrics`. A queue that
climbs and never drains means the renderer is down or crash-looping — and
nothing else in the metrics envelope shows it, because the API stays perfectly
healthy while every advertiser's video sits unrendered. Worth an Uptime Kuma or
Grafana alert.

## Deploys are manual

There is no auto-deploy anywhere in the org. Both containers deploy from a
button in Coolify. Deploy `advault-api` **first** on a schema change — it owns
the migration.
