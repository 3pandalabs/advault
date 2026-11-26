// Who gets a customer email, and when "Your ad is ready" fires. Pure: no db.
import { isUndeliverableEmail } from "../testMode/policy.js";

export const DEFAULT_WEB_ORIGIN = "https://advault.3pandalabs.com";

/** Where links point. Same fallback as lib/compliance/report.ts (the renderer may not set WEB_ORIGIN). */
export function webOrigin(env: string | undefined = process.env.WEB_ORIGIN): string {
  return (env?.trim() || DEFAULT_WEB_ORIGIN).replace(/\/+$/, "");
}

export type RecipientRow = {
  email: string | null;
  role: string;
  deletedAt: Date | null;
  testOwnerId: string | null;
};

export type SkipReason = "no_email" | "deleted" | "test_customer" | "undeliverable" | "admin";

/**
 * null = send. Rules (one for all four emails):
 * - deleted accounts (anonymised to deleted+<id>@advault.invalid anyway),
 * - admin-made test customers (`test_owner_id`) and any `*.invalid` address,
 * - admins (REAL `users.role`), test mode or not: they test the flows and are
 *   not customers; internal accounts (advault@3pandalabs.com etc.) are
 *   advertisers and DO get them, as do `marked_test` accounts (real inboxes).
 */
export function customerEmailSkip(u: RecipientRow): SkipReason | null {
  if (!u.email?.trim()) return "no_email";
  if (u.deletedAt) return "deleted";
  if (u.testOwnerId) return "test_customer";
  if (isUndeliverableEmail(u.email)) return "undeliverable";
  if (u.role === "admin") return "admin";
  return null;
}

export type MakeCreative = {
  id: string;
  createdAt: Date;
  renderStatus: string;
  youtubeVideoId: string | null;
  youtubeUploadStatus: string;
  reviewStatus: string | null;
  readyEmailedAt: Date | null;
};

/** The make's anchor: its first creative (createdAt, then id). Holds the once-only mark. */
export function makeAnchor<T extends Pick<MakeCreative, "id" | "createdAt">>(rows: T[]): T | null {
  return (
    [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ??
    null
  );
}

const onYoutube = (c: MakeCreative) => c.renderStatus === "ready" && Boolean(c.youtubeVideoId);
const gaveUp = (c: MakeCreative) =>
  c.renderStatus === "failed" || c.youtubeUploadStatus === "failed" || c.reviewStatus === "rejected";

/**
 * "Your ad is ready" for one make (every creative of a campaign with the same
 * kind, version and purchase; no offer-change re-cuts): send once every format
 * has finished — "Ready" as the campaign page defines it (rendered AND on
 * YouTube) or given up — with at least one Ready, and the anchor not yet
 * marked. A format still rendering or publishing waits, so a 16:9 + 9:16 make
 * is ONE email when the second lands.
 */
export function adReadyDecision(rows: MakeCreative[]): { send: false } | { send: true; anchorId: string } {
  const anchor = makeAnchor(rows);
  if (!anchor || anchor.readyEmailedAt) return { send: false };
  if (rows.some((r) => r.readyEmailedAt)) return { send: false };
  if (!rows.every((r) => onYoutube(r) || gaveUp(r))) return { send: false };
  if (!rows.some(onYoutube)) return { send: false };
  return { send: true, anchorId: anchor.id };
}
