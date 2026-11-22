"use client";

import { useEffect, useState } from "react";
import { ApiError, getMe, updateWhatsApp, type WhatsAppState } from "@/lib/api/browser";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  COUNTRY_CODES,
  WHATSAPP_OPT_IN_TEXT,
  composePhone,
  looksLikePhone,
  splitPhone,
} from "@/lib/phone";

// WhatsApp for offer changes (api migration 0048, PATCH /auth/me). Three
// pieces, all driven by /auth/me `whatsapp`:
//   WhatsAppOfferNote   the "Next time, just WhatsApp your new offer" callout,
//                       ONLY when the loop answers this owner (enabled), so
//                       we never advertise a number that won't reply;
//   WhatsAppPrompt      the light inline "add your number" box (wizard,
//                       campaign page, Change my offer card); shows the note
//                       instead once enabled, nothing when saved but not
//                       available yet;
//   WhatsAppSettings    the full Settings section: edit, opt in/out, remove.

const ERRORS: Record<string, string> = {
  invalid_phone: "That number doesn't look right. Include the country code, for example +1 (201) 555-0123.",
  whatsapp_opt_in_needs_phone: "Add your mobile number first.",
};

function errorText(err: unknown): string {
  return err instanceof ApiError ? (ERRORS[err.code] ?? "Could not save. Please try again.") : "Could not save. Please try again.";
}

/** /auth/me `whatsapp`, loaded once per component. undefined while loading or on an older API. */
export function useWhatsAppState(): [WhatsAppState | undefined, (s: WhatsAppState | undefined) => void] {
  const [state, setState] = useState<WhatsAppState | undefined>(undefined);
  useEffect(() => {
    getMe()
      .then((me) => setState(me.whatsapp))
      .catch(() => undefined);
  }, []);
  return [state, setState];
}

/** The highlighted callout. Renders nothing unless the loop answers this owner. */
export function WhatsAppOfferNote({ state, className }: { state: WhatsAppState | undefined; className?: string }) {
  if (!state?.enabled || !state.publicNumber || !state.waLink) return null;
  return (
    <div className={cn("rounded-lg border border-emerald-400/40 bg-emerald-400/10 p-3 text-sm text-emerald-100", className)}>
      Next time, just WhatsApp your new offer (text, photo or voice note) to{" "}
      <a href={state.waLink} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">
        {state.publicNumber}
      </a>{" "}
      and we&apos;ll make the new ad.
    </div>
  );
}

/** The one-line version for the dashboard card's status line. */
export function WhatsAppOfferLine({ state }: { state: WhatsAppState | undefined }) {
  if (!state?.enabled || !state.publicNumber || !state.waLink) return null;
  return (
    <p className="mt-2 text-xs text-emerald-200">
      Next time, just WhatsApp your new offer to{" "}
      <a href={state.waLink} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">
        {state.publicNumber}
      </a>
      .
    </p>
  );
}

