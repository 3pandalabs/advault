# AdVault launch checklist

The org-wide checklist is `knowledge_base/launching-a-new-app.md`. This is the
AdVault-specific instance of it — the five surfaces that nothing keeps in sync,
plus a smoke test shaped around this app's actual failure modes.

## The five surfaces (none of these sync)

| Surface | Repo | What to add |
|---|---|---|
| Public marketing site | `3pandalabs-website` | App card in `public/index.html`, plus the section lede count. **This is the one that gets forgotten** — RsvpVault shipped fully working and was absent from the site for hours. |
| Internal admin page | `admin` | `METRICS_TARGETS` line, Apps-table row, project tab + pane, Usage & resources table, Mermaid flow diagram, cost card |
| Source of truth | `knowledge_base` | New `tech-stack.md` Section 6, plus the org rows it changes (Hetzner, R2, cost summary) |
| Claude memory | — | `advault_project`, `advault_db_password`, and a line in `MEMORY.md` |
| Monitoring | `monitoring` | Uptime Kuma checks for `advault.3pandalabs.com` and `api.advault.3pandalabs.com` |

### Admin page note specific to AdVault

The Usage & resources table renders the shared envelope generically, so nothing
special is needed — but **`counts.queuedRenderJobs` is the number worth
watching**. It is the only signal that `advault-renderer` is down: the API stays
perfectly healthy and green while every advertiser's video sits unrendered.
Consider a Grafana alert on it climbing without draining.

The architecture diagram should show **two backend containers**, which no other
app in the org has.

## Verify before calling it launched

- [ ] `/health` on **both** API hostnames. `api-internal` will time out from a
      dev machine — the firewall only admits Cloudflare IPs, and that is the
      firewall working. Check it from the box with a `Host:` header.
- [ ] Renderer log line `"renderer started"` present in `docker logs`.
- [ ] `GET /metrics` with the shared bearer returns the full envelope; an
      unauthenticated request and a wrong token both return `401`.
- [ ] Coolify Postgres backup schedule to `advault-backups` configured and a
      first backup verified. (RsvpVault still has this open — do not repeat it.)

### Exercise it through a browser, not just the API

An end-to-end script that drives the API directly and the server-rendered pages
will pass while every client-side call is broken — that is exactly how RsvpVault's
localhost bug survived a 40-check suite.

- [ ] Sign up, log in.
- [ ] **Upload a real photo from a real browser.** Both R2 failure modes (missing
      CORS, baked-in CRC32) are invisible to any test that doesn't put actual
      bytes through a browser to the presigned URL — the API returns a perfectly
      good `{key, uploadUrl}` either way.
- [ ] Complete the three-step wizard end to end.
- [ ] Watch a creative go `queued → rendering → ready` and **play the video in
      the browser**. A `ready` status with an unplayable file is a rendering bug
      the status field cannot see.
- [ ] Confirm the 9:16 render is actually vertical and its captions fit.
- [ ] Delete an asset that a rendered creative used, and confirm the creative
      still plays — creatives snapshot their source keys, so this should hold.
- [ ] Walk the empty states: a fresh account's dashboard must offer a button,
      not just describe one.
- [ ] With `ANTHROPIC_API_KEY` unset, confirm generation still succeeds and the
      creative is marked `fallback` — the whole point of that path is that a
      missing integration key cannot break the wizard.

### Google Ads, once the developer token lands

- [ ] Connect flow completes and the account appears in Settings.
- [ ] **Launch against a test account first.** Google rejects mutates against a
      production account with a test token and vice versa.
- [ ] Confirm in the Google Ads UI that the campaign is **PAUSED**, has the right
      daily budget, and has the right location criteria. Verify the geo targeting
      before anything is enabled — a campaign with no location criteria targets
      the entire country, which is the single most expensive way this app can be
      wrong.
- [ ] Confirm launching twice returns `already_launched` rather than creating a
      second campaign and a second budget.
- [ ] Revoke access from the Google account side, then confirm the next launch
      marks the row `revoked` and the dashboard prompts a reconnect.

### Before linking from the public site

- [ ] Delete demo/smoke-test data, or rotate any password shared while creating
      it.
- [ ] Disconnect any test Google Ads account used during the smoke test.

## Still open at scaffold time

- Rendered videos are **not** attached to the Google Ads campaign as ads. A video
  ad references a YouTube video id, not an MP4 URL, so the file must first be
  uploaded to the advertiser's own YouTube channel via the YouTube Data API —
  its own scope and consent flow. `creatives.youtube_video_id` exists for it.
  See `google-ads-setup.md`.
- No outbound email at all (no password reset, no render-complete notification).
  Only `rsvpvault.3pandalabs.com` is a verified Resend sender and adding a second
  domain evicts it. The dashboard polls instead.
- `api/Dockerfile*` pins `node:20-alpine`, and AWS SDK v3 releases after early
  January 2027 will require Node ≥22. Dated fuse, harmless today — the runtime
  already warns about it in the container log. Same as RsvpVault.
