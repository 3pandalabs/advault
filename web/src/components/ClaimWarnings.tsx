"use client";

import { claimFlags } from "@/lib/categories/claims";
import { categoryKey } from "@/lib/categories/key";

/**
 * Claim checks as the owner types (api lib/categories/claims). Warnings say
 * why and can be kept; a block (housing exclusion) is refused by the API.
 */
export function ClaimWarnings({ category, text }: { category: string; text: string }) {
  const flags = claimFlags(categoryKey(category), text);
  if (flags.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1.5" aria-live="polite">
      {flags.map((f) => (
        <li
          key={f.id}
          className={`rounded-lg border px-3 py-2 text-xs ${
            f.level === "block" ? "border-red-400/40 bg-red-400/10 text-red-200" : "border-amber-400/30 bg-amber-400/10 text-amber-200"
          }`}
        >
          <span className="font-semibold">
            {f.level === "block" ? "Not allowed" : "Check this"}: &ldquo;{f.phrase}&rdquo;.
          </span>{" "}
          {f.reason}
        </li>
      ))}
    </ul>
  );
}

/** True when the text has a claim the API will refuse. */
export function hasBlockedClaim(category: string, text: string): boolean {
  return claimFlags(categoryKey(category), text).some((f) => f.level === "block");
}
