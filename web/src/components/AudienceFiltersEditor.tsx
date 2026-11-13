"use client";

import { useState } from "react";
import {
  FILTER_SECTIONS,
  HOUSING_RESTRICTED,
  filtersForSave,
  isActive,
  summarize,
  type AudienceFilterKey,
  type AudienceFilters,
} from "@/lib/audience";

export const NARROWING_WARNING =
  "Each filter narrows who can see your ad. Fewer people match, so you get fewer views for the same budget.";

export const HOUSING_NOTICE =
  "Housing ads in the US can't target by age, gender, family status or ZIP code (Google policy). We target by distance from your listing instead.";

/**
 * "Who should see it". Every filter starts collapsed as "Everyone"; opening
 * one and ticking options narrows it. For a housing (real estate) campaign the
 * age / gender / parental rows are not offered at all.
 */
export function AudienceFiltersEditor({
  value,
  onChange,
  housing,
  disabled,
}: {
  value: AudienceFilters;
  onChange: (next: AudienceFilters) => void;
  housing: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState<AudienceFilterKey | null>(null);
  const sections = FILTER_SECTIONS.filter((s) => !(housing && HOUSING_RESTRICTED.includes(s.key)));
  const anyActive = filtersForSave(value, housing) !== null;

  function toggle(key: AudienceFilterKey, option: string) {
    const list = ((value[key] ?? []) as string[]).slice();
    const i = list.indexOf(option);
    if (i >= 0) list.splice(i, 1);
    else list.push(option);
    onChange({ ...value, [key]: list });
  }

  return (
    <div>
      <h3 className="text-sm font-medium text-zinc-200">Who should see it</h3>
      <p className="mt-1 text-xs text-zinc-500">
        Everyone in your area by default. Most local businesses should leave it that way.
      </p>

      {housing && (
        <p className="mt-3 rounded-lg border border-sky-400/30 bg-sky-400/10 px-3 py-2 text-xs text-sky-200">
          {HOUSING_NOTICE}
        </p>
      )}

      <div className="mt-3 divide-y divide-white/10 rounded-lg border border-white/10">
        {sections.map((s) => {
          const expanded = open === s.key;
          const selected = (value[s.key] ?? []) as string[];
          return (
            <div key={s.key}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => setOpen(expanded ? null : s.key)}
                aria-expanded={expanded}
                className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-white/[0.03] disabled:opacity-50"
              >
                <span className="text-zinc-300">{s.title}</span>
                <span className={isActive(s.key, value) ? "text-amber-300" : "text-zinc-500"}>
                  {summarize(s.key, value)} {expanded ? "▴" : "▾"}
                </span>
              </button>
              {expanded && (
                <div className="flex flex-wrap gap-2 px-3 pb-3">
                  {s.options.map((o) => (
                    <label
                      key={o.value}
                      className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs ${
                        selected.includes(o.value)
                          ? "border-amber-400/60 bg-amber-400/10 text-amber-200"
                          : "border-white/10 text-zinc-400 hover:border-white/25"
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="accent-amber-400"
                        disabled={disabled}
                        checked={selected.includes(o.value)}
                        onChange={() => toggle(s.key, o.value)}
                      />
                      {o.label}
                    </label>
                  ))}
                  {selected.length > 0 && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onChange({ ...value, [s.key]: [] })}
                      className="px-2 text-xs text-zinc-500 underline hover:text-zinc-300"
                    >
                      Reset to everyone
                    </button>
                  )}
                  <p className="w-full text-xs text-zinc-500">
                    Nothing ticked means everyone.
                    {s.key !== "languages" &&
                      " “Unknown” is people Google has no data for — often a large share of viewers."}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {anyActive && (
        <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          {NARROWING_WARNING}
        </p>
      )}
    </div>
  );
}
