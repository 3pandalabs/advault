"use client";

import type { NewAdStatus } from "@/lib/api/browser";

// Offer combo (2026-11-15): "Also put this offer on my website" on a new-ad
// purchase, for a campaign whose link is a SiteVault site. $10 ad + $2 = $12,
// or $10 when the site has a SiteVault credit to spend, or free when SiteVault
// billing is off. The API decides the mode again at checkout from SiteVault's
// live answer (lib/siteOffer); this only shows it.

export function siteOfferLabel(o: NonNullable<NewAdStatus["siteOffer"]>): string {
  if (o.offered === "credit") {
    const n = o.credits ?? 1;
    return `Also put this offer on my website (uses 1 of your ${n} website ${n === 1 ? "credit" : "credits"})`;
  }
  if (o.offered === "free") return "Also put this offer on my website (free)";
  return `Also put this offer on my website (+${o.addonDisplay ?? "$2"})`;
}

/** The price on the pay button: "$10", or "$10 + $2" with the paid add-on ticked. */
export function payLabel(status: NewAdStatus, ticked: boolean): string {
  const o = status.siteOffer;
  return o && ticked && o.offered === "paid" && o.addonDisplay ? `${status.display} + ${o.addonDisplay}` : (status.display ?? "");
}

export function SiteOfferOption({
  status,
  checked,
  onChange,
  disabled,
}: {
  status: NewAdStatus;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const o = status.siteOffer;
  if (!o) return null;
  return (
    <label className="mt-3 flex min-h-11 items-start gap-2 text-sm text-zinc-300">
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 shrink-0 accent-amber-400"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className="min-w-0">
        {siteOfferLabel(o)}
        <span className="block break-words text-zinc-400">“{o.offer}”</span>
      </span>
    </label>
  );
}
