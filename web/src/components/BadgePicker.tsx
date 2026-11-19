"use client";

import { Input } from "@/components/ui/input";
import { BADGES, BADGE_ATTESTATION, MAX_BADGES, type BadgeId } from "@/lib/categories/badges";

// Trust badges (api lib/categories/badges): the tick boxes, the license number
// and the "These are true" attestation. Used by the new-campaign wizard (so
// the FIRST ad has them) and the campaign page's Badges card.

export type BadgeDraft = { ids: BadgeId[]; licenseNumber: string; attested: boolean };

export const EMPTY_BADGES: BadgeDraft = { ids: [], licenseNumber: "", attested: false };

export function BadgePicker({
  options,
  value,
  onChange,
  disabled,
}: {
  options: readonly BadgeId[];
  value: BadgeDraft;
  onChange: (next: BadgeDraft) => void;
  disabled?: boolean;
}) {
  const { ids } = value;
  function toggle(id: BadgeId) {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : ids.length < MAX_BADGES ? [...ids, id] : ids;
    onChange({ ...value, ids: next });
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-2">
        {options.map((id) => (
          <label key={id} className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={ids.includes(id)}
              disabled={disabled || (!ids.includes(id) && ids.length >= MAX_BADGES)}
              onChange={() => toggle(id)}
            />
            <span>{BADGES[id].label}</span>
          </label>
        ))}
      </div>
      {ids.includes("license_number") && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-zinc-400">License number</span>
          <Input
            aria-label="License number"
            className="w-48"
            maxLength={20}
            value={value.licenseNumber}
            onChange={(e) => onChange({ ...value, licenseNumber: e.target.value })}
            disabled={disabled}
          />
        </div>
      )}
      <p className="text-xs text-zinc-400">Up to {MAX_BADGES}. They show on the last screen of your ad.</p>
      {ids.length > 0 && (
        <label className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={value.attested}
            onChange={(e) => onChange({ ...value, attested: e.target.checked })}
            disabled={disabled}
          />
          <span>{BADGE_ATTESTATION} I can show proof if asked.</span>
        </label>
      )}
    </div>
  );
}
