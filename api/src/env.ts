import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Shared by BOTH containers (API and renderer), so anything required here must
// genuinely be needed by both. Feature-specific credentials — Google Ads,
// Anthropic — are deliberately optional and live in their own modules
// (lib/googleAds/env.ts, lib/script/env.ts), following the RentVault KYC
// pattern: a missing integration key should disable that feature with a clear
// error on the affected row, not stop either process from booting.
export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  PORT: Number(process.env.PORT ?? 8080),
  JWT_SECRET: required("JWT_SECRET"),
  CORS_ORIGINS: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Used to build the OAuth redirect URI and any absolute link the API needs to
  // hand back — the API has no other way to know its own front end.
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? "http://localhost:3000",

  R2_ACCOUNT_ID: required("R2_ACCOUNT_ID"),
  R2_ACCESS_KEY_ID: required("R2_ACCESS_KEY_ID"),
  R2_SECRET_ACCESS_KEY: required("R2_SECRET_ACCESS_KEY"),
  R2_BUCKET: required("R2_BUCKET"),
  R2_ENDPOINT: required("R2_ENDPOINT"),

  // AES-256-GCM key (64 hex chars) for Google Ads refresh tokens at rest.
  // REQUIRED, and required in the renderer too even though it never decrypts
  // one: booting without it would let the API start, accept a Google Ads
  // connection, and store a refresh token in plaintext. A refresh token
  // authorises spending someone else's advertising budget — there is no
  // graceful-degradation story for storing it unprotected, so this is the one
  // integration secret that is not optional.
  TOKEN_ENCRYPTION_KEY: required("TOKEN_ENCRYPTION_KEY"),

  // Bearer token for the ops-only GET /metrics endpoint. Intentionally NOT
  // required: when unset the route answers 503 and the rest of the API boots
  // normally, so a missing ops secret can't take a deploy down.
  METRICS_TOKEN: process.env.METRICS_TOKEN ?? "",
};
