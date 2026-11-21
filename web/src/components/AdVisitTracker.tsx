"use client";

import { useEffect } from "react";
import { trackAdVisit } from "@/lib/adAttribution";

// Mounted once in the root layout: reports an ad-click visit (utm_campaign =
// an AdVault campaign id) once per session. Renders nothing. See lib/adAttribution.
export function AdVisitTracker() {
  useEffect(() => {
    trackAdVisit();
  }, []);
  return null;
}
