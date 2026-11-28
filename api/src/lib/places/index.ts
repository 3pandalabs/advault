// "Find my business on Google" (2026-11-27, migration 0051). Google Places
// API (New), server side only, with GOOGLE_PLACES_API_KEY (optional: unset =
// the whole step is hidden and every call here answers "not configured").
//
// Terms we follow: only the place_id is stored long term (campaigns.
// google_place_id; Google allows caching it). Everything else is shown to the
// owner to prefill THEIR fields, which they can edit, and is never stored by
// us as Places content; the rating is re-fetched at render time. Never review
// text, never Google Maps photos.
//
// Cost: field masks keep each call to the fields we use. Text Search with
// id + displayName + formattedAddress (Text Search Pro SKU), then one Place
// Details with the prefill fields below: phone, website, hours, rating and
// rating count put Details in the Enterprise SKU. See the PR / ROUTES.md for
// the per-lookup estimate. The rating-only call at render time is Details
// Enterprise too (rating, userRatingCount).

const BASE = "https://places.googleapis.com/v1";

export const SEARCH_FIELDS = "places.id,places.displayName,places.formattedAddress";
export const DETAILS_FIELDS =
  "id,displayName,formattedAddress,nationalPhoneNumber,websiteUri,regularOpeningHours,primaryType,rating,userRatingCount,googleMapsUri";
export const RATING_FIELDS = "rating,userRatingCount";

export const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;

/** The rating may appear in an ad only from 4.0 stars with 5+ reviews. */
export const MIN_AD_RATING = 4.0;
export const MIN_AD_RATING_COUNT = 5;

export function placesConfigured(): boolean {
  return Boolean(process.env.GOOGLE_PLACES_API_KEY);
}

export type PlaceCandidate = { placeId: string; name: string; address: string };

export type PlaceDetails = {
  placeId: string;
  name: string;
  address: string;
  zip: string | null;
  city: string | null;
  phone: string | null;
  website: string | null;
  primaryType: string | null;
  hours: string | null;
  rating: number | null;
  ratingCount: number | null;
  mapsUrl: string | null;
  /** May "Show my Google rating in the ad" be offered? */
  ratingEligible: boolean;
};

export function ratingEligible(rating: number | null | undefined, count: number | null | undefined): boolean {
  return typeof rating === "number" && typeof count === "number" && rating >= MIN_AD_RATING && count >= MIN_AD_RATING_COUNT;
}

/** "★ 4.8 on Google (120 reviews)": attributed, numbers only, never review text. */
export function ratingLine(rating: number, count: number): string {
  return `★ ${rating.toFixed(1)} on Google (${count.toLocaleString("en-US")} review${count === 1 ? "" : "s"})`;
}

