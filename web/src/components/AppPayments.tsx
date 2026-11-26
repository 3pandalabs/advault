"use client";

import { useEffect, useSyncExternalStore } from "react";
import { APP_PAYMENTS_MESSAGE, isInAndroidApp } from "@/lib/appPayments";

// TODO(play-billing): Android app = payments on the website only (temporary,
// CLAUDE.md "Android app: payments on the website only").

/**
 * True inside the AdVault Android app. False on the server and while
 * hydrating (no mismatch), then the real answer.
 */
const noSubscribe = () => () => {};
export function useInAndroidApp(): boolean {
  // Server snapshot false; the client reads the real answer after hydration.
  return useSyncExternalStore(noSubscribe, isInAndroidApp, () => false);
}

/** Root layout: records "in the app" on the first page, while the TWA referrer is still there. */
export function AppContextRecorder() {
  useEffect(() => {
    isInAndroidApp();
  }, []);
  return null;
}

/** Shown in place of a payment button inside the app. Plain text: no link, no button. */
export function AppPaymentsNotice({ className = "" }: { className?: string }) {
  return (
    <p role="note" className={`rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-300 ${className}`}>
      {APP_PAYMENTS_MESSAGE}
    </p>
  );
}

/** Renders `children` (a payment button / picker) on the website, the notice in the app. */
export function WebOnlyPayment({ children, className }: { children: React.ReactNode; className?: string }) {
  const inApp = useInAndroidApp();
  return inApp ? <AppPaymentsNotice className={className} /> : <>{children}</>;
}
