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
- [ ] Renderer log line `"youtube upload worker started"` present — and
      **not** `"youtube uploads disabled — no OAuth client configured"`. With
      the latter, every creative renders fine and no campaign can ever serve.
- [ ] `GET /metrics` → `counts.renderedNotOnYouTube` is 0 and stays 0 as
      creatives render. It climbing while the render counts look healthy is the
      only signal that the upload chain is broken.
- [ ] `GET /metrics` → `counts.liveCampaignsWithoutAds` is 0. It should be 0
      forever; anything else is a budgeted campaign with no ad in it.
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

### YouTube publishing — before Google Ads is worth testing

A rendered MP4 is not an ad. Until a creative is on YouTube it cannot be
attached to anything, so this section gates the one below it.

- [ ] A rendered creative's badge reaches **Ready**, not a stuck
      **Publishing…**, and the campaign page's Launch button appears.
- [ ] The video exists on the org channel and is **unlisted** — not public, not
      private.
- [ ] An ad produced with AI motion or voice is declared as synthetic content on
      YouTube; one from the plain photo pipeline is not. The privacy policy makes
      this claim, so it is a published statement rather than a detail.
- [ ] Connect an advertiser's own channel from Settings, render a new creative,
      and confirm it lands on **their** channel while the earlier ones stay on
      the org channel.
- [ ] Disconnect it and confirm new creatives go back to the org channel.
- [ ] `POST /youtube/backfill` queues only creatives that never reached YouTube,
      and re-running it does not publish anything a second time.
- [ ] Retry an already-published creative and confirm it is **not** re-uploaded
      (no second video on the channel, same video id).

### Google Ads, once the Cloud project has Basic access

- [ ] Connect flow completes and the account appears in Settings.
- [ ] **Launch against a test account first.** Google rejects mutates against a
      production account with test-level access and vice versa.
- [ ] Confirm in the Google Ads UI that the campaign is **PAUSED**, has the right
      daily budget, and has the right location criteria. Verify the geo targeting
      before anything is enabled — a campaign with no location criteria targets
      the entire country, which is the single most expensive way this app can be
      wrong.
- [ ] **Confirm the campaign has an ad group with an ad in it**, and that the ad
      plays the right video. A budget and a campaign with no ad is a shell that
      can never serve — it is what this app shipped until 2026-10-24, and it
      looks identical to success from the API's side.
- [ ] Confirm the ad group's type matches the creative's length (bumper ≤6s,
      non-skippable ≤15s, skippable beyond). The type is immutable at Google.
- [ ] Try to edit or retry a creative that is already running and confirm it is
      refused with `creative_is_live` — re-rendering would leave the live ad
      pointing at a video that no longer matches it.
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
