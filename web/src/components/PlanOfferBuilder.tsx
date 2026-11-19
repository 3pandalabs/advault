"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { categoryKey } from "@/lib/categories/key";
import {
  PLAN_OFFER_CATEGORIES,
  PLAN_OFFER_DETAIL,
  PLAN_SERVICE,
  planOfferProblem,
  planOfferText,
  type FirstVisitDeal,
  type PlanCadence,
} from "@/lib/categories/planOffer";

type DealChoice = "none" | "percent" | "amount" | "free";

/** Landscaping, Cleaning services and HVAC: build a recurring plan offer (api lib/categories/planOffer). */
export function planOfferAvailable(category: string): boolean {
  const k = categoryKey(category);
  return Boolean(k && PLAN_OFFER_CATEGORIES.includes(k));
}

export function PlanOfferBuilder({
  category,
  currencyCode,
  onUse,
}: {
  category: string;
  currencyCode: string;
  onUse: (text: string) => void;
}) {
  const key = categoryKey(category);
  const [open, setOpen] = useState(false);
  const [service, setService] = useState((key && PLAN_SERVICE[key]) || "");
  const [cadence, setCadence] = useState<PlanCadence>("visit");
  const [price, setPrice] = useState("");
  const [deal, setDeal] = useState<DealChoice>("none");
  const [dealValue, setDealValue] = useState("");

  if (!planOfferAvailable(category)) return null;
  const symbol = currencyCode === "INR" ? "₹" : "$";

  if (!open) {
    return (
      <button type="button" className="mt-2 text-xs text-sky-300 underline" onClick={() => setOpen(true)}>
        Sell a plan? Build a weekly, monthly or seasonal offer
      </button>
    );
  }

  const firstVisit: FirstVisitDeal | null =
    deal === "free"
      ? { kind: "free" }
      : deal === "percent"
        ? { kind: "percent", value: Number(dealValue) }
        : deal === "amount"
          ? { kind: "amount", value: Number(dealValue) }
          : null;
  const input = { service, cadence, price: Number(price), currencyCode, firstVisit };
  const problem = price.trim() === "" ? null : planOfferProblem(input);
  const text = price.trim() === "" ? null : planOfferText(input);

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-zinc-800 p-3 text-sm">
      <p className="font-medium">Plan offer</p>
      <div>
        <Label htmlFor="plan-service">What the plan is</Label>
        <Input id="plan-service" maxLength={80} value={service} onChange={(e) => setService(e.target.value)} />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="plan-price">Price ({symbol})</Label>
          <Input
            id="plan-price"
            inputMode="decimal"
            className="w-28"
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {(["visit", "month", "season"] as const).map((c) => (
            <label key={c} className="flex items-center gap-1.5">
              <input type="radio" checked={cadence === c} onChange={() => setCadence(c)} />
              {c === "visit" ? "per visit" : c === "month" ? "per month" : "per season"}
            </label>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-zinc-400">First-visit deal (optional)</p>
        <div className="flex flex-wrap items-center gap-3">
          {(["none", "percent", "amount", "free"] as const).map((d) => (
            <label key={d} className="flex items-center gap-1.5">
              <input type="radio" checked={deal === d} onChange={() => setDeal(d)} />
              {d === "none" ? "None" : d === "percent" ? "% off" : d === "amount" ? `${symbol} off` : "Free"}
            </label>
          ))}
          {(deal === "percent" || deal === "amount") && (
            <Input
              aria-label={deal === "percent" ? "Percent off" : "Amount off"}
              inputMode="decimal"
              className="w-24"
              value={dealValue}
              onChange={(e) => setDealValue(e.target.value.replace(/[^\d.]/g, ""))}
            />
          )}
        </div>
      </div>
      {problem && <p className="text-xs text-red-300">{PLAN_OFFER_DETAIL[problem]}</p>}
      {text && <p className="rounded-lg bg-zinc-900/60 px-3 py-2 text-zinc-200">“{text}”</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
        <Button size="sm" disabled={!text} onClick={() => text && onUse(text)}>
          Use this as my offer
        </Button>
      </div>
    </div>
  );
}
