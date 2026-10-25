# AdVault — infrastructure runbooks

Nothing here runs automatically. Every step is a command you run or a button you
press, in this order:

| # | Runbook | What it stands up |
|---|---|---|
| 1 | [postgres-setup.md](postgres-setup.md) | `advault` database + `advault_app` role on the shared `3pandalabs-postgres` |
| 2 | [r2-setup.md](r2-setup.md) | `advault-assets` + `advault-backups` buckets, scoped API token, **CORS policy** |
| 3 | [coolify-setup.md](coolify-setup.md) | DNS, `advault-api` and `advault-renderer` applications, env vars, backups |
| 4 | [web-deploy.md](web-deploy.md) | `advault-web` Cloudflare Worker + custom domain |
| 5 | [google-ads-setup.md](google-ads-setup.md) | OAuth client + Cloud-project API access (the slow one — start it early) |
| 6 | [youtube-setup.md](youtube-setup.md) | The org YouTube channel + its credential — **without this no campaign can serve** |
| 7 | [launch-checklist.md](launch-checklist.md) | The org-wide five-surface sweep and the smoke test |

## Order matters in two places

**DNS before the first Coolify deploy.** The ACME challenge needs the hostname
to resolve or the certificate never issues.

**`main` must contain `api/` before you point Coolify at this repo.** Deploying
from an unmerged branch fails on a missing Dockerfile — ReceiptCash spent real
time on exactly this.

## Start the Google Ads paperwork first

Google Ads API access is granted per **Google Cloud project** and is gated on
**brand verification** of that project, which Google reviews and which is the
slow step. (Developer tokens were sunset on 9 Sep 2026 — the old "apply for
Basic access in the API Center" process no longer exists.) Everything else in
AdVault works without it — uploads, script generation, rendering, downloads —
so start brand verification on day one and build the rest while it sits in a
queue. See [google-ads-setup.md](google-ads-setup.md).

## The thing that silently stops every campaign working

A Google Ads video ad references a **YouTube video id**, never an MP4 URL. With
no YouTube credential on the renderer, every creative renders perfectly, the
upload queue fills, and **no campaign can ever serve** — and nothing in
`/health` or a green deploy disagrees. Do step 6 before you conclude the app
works. `counts.renderedNotOnYouTube` in `/metrics` is the number that tells the
truth.