/** US ZIP or Indian PIN from a formatted address (the last one in it). */
export function zipFromAddress(address: string): string | null {
  const m = [...address.matchAll(/\b(\d{5})(?:-\d{4})?\b|\b(\d{6})\b/g)].pop();
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** "123 Main St, Springfield, IL 62701, USA" -> "Springfield". */
export function cityFromAddress(address: string): string | null {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  const zipAt = parts.findIndex((p) => /\b\d{5}(?:-\d{4})?\b|\b\d{6}\b/.test(p));
  const city = zipAt > 0 ? parts[zipAt - 1] : parts.length >= 3 ? parts[parts.length - 3] : null;
  return city && !/\d/.test(city) ? city : null;
}

export function hoursText(h: { weekdayDescriptions?: string[] } | undefined): string | null {
  const days = h?.weekdayDescriptions?.filter(Boolean) ?? [];
  return days.length ? days.join("; ").replace(/ | /g, " ").slice(0, 400) : null;
}

async function call(path: string, init: RequestInit & { fieldMask: string }): Promise<Response> {
  const { fieldMask, ...rest } = init;
  return fetch(`${BASE}${path}`, {
    ...rest,
    headers: {
      "x-goog-api-key": process.env.GOOGLE_PLACES_API_KEY!,
      "x-goog-fieldmask": fieldMask,
      ...(rest.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(8_000),
  });
}

type RawPlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  primaryType?: string;
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
};

export class PlacesError extends Error {}

/** Up to 5 matches for "name, town". */
export async function searchPlaces(query: string, regionCode = "US"): Promise<PlaceCandidate[]> {
  if (!placesConfigured()) throw new PlacesError("places_not_configured");
  const res = await call("/places:searchText", {
    method: "POST",
    fieldMask: SEARCH_FIELDS,
    body: JSON.stringify({ textQuery: query, pageSize: 5, regionCode }),
  });
  if (!res.ok) throw new PlacesError(`places_search_${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { places?: RawPlace[] };
  return (body.places ?? [])
    .filter((p) => p.id && PLACE_ID_RE.test(p.id))
    .map((p) => ({ placeId: p.id!, name: p.displayName?.text ?? "", address: p.formattedAddress ?? "" }))
    .slice(0, 5);
}

export function toDetails(p: RawPlace, placeId: string): PlaceDetails {
  const address = p.formattedAddress ?? "";
  const rating = typeof p.rating === "number" ? p.rating : null;
  const ratingCount = typeof p.userRatingCount === "number" ? p.userRatingCount : null;
  return {
    placeId: p.id ?? placeId,
    name: p.displayName?.text ?? "",
    address,
    zip: zipFromAddress(address),
    city: cityFromAddress(address),
    phone: p.nationalPhoneNumber ?? null,
    website: p.websiteUri && /^https?:\/\//i.test(p.websiteUri) ? p.websiteUri : null,
    primaryType: p.primaryType ?? null,
    hours: hoursText(p.regularOpeningHours),
    rating,
    ratingCount,
    mapsUrl: p.googleMapsUri ?? null,
    ratingEligible: ratingEligible(rating, ratingCount),
  };
}

/** One place's prefill fields. null = Google has no such place. */
export async function placeDetails(placeId: string): Promise<PlaceDetails | null> {
  if (!placesConfigured()) throw new PlacesError("places_not_configured");
  if (!PLACE_ID_RE.test(placeId)) return null;
  const res = await call(`/places/${encodeURIComponent(placeId)}`, { method: "GET", fieldMask: DETAILS_FIELDS });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new PlacesError(`places_details_${res.status}`);
  return toDetails((await res.json()) as RawPlace, placeId);
}

/** The rating only, fresh (render time). null on any problem: the ad just goes without it. */
export async function placeRating(placeId: string): Promise<{ rating: number; count: number } | null> {
  if (!placesConfigured() || !PLACE_ID_RE.test(placeId)) return null;
  try {
    const res = await call(`/places/${encodeURIComponent(placeId)}`, { method: "GET", fieldMask: RATING_FIELDS });
    if (!res.ok) return null;
    const p = (await res.json()) as RawPlace;
    return typeof p.rating === "number" && typeof p.userRatingCount === "number" ? { rating: p.rating, count: p.userRatingCount } : null;
  } catch {
    return null;
  }
}

/** The end-card line for an ad whose owner ticked "Show my Google rating", or null. */
export async function adRatingLine(placeId: string | null | undefined, wanted: boolean): Promise<string | null> {
  if (!wanted || !placeId) return null;
  const r = await placeRating(placeId);
  return r && ratingEligible(r.rating, r.count) ? ratingLine(r.rating, r.count) : null;
}

// Per-user limit: a typo-and-retry search is a few calls; anything more is a
// loop or abuse, and every call costs money.
const HOUR = 60 * 60_000;
export const PLACES_CALLS_PER_USER_PER_HOUR = 30;
const calls = new Map<string, number[]>();

export function allowPlacesCall(userId: string, now = Date.now()): boolean {
  const list = (calls.get(userId) ?? []).filter((t) => t > now - HOUR);
  if (list.length >= PLACES_CALLS_PER_USER_PER_HOUR) {
    calls.set(userId, list);
    return false;
  }
  list.push(now);
  calls.set(userId, list);
  return true;
}

export function resetPlacesLimits() {
  calls.clear();
}
