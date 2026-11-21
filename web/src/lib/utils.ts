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

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function formatDuration(seconds: number | null): string {
  if (!seconds) return "—";
  return `${seconds}s`;
}
