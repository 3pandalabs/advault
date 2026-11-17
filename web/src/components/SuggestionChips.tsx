"use client";

import { cn } from "@/lib/utils";

// One-tap fill for a text box: a row of small chips under the field, each one
// a suggested value. Tapping a chip REPLACES whatever is in the box (simple
// and predictable: no merge, no confirm) and puts the cursor at the end so the
// owner can edit straight away. Suggestions come from what the page already
// knows (the business, the category, the campaign); this never fetches.
//
// A chip is hidden once the box already holds exactly that text, so a filled
// field shows only the alternatives. No chips at all when nothing is left.

const MAX_CHIPS = 3;

/** The suggestions worth showing: non-empty, deduped, not the current value, at most three. */
export function visibleSuggestions(
  suggestions: readonly (string | null | undefined | false)[],
  value: string,
): string[] {
  const current = value.trim();
  const out: string[] = [];
  for (const s of suggestions) {
    const t = typeof s === "string" ? s.trim() : "";
    if (!t || t === current || out.includes(t)) continue;
    out.push(t);
    if (out.length === MAX_CHIPS) break;
  }
  return out;
}

export function SuggestionChips({
  targetId,
  value,
  suggestions,
  onPick,
  fieldLabel,
  disabled,
  className,
}: {
  /** The id of the input or textarea to focus after filling. */
  targetId: string;
  /** The field's current value (controlled input). */
  value: string;
  suggestions: readonly (string | null | undefined | false)[];
  /** Sets the field's state to the chosen text. */
  onPick: (text: string) => void;
  /** Read out by screen readers: "Fill <fieldLabel> with: …". */
  fieldLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const shown = visibleSuggestions(suggestions, value);
  if (shown.length === 0) return null;

  function pick(text: string) {
    onPick(text);
    // After React has re-rendered with the new value: focus, caret at the end.
    requestAnimationFrame(() => {
      const el = document.getElementById(targetId);
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
      el.focus();
      try {
        el.setSelectionRange(el.value.length, el.value.length);
      } catch {
        // type="url" and friends don't support selection ranges.
      }
    });
  }

  return (
    <div className={cn("mt-1.5 flex flex-wrap gap-2", className)} role="group" aria-label={`Suggestions for ${fieldLabel}`}>
      {shown.map((text) => (
        <button
          key={text}
          type="button"
          disabled={disabled}
          onClick={() => pick(text)}
          aria-label={`Fill ${fieldLabel} with: ${text}`}
          title={text}
          className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/5 px-3 py-1 text-left text-xs text-amber-200 transition-colors hover:border-amber-400/60 hover:bg-amber-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 disabled:pointer-events-none disabled:opacity-50 sm:min-h-8"
        >
          <span aria-hidden="true">✨</span>
          <span className="shrink-0 font-medium text-amber-300">Use:</span>
          <span className="min-w-0 truncate">{text}</span>
        </button>
      ))}
    </div>
  );
}
