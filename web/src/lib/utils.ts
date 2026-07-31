import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Budgets are stored and sent as integer minor units — never floats. A float
// daily budget accumulates representation error into something that gets
// charged to a real card, and Google's own API takes micros for the same
// reason. Formatting is the only place they become a decimal.
export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function parseDollarsToCents(input: string): number | null {
  const value = Number(input.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

export function formatDuration(seconds: number | null): string {
  if (!seconds) return "—";
  return `${seconds}s`;
}
