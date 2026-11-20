"use client";

// The client's two ticks (api lib/compliance): required before AdVault makes,
// orders, uploads or launches an ad. The API refuses without them (400
// attestation_required) and records each press with the exact text, version,
// IP and user agent. The sentences come from lib/compliance/texts.ts, the
// word-for-word mirror of the API's copy: never reword them here.
import { useState } from "react";
import type { Attestation } from "@/lib/api/browser";
import { ATTESTATION_ACCURACY_TEXT, ATTESTATION_MEDIA_TEXT, ATTESTATION_VERSION } from "@/lib/compliance/texts";

export type AttestationTicks = { accuracy: boolean; media: boolean };

/** The two ticks' state, and the body to send once both are ticked (else null). */
export function useAttestation(): [AttestationTicks, (t: AttestationTicks) => void, Attestation | null] {
  const [ticks, setTicks] = useState<AttestationTicks>({ accuracy: false, media: false });
  return [ticks, setTicks, attestationOf(ticks)];
}

export function attestationOf(t: AttestationTicks): Attestation | null {
  return t.accuracy && t.media ? { accuracy: true, media: true, version: ATTESTATION_VERSION } : null;
}

export function AttestationChecks({
  value,
  onChange,
  disabled,
  className,
}: {
  value: AttestationTicks;
  onChange: (t: AttestationTicks) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <fieldset className={`space-y-2 rounded-md border border-white/10 bg-white/[0.03] p-3 ${className ?? ""}`}>
      <legend className="px-1 text-xs font-medium uppercase tracking-wide text-zinc-400">Before we go ahead</legend>
      <label className="flex items-start gap-2 text-sm text-zinc-200">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 accent-amber-400"
          checked={value.accuracy}
          onChange={(e) => onChange({ ...value, accuracy: e.target.checked })}
          disabled={disabled}
        />
        <span>{ATTESTATION_ACCURACY_TEXT}</span>
      </label>
      <label className="flex items-start gap-2 text-sm text-zinc-200">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 accent-amber-400"
          checked={value.media}
          onChange={(e) => onChange({ ...value, media: e.target.checked })}
          disabled={disabled}
        />
        <span>{ATTESTATION_MEDIA_TEXT}</span>
      </label>
      <p className="text-xs text-zinc-500">
        See our{" "}
        <a href="/terms" target="_blank" rel="noreferrer" className="underline">
          Terms of Service
        </a>{" "}
        and{" "}
        <a href="/content-policy" target="_blank" rel="noreferrer" className="underline">
          Content Policy
        </a>
        .
      </p>
    </fieldset>
  );
}
