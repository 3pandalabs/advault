"use client";

import { categoryKey } from "@/lib/categories/key";
import { offerPresets, type OfferPreset } from "@/lib/categories/extras";

/**
 * One-tap offers per category (api lib/categories/extras OFFER_PRESETS):
 * Electrical upgrades (EV charger, panel, generator, solar hookup) and the
 * Cleaning move-out / move-in offer. A tap fills the offer box; the owner
 * then changes the prices so every word is true.
 */
export function OfferPresetButtons({ category, onPick }: { category: string; onPick: (p: OfferPreset) => void }) {
  const presets = offerPresets(categoryKey(category));
  if (presets.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-zinc-400">Popular offers:</span>
      {presets.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onPick(p)}
          className="rounded-full border border-white/15 px-3 py-1 text-zinc-200 hover:border-white/30"
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
