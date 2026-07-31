# AdVault — infrastructure runbooks

Nothing here runs automatically. Every step is a command you run or a button you
press, in this order:

| # | Runbook | What it stands up |
|---|---|---|
| 1 | [postgres-setup.md](postgres-setup.md) | `advault` database + `advault_app` role on the shared `3pandalabs-postgres` |
| 2 | [r2-setup.md](r2-setup.md) | `advault-assets` + `advault-backups` buckets, scoped API token, **CORS policy** |
| 3 | [coolify-setup.md](coolify-setup.md) | DNS, `advault-api` and `advault-renderer` applications, env vars, backups |
| 4 | [web-deploy.md](web-deploy.md) | `advault-web` Cloudflare Worker + custom domain |
| 5 | [google-ads-setup.md](google-ads-setup.md) | OAuth client + developer token (the slow one — start it early) |
| 6 | [launch-checklist.md](launch-checklist.md) | The org-wide five-surface sweep and the smoke test |

## Order matters in two places

**DNS before the first Coolify deploy.** The ACME challenge needs the hostname
to resolve or the certificate never issues.

**`main` must contain `api/` before you point Coolify at this repo.** Deploying
from an unmerged branch fails on a missing Dockerfile — ReceiptCash spent real
time on exactly this.

## Start the Google Ads paperwork first

The Google Ads **developer token** needs Basic access, which is a manual review
against an existing Manager (MCC) account and can take days. Everything else in
AdVault works without it — uploads, script generation, rendering, downloads —
so submit that application on day one and build the rest while it sits in a
queue. See [google-ads-setup.md](google-ads-setup.md).
