import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { env } from "../env.js";

// AES-256-GCM for Google Ads refresh tokens at rest.
//
// Why encrypt at all, when the database is already private? Because the threat
// model for THIS column is different from every other column in the app. A
// refresh token is a bearer credential for spending an advertiser's money, it
// stays valid for months, and it is useful to an attacker entirely outside our
// systems — so a leaked backup, a mis-scoped R2 token on the -backups bucket,
// or a stray pg_dump in a transcript are each individually sufficient. Nothing
// else here has that property.
//
// GCM (not CBC) so the ciphertext is authenticated: a tampered value fails to
// decrypt rather than silently yielding garbage that we then send to Google.

const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for
const VERSION = "v1";

function key(): Buffer {
  const raw = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "hex");
  if (raw.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must be ${KEY_BYTES * 2} hex characters (openssl rand -hex ${KEY_BYTES})`,
    );
  }
  return raw;
}

// Stored form is `v1.<iv>.<authTag>.<ciphertext>`, all base64url. The version
// prefix is what makes a future key rotation or algorithm change a migration
// rather than a guessing game about which rows are in which format.
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptToken(stored: string): string {
  const [version, ivB64, tagB64, ctB64] = stored.split(".");
  if (version !== VERSION || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("Stored token is not in the expected v1 envelope");
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  // Throws on a bad tag — which is the point. A decrypt failure here means the
  // ciphertext or the key changed, and the correct response is to make the
  // advertiser reconnect, never to guess.
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString(
    "utf8",
  );
}

// Constant-time compare for anything token-shaped. timingSafeEqual throws on a
// length mismatch, so lengths are checked first — the length of a secret is not
// the part worth hiding.
export function secretEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
