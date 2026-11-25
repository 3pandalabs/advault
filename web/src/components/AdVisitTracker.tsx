"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { trackAdVisit } from "@/lib/adAttribution";
import { countPage } from "@/lib/visitCount";

// Mounted once in the root layout: reports an ad-click visit (utm_campaign =
// an AdVault campaign id) once per session (lib/adAttribution),
// and counts each page in our own totals (lib/visitCount). Renders nothing.
export function AdVisitTracker() {
  const pathname = usePathname();
  useEffect(() => {
    trackAdVisit();
  }, []);
  useEffect(() => {
    countPage(pathname);
  }, [pathname]);
  return null;
}
