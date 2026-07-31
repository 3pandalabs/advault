import crypto from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env.js";

// R2 is S3-compatible; the AWS SDK v3 client works against it unchanged by
// pointing endpoint at the account's R2 endpoint and using region "auto".
export const r2 = new S3Client({
  region: "auto",
  endpoint: env.R2_ENDPOINT,
  // Required for presigned PUTs. Since v3.729 the SDK defaults this to
  // "WHEN_SUPPORTED", which computes an x-amz-checksum-crc32 at *signing* time —
  // when there is no body yet — and bakes CRC32("") into the signed query
  // string. The browser then PUTs real bytes and R2 rejects the mismatch. The
  // signature already pins bucket, key and content type, so dropping the
  // checksum costs no integrity we were relying on.
  //
  // Note package.json may pin ^3.687.0 and still resolve past 3.729 — check the
  // lockfile, not the range. Both RsvpVault and RentVault shipped uploads that
  // could never succeed by missing this.
  requestChecksumCalculation: "WHEN_REQUIRED",
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

const UPLOAD_URL_TTL_SECONDS = 5 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 10 * 60;

// Only these land in a browser <img> or reach ffmpeg. Enforced again by
// ContentType being pinned into the signature below, so a client can't sign for
// image/png and then PUT an HTML file.
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

export function isAllowedImageType(t: string): t is AllowedImageType {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(t);
}

// image/avif is deliberately absent, unlike RsvpVault's list. The alpine ffmpeg
// build has no AVIF decoder, so an AVIF source would upload cleanly, pass every
// validation, and then fail at encode time with a decoder error — the worst
// place to discover an unsupported format.

export function presignUpload(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    r2,
    new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS },
  );
}

export function presignDownload(key: string): Promise<string> {
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }), {
    expiresIn: DOWNLOAD_URL_TTL_SECONDS,
  });
}

// Server-side read, used by the renderer to pull source photos into its scratch
// directory. The renderer is not a browser and has the R2 credentials, so it
// fetches directly rather than round-tripping through a presigned URL.
export async function getObjectBytes(key: string): Promise<Buffer> {
  const res = await r2.send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
  if (!res.Body) throw new Error(`R2 object has no body: ${key}`);
  return Buffer.from(await res.Body.transformToByteArray());
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await r2.send(
    new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, Body: body, ContentType: contentType }),
  );
}

// Best-effort delete — called when an advertiser removes an asset, so the
// object doesn't outlive its metadata row.
export async function deleteObject(key: string): Promise<void> {
  await r2.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
}

// ---------------------------------------------------------------------------
// Key layout. Every key is prefixed by the resource that owns it, so an
// authorization check is a string comparison and never a bucket listing:
//
//   users/<userId>/assets/<uuid>.<ext>                 uploaded photos + logos
//   campaigns/<campaignId>/creatives/<id>.mp4          rendered video
//   campaigns/<campaignId>/creatives/<id>.jpg          poster frame
//
// A user may presign under users/<their own id>/ only; a user may presign a
// download under campaigns/<id>/ only for a campaign they own. Both checks live
// in the routes — this module never authorizes.
// ---------------------------------------------------------------------------

export function assetKey(userId: string, ext: string): string {
  return `users/${userId}/assets/${crypto.randomUUID()}.${ext}`;
}

export function creativeVideoKey(campaignId: string, creativeId: string): string {
  return `campaigns/${campaignId}/creatives/${creativeId}.mp4`;
}

export function creativeThumbnailKey(campaignId: string, creativeId: string): string {
  return `campaigns/${campaignId}/creatives/${creativeId}.jpg`;
}

export function extForType(t: AllowedImageType): string {
  return t === "image/jpeg" ? "jpg" : t.slice("image/".length);
}

// Guards against a caller passing an arbitrary key to presign-download and
// reading someone else's object. Each returns the owning id, or null if the key
// isn't in a shape this app ever produces.

export function userIdForAssetKey(key: string): string | null {
  const m = /^users\/([0-9a-f-]{36})\/assets\//i.exec(key);
  return m ? m[1] : null;
}

export function campaignIdForCreativeKey(key: string): string | null {
  const m = /^campaigns\/([0-9a-f-]{36})\/creatives\//i.exec(key);
  return m ? m[1] : null;
}
