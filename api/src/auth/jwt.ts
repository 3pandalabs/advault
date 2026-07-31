import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../env.js";

export type UserRole = "advertiser" | "admin";
export type AccessTokenPayload = { sub: string; role: UserRole };

const ACCESS_TOKEN_TTL = "15m";
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
}

// Refresh tokens are `${sessionId}.${secret}` — sessionId is a safe-to-expose
// lookup key (indexed row id), secret is what actually authenticates and only
// its bcrypt hash is stored. This lets refresh/logout find the candidate
// session with an indexed lookup instead of bcrypt-comparing every session row.
export function generateRefreshSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function parseRefreshToken(token: string): { sessionId: string; secret: string } | null {
  const idx = token.indexOf(".");
  if (idx < 0) return null;
  return { sessionId: token.slice(0, idx), secret: token.slice(idx + 1) };
}
