"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CardDescription, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { COMMON_MAKES, MAX_MAKES, neighborOfferText, type CategoryExtras } from "@/lib/categories/extras";

// Category extras (api lib/categories/extras): a restaurant's featured dish
// and order link, an auto shop's makes, a landscaper's customer ZIPs. The
// fields only; saving is the caller's. Used by the new-campaign wizard (sent
// with the create, so the FIRST ad has them) and the campaign page's
// ExtrasCard (PUT /campaigns/:id/extras, for the next ad).

export type ExtrasPhoto = { id: string; url?: string; label?: string };

export function CategoryExtrasFields({
  available,
  value,
  onChange,
  photos,
  zipText,
  onZipText,
  orderUrlAction,
  zipsAction,
  disabled,
}: {
  available: readonly (keyof CategoryExtras)[];
  value: CategoryExtras;
  onChange: (next: CategoryExtras) => void;
  /** Candidates for the dish photo. */
  photos: ExtrasPhoto[];
  zipText: string;
  onZipText: (text: string) => void;
  /** Shown under the order link (e.g. "use it as my ad's link"). */
  orderUrlAction?: ReactNode;
  /** Shown under the customer ZIPs (e.g. "show my ad there", neighbor price). */
  zipsAction?: ReactNode;
  disabled?: boolean;
}) {
  const [makeText, setMakeText] = useState("");
  const has = (k: keyof CategoryExtras) => available.includes(k);
  const makes = value.makes ?? [];

  function toggleMake(m: string) {
    const next = makes.includes(m) ? makes.filter((x) => x !== m) : makes.length < MAX_MAKES ? [...makes, m] : makes;
    onChange({ ...value, makes: next });
  }

  return (
    <div className="space-y-4">
      {has("spotlight") && (
        <div className="space-y-3 text-sm">
          <div>
            <CardTitle>Feature one dish</CardTitle>
            <CardDescription>Your best dish, its photo and price lead your ad.</CardDescription>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Label htmlFor="dish">Dish</Label>
              <Input
                id="dish"
                maxLength={40}
                placeholder="Wood-fired Margherita"
                value={value.spotlight?.dish ?? ""}
                disabled={disabled}
                onChange={(e) => onChange({ ...value, spotlight: { ...value.spotlight, dish: e.target.value } })}
              />
            </div>
            <div>
              <Label htmlFor="dish-price">Price (optional)</Label>
              <Input
                id="dish-price"
                maxLength={12}
                placeholder="$14"
                value={value.spotlight?.price ?? ""}
                disabled={disabled}
                onChange={(e) =>
                  onChange({ ...value, spotlight: { dish: value.spotlight?.dish ?? "", ...value.spotlight, price: e.target.value } })
                }
              />
            </div>
          </div>
          {photos.length > 0 && (
            <div>
              <p className="mb-1.5 text-zinc-400">Its photo</p>
              <div className="flex flex-wrap gap-2">
                {photos.map((p) => {
                  const picked = value.spotlight?.assetId === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      aria-pressed={picked}
                      aria-label={p.label ?? "Photo"}
                      disabled={disabled}
                      onClick={() =>
                        onChange({
                          ...value,
                          spotlight: { dish: value.spotlight?.dish ?? "", ...value.spotlight, assetId: picked ? null : p.id },
                        })
                      }
                      className={`h-16 w-16 overflow-hidden rounded-md border-2 ${picked ? "border-amber-400" : "border-transparent"}`}
                    >
                      {p.url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <span className="block h-full w-full bg-zinc-800" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {has("orderUrl") && (
        <div className="space-y-2 text-sm">
          <Label htmlFor="order-url">Order or reserve link (optional)</Label>
          <Input
            id="order-url"
            type="url"
            maxLength={500}
            placeholder="https://order.example.com/your-restaurant"
            value={value.orderUrl ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, orderUrl: e.target.value })}
          />
          {orderUrlAction}
        </div>
      )}

      {has("makes") && (
        <div className="space-y-3 text-sm">
          <div>
            <CardTitle>Makes you service</CardTitle>
            <CardDescription>Shown on your ad, for example &ldquo;We service Toyota · Honda · Ford&rdquo;.</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {[...new Set([...COMMON_MAKES, ...makes])].map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={makes.includes(m)}
                disabled={disabled}
                onClick={() => toggleMake(m)}
                className={`rounded-md border px-3 py-1 ${makes.includes(m) ? "border-emerald-400 bg-emerald-400/10 text-emerald-200" : "border-zinc-700 text-zinc-400"}`}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Another make"
              className="w-44"
              maxLength={20}
              placeholder="Another make"
              value={makeText}
              disabled={disabled}
              onChange={(e) => setMakeText(e.target.value)}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || !makeText.trim()}
              onClick={() => {
                toggleMake(makeText.trim());
                setMakeText("");
              }}
            >
              Add
            </Button>
          </div>
          <p className="text-xs text-zinc-400">Up to {MAX_MAKES}. Pick only makes you really work on.</p>
        </div>
      )}

      {has("neighborZips") && (
        <div className="space-y-3 text-sm">
          <div>
            <CardTitle>Show your ad where you already work</CardTitle>
            <CardDescription>
              Type the ZIP codes of your current customers. Neighbors see your trucks every week, so they trust you faster.
            </CardDescription>
          </div>
          <Textarea
            aria-label="ZIP codes of your customers"
            className="min-h-16"
            placeholder="08817, 08820, 08837"
            value={zipText}
            disabled={disabled}
            onChange={(e) => onZipText(e.target.value)}
          />
          {zipsAction}
        </div>
      )}
    </div>
  );
}

/** Landscaping: "Neighbor price" offer copy, one tap into the offer. */
export function NeighborPriceField({ onUse, disabled }: { onUse: (text: string) => void; disabled?: boolean }) {
  const [deal, setDeal] = useState("");
  const text = neighborOfferText(deal);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="neighbor-deal">Neighbor price (optional)</Label>
          <Input
            id="neighbor-deal"
            className="w-56"
            maxLength={40}
            placeholder="$10 off your first mow"
            value={deal}
            disabled={disabled}
            onChange={(e) => setDeal(e.target.value)}
          />
        </div>
        <Button size="sm" variant="ghost" disabled={disabled || !text} onClick={() => text && onUse(text)}>
          Use as my offer
        </Button>
      </div>
      {text && <p className="text-xs text-zinc-400">“{text}”</p>}
    </div>
  );
}
