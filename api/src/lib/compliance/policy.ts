// Pure compliance decisions (2026-11-20). No db, no fetch: tested in
// policy.test.ts. The DB-facing half is lib/compliance/index.ts.

import type { CategoryKey } from "../categories/key.js";
import { claimFlags, type ComplianceReason } from "./claimRules.js";
import { ATTESTATION_VERSION, TERMS_VERSION } from "./texts.js";

export type ComplianceStatus = "ok" | "needs_review" | "taken_down";

/** One piece of ad text to check, with where it came from. */
export type ComplianceText = { field: string; text: string | null | undefined };

/** Every REVIEW flag across the texts, one per (rule, phrase), first field wins. */
export function reviewReasons(key: CategoryKey | null, texts: ComplianceText[]): ComplianceReason[] {
  const out: ComplianceReason[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    for (const f of claimFlags(key, t.text)) {
      if (f.level !== "review") continue;
      const k = reasonKey(f);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ id: f.id, phrase: f.phrase, reason: f.reason, field: t.field });
    }
  }
  return out;
}

export function reasonKey(r: { id: string; phrase: string }): string {
  return `${r.id}:${r.phrase.trim().toLowerCase()}`;
}

/**
 * The state after re-checking the ad text.
 *
 * - taken_down never changes here (only an admin acts on it).
 * - No review phrases: ok, nothing stored.
 * - Review phrases: each keeps `approved` if an admin already approved that
 *   exact (rule, phrase) on this campaign; any NEW phrase makes the whole
 *   campaign needs_review again. So an edit can never silently ride on an
 *   earlier approval, and an unchanged text is not re-queued by every save.
 */
export function nextCompliance(
  prev: { status: ComplianceStatus; reasons: ComplianceReason[] | null },
  found: ComplianceReason[],
): { status: ComplianceStatus; reasons: ComplianceReason[] | null } {
  if (prev.status === "taken_down") return { status: "taken_down", reasons: prev.reasons };
  if (found.length === 0) return { status: "ok", reasons: null };
  const approved = new Set((prev.reasons ?? []).filter((r) => r.approved).map(reasonKey));
  const reasons = found.map((r) => ({ ...r, approved: approved.has(reasonKey(r)) }));
  return { status: reasons.every((r) => r.approved) ? "ok" : "needs_review", reasons };
}

/** An admin approved: every current phrase is approved, status ok. */
export function approveAll(reasons: ComplianceReason[] | null): ComplianceReason[] | null {
  return reasons ? reasons.map((r) => ({ ...r, approved: true })) : null;
}

export type Refusal = { status: number; body: Record<string, unknown> };

/** The client's two ticks, as sent. Missing, false or an old version = refused. */
export function attestationRefusal(att: unknown): Refusal | null {
  const a = (att ?? null) as { accuracy?: unknown; media?: unknown; version?: unknown } | null;
  if (a && a.accuracy === true && a.media === true && a.version === ATTESTATION_VERSION) return null;
  return {
    status: 400,
    body: {
      error: "attestation_required",
      version: ATTESTATION_VERSION,
      detail: "Tick both boxes to confirm your ad is truthful and that you have the rights to your photos and videos.",
    },
  };
}

export function termsRefusal(accepted: string | null): Refusal | null {
  if (accepted === TERMS_VERSION) return null;
  return {
    status: 409,
    body: {
      error: "terms_not_accepted",
      current: TERMS_VERSION,
      accepted,
      detail: "Please read and accept the updated Terms of Service first.",
    },
  };
}

export function takenDownRefusal(c: { complianceStatus: string }): Refusal | null {
  if (c.complianceStatus !== "taken_down") return null;
  return {
    status: 409,
    body: {
      error: "ad_taken_down",
      detail: "AdVault removed this ad. Email 3pandas@3pandalabs.com if you think this is a mistake.",
    },
  };
}

export function needsReviewRefusal(c: { complianceStatus: string; complianceReasons: ComplianceReason[] | null }): Refusal | null {
  if (c.complianceStatus !== "needs_review") return null;
  return {
    status: 409,
    body: {
      error: "needs_review",
      reasons: (c.complianceReasons ?? []).filter((r) => !r.approved),
      detail: "Some wording in this ad is checked by AdVault before it can run. We usually review within a day.",
    },
  };
}

/** The first IP of a header value ("a, b"), or null. */
export function firstIp(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  const ip = s?.split(",")[0]?.trim();
  return ip ? ip.slice(0, 64) : null;
}
