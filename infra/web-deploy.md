# Web — deploying `advault-web` to Cloudflare Workers

Next.js 16 through `@opennextjs/cloudflare`. Deployed from a dev machine; there
is no auto-deploy anywhere in the org.

```bash
cd web
npm install
npm run cf:deploy      # opennextjs-cloudflare build && … deploy
```

`wrangler login` once per machine first.

## The custom domain is declared in `wrangler.jsonc`

```jsonc
"routes": [{ "pattern": "advault.3pandalabs.com", "custom_domain": true }]
```

**wrangler creates and maintains that DNS record itself — do not add one by
hand.** (The two `api.*` records are a different case: they point at the Hetzner
box, not at a Worker, so they are managed manually. See coolify-setup.md.)

If `advault.3pandalabs.com` ever picks up an externally-managed record,
Cloudflare refuses to attach the `custom_domain` route with **error 100117**.
Delete the conflicting record, then redeploy.

## Three things that will bite

**1. `next build --webpack`, never Turbopack.** Already set in
`package.json`. Turbopack output is not fully supported by the adapter — the
deploy *succeeds* and then every route 500s with `ChunkLoadError` at request
time. RentVault hit this in production on 2026-07-21.

**2. No `proxy.ts` / middleware.** The adapter cannot bundle it (Node-only
`async_hooks`). Auth lives in `src/app/dashboard/layout.tsx` plus the API's own
`requireAuth`, which is the real boundary.

**3. `web/.env.production` is committed and load-bearing.** `NEXT_PUBLIC_*` is
inlined at *build* time, so `wrangler.jsonc` `vars` (which are *runtime*) cannot
supply it. RsvpVault shipped a bundle pointing at `http://localhost:8080` this
way — SSR kept working, so the site looked healthy while every button was dead.
`next.config.ts` now throws at build time if `NEXT_PUBLIC_API_URL` is unset,
which turns that silent failure into a loud one.

## Set the metrics secret

The web Worker does not serve `/metrics` — this app has an `api/`, so the
metrics endpoint lives there (unlike MealMargin, which has no backend). Nothing
to set here.

## Verify

```bash
curl -sI https://advault.3pandalabs.com | head -5
# Look for Server-Timing: cfWorker — Cloudflare's edge proxy header is present
# either way, so it is not proof the Worker is serving.
```

Then open it in a real browser and check the Network tab: the dashboard's calls
should go to `https://api.advault.3pandalabs.com`, not localhost. A curl of the
server-rendered HTML cannot tell you this — that is the whole point of the
failure mode above.
