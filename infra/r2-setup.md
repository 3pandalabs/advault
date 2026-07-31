# Cloudflare R2 — buckets, token, and the CORS policy everyone forgets

## Two buckets, not one

```bash
wrangler r2 bucket create advault-assets
wrangler r2 bucket create advault-backups
```

- **`advault-assets`** — advertiser-uploaded photos and rendered MP4s. This is
  the one the app reads and writes at runtime (`R2_BUCKET`).
- **`advault-backups`** — Postgres dumps, written by Coolify. Kept separate on
  purpose: a bucket-level mistake on user uploads must not also expose database
  dumps.

Both stay **private**. There is no public bucket domain; everything is reached
through presigned URLs issued by the API.

## API token, scoped to these two buckets only

Dashboard only — **wrangler cannot mint S3 credentials.**

R2 → Manage R2 API Tokens → Create API Token:

- Permission: **Object Read & Write**
- Specify buckets: `advault-assets` **and** `advault-backups` — not "All
  buckets". An all-buckets token would hand this app's credentials every other
  app's user documents.

Record the Access Key ID, Secret Access Key, and the account ID. The endpoint is
`https://<account_id>.r2.cloudflarestorage.com`.

## ⚠️ CORS on `advault-assets` — do this now, not later

A new bucket has **no CORS policy at all**. `wrangler r2 bucket cors list` says
"The CORS configuration does not exist". Without it, the browser's preflight
fails and the upload never reaches R2 — so the API logs are completely silent
and it looks like a frontend bug.

```bash
wrangler r2 bucket cors set advault-assets --file infra/r2-cors.json
wrangler r2 bucket cors list advault-assets
```

Two gotchas baked into `r2-cors.json`:

- wrangler wants the **Cloudflare** shape
  (`{"rules":[{"allowed":{"origins":…,"methods":…,"headers":…}}]}`) and rejects
  the S3 `AllowedOrigins` shape.
- **Every frontend origin needs listing.** A new preview URL or custom domain
  breaks uploads from that origin only, which is a confusing way to find out.

Not needed on `advault-backups` — Coolify writes it server-side, and CORS is a
browser concept.

This was missed on **both** RsvpVault and RentVault; RentVault's document upload
was broken in production until 2026-07-28.

## ⚠️ The other half of the same failure: presigned PUT checksums

`api/src/plugins/r2.ts` sets `requestChecksumCalculation: "WHEN_REQUIRED"` on
the `S3Client`. Since v3.729 the AWS SDK defaults to `"WHEN_SUPPORTED"`, which
computes a CRC32 at *signing* time — when there is no body — and bakes
`x-amz-checksum-crc32=AAAAAA==` (the CRC32 of the empty string) into the signed
URL. The browser then PUTs real bytes and R2 rejects the mismatch.

`package.json` pins `^3.687.0` and **still resolves to 3.1101.0** — check the
lockfile, not the range. Confirm the signed URL is clean:

```
DEFAULT:       checksum-crc32=AAAAAA%3D%3D, checksum-algorithm=CRC32
WHEN_REQUIRED: NONE
```

**These two defects mask each other.** With CORS missing the request never
leaves the browser, so fixing CORS alone just swaps one broken upload for
another. Verify both, then upload a real file from a real browser — the API
returns a perfectly good `{key, uploadUrl}` either way, so any test that stops
at the presign call passes while every upload is broken.

## Key layout

```
users/<userId>/assets/<uuid>.<ext>              uploaded photos and logos
campaigns/<campaignId>/creatives/<id>.mp4       rendered video
campaigns/<campaignId>/creatives/<id>.jpg       poster frame
```

Every key is prefixed by the resource that owns it, so an authorization check is
a string comparison and never a bucket listing. The prefix parsers live in
`api/src/plugins/r2.ts`; the checks that use them live in the routes.

## Register the S3 storage in Coolify

Needed before the Postgres backup schedule will offer `advault-backups` —
Coolify's Backups tab only lists storages that have been registered globally and
validated. Coolify → Storages → Add S3, pointing at the R2 endpoint with the
token above.