/** Country select + number input. */
export function PhoneFields({
  idPrefix,
  countryCode,
  number,
  onCountryCode,
  onNumber,
  disabled,
  label = "Mobile number (for WhatsApp)",
}: {
  idPrefix: string;
  countryCode: string;
  number: string;
  onCountryCode: (v: string) => void;
  onNumber: (v: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div>
      <Label htmlFor={`${idPrefix}-number`}>{label}</Label>
      <div className="flex gap-2">
        <select
          aria-label="Country code"
          value={countryCode}
          onChange={(e) => onCountryCode(e.target.value)}
          disabled={disabled}
          className="h-10 w-28 shrink-0 rounded-lg border border-white/15 bg-white/5 px-2 text-sm text-zinc-100 focus:border-amber-400/60 focus:outline-none focus:ring-1 focus:ring-amber-400/60"
        >
          {COUNTRY_CODES.map((c) => (
            <option key={c.code} value={c.code} className="bg-zinc-900">
              {c.label}
            </option>
          ))}
        </select>
        <Input
          id={`${idPrefix}-number`}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder="(201) 555-0123"
          value={number}
          onChange={(e) => onNumber(e.target.value)}
          disabled={disabled}
          className="min-w-0"
        />
      </div>
    </div>
  );
}

export function OptInCheckbox({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-2 text-sm text-zinc-300">
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 shrink-0 accent-amber-400"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span>{WHATSAPP_OPT_IN_TEXT}</span>
    </label>
  );
}

/**
 * The light inline box. Never blocks anything: "Not now" hides it for this
 * page view. Shows the note once enabled; nothing when the number is saved
 * and opted in but the loop isn't on for this account yet.
 */
export function WhatsAppPrompt({ className, title = "Change your offer from WhatsApp" }: { className?: string; title?: string }) {
  const [state, setState] = useWhatsAppState();
  const [hidden, setHidden] = useState(false);
  if (!state || hidden) return null;
  if (state.enabled) return <WhatsAppOfferNote state={state} className={className} />;
  if (state.phone && state.optedIn) return null;
  return (
    <div className={cn("rounded-lg border border-white/10 bg-white/[0.02] p-3 text-sm", className)}>
      <p className="font-medium text-zinc-100">{title}</p>
      <p className="mt-1 text-zinc-400">
        Add your mobile number and next time you can just WhatsApp us your new offer. Optional.
      </p>
      <PromptForm key={state.phone ?? ""} state={state} onState={setState} onHide={() => setHidden(true)} />
    </div>
  );
}

function PromptForm({
  state,
  onState,
  onHide,
}: {
  state: WhatsAppState;
  onState: (s: WhatsAppState) => void;
  onHide: () => void;
}) {
  const initial = splitPhone(state.phone);
  const [countryCode, setCountryCode] = useState(initial.countryCode);
  const [number, setNumber] = useState(initial.number);
  const [optIn, setOptIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const full = composePhone(countryCode, number);
    if (!looksLikePhone(full)) {
      setError(ERRORS.invalid_phone);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await updateWhatsApp({ phone: full, whatsappOptIn: optIn });
      if (r.whatsapp) onState(r.whatsapp);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-3">
      <PhoneFields
        idPrefix="wa-prompt"
        countryCode={countryCode}
        number={number}
        onCountryCode={setCountryCode}
        onNumber={setNumber}
        disabled={busy}
      />
      <OptInCheckbox checked={optIn} onChange={setOptIn} disabled={busy} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="button" onClick={save} disabled={busy || !number.trim()}>
          {busy ? "Saving…" : "Save my number"}
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onHide} disabled={busy}>
          Not now
        </Button>
      </div>
      {error && <p className="text-red-300">{error}</p>}
    </div>
  );
}

/** Settings → "WhatsApp for offer changes". */
export function WhatsAppSettings() {
  const [state, setState] = useWhatsAppState();
  const [saved, setSaved] = useState(false);
  if (!state) return null;
  return (
    <div className="space-y-3">
      <WhatsAppOfferNote state={state} />
      <SettingsForm
        key={`${state.phone ?? ""}|${state.optedIn}`}
        state={state}
        onState={(s) => {
          setState(s);
          setSaved(true);
        }}
        onEdit={() => setSaved(false)}
      />
      {saved && <p className="text-sm text-emerald-300">Saved.</p>}
    </div>
  );
}

function SettingsForm({
  state,
  onState,
  onEdit,
}: {
  state: WhatsAppState;
  onState: (s: WhatsAppState) => void;
  onEdit: () => void;
}) {
  const initial = splitPhone(state.phone);
  const [countryCode, setCountryCode] = useState(initial.countryCode);
  const [number, setNumber] = useState(initial.number);
  const [optIn, setOptIn] = useState(state.optedIn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(body: { phone?: string | null; whatsappOptIn?: boolean }) {
    setBusy(true);
    setError(null);
    onEdit();
    try {
      const r = await updateWhatsApp(body);
      if (r.whatsapp) onState(r.whatsapp);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const full = composePhone(countryCode, number);
    if (!full) return run({ phone: null });
    if (!looksLikePhone(full)) {
      setError(ERRORS.invalid_phone);
      return;
    }
    return run({ phone: full, whatsappOptIn: optIn });
  }

  return (
    <>
      <PhoneFields
        idPrefix="wa-settings"
        countryCode={countryCode}
        number={number}
        onCountryCode={setCountryCode}
        onNumber={setNumber}
        disabled={busy}
      />
      <OptInCheckbox checked={optIn} onChange={setOptIn} disabled={busy} />
      {state.phone && state.optedIn && !state.available && (
        <p className="text-xs text-zinc-500">Saved. We&apos;ll tell you here when changing your offer on WhatsApp is open for your account.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
        {state.phone && (
          <Button size="sm" type="button" variant="outline" onClick={() => run({ phone: null })} disabled={busy}>
            Remove my number
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}
    </>
  );
}
