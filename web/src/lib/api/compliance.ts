"use client";

import { api, API_URL, ApiError } from "@/lib/api/browser";

// Client attestation & compliance (api/src/routes/reports.ts, routes/auth.ts).

export type TermsState = { accepted: string | null; current: string; ok: boolean };

export const acceptTerms = (version: string) =>
  api<{ terms: TermsState }>("/auth/me/terms", { method: "POST", body: JSON.stringify({ version }) });

// ---- public "Report this ad" (no session) ----

export const REPORT_REASONS = [
  { value: "false_or_misleading", label: "False or misleading" },
  { value: "scam_or_fraud", label: "Scam or fraud" },
  { value: "offensive", label: "Offensive or inappropriate" },
  { value: "copyright_or_privacy", label: "Uses my photos, video or likeness without permission" },
  { value: "prohibited_product", label: "Prohibited product or service" },
  { value: "other", label: "Something else" },
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number]["value"];

export type PublicAdStatus = { status: "active"; businessName: string } | { status: "removed" } | { status: "not_found" };

async function publicFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
}

export async function getPublicAd(publicId: string): Promise<PublicAdStatus> {
  const res = await publicFetch(`/reports/ad/${encodeURIComponent(publicId)}`);
  // A malformed id fails validation (400): to the visitor it is just unknown.
  if (res.status === 404 || res.status === 400) return { status: "not_found" };
  if (!res.ok) throw new ApiError(res.status, "request_failed");
  return (await res.json()) as PublicAdStatus;
}

export async function submitReport(input: { ad: string; reason: ReportReason; details?: string; email?: string }) {
  const res = await publicFetch("/reports", { method: "POST", body: JSON.stringify(input) });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? "request_failed");
  }
  return (await res.json()) as { id: string };
}

// ---- admin ----

export type ComplianceStatus = "ok" | "needs_review" | "taken_down";
export type ComplianceReason = { id: string; phrase: string; reason: string; field: string; approved?: boolean };

export type AdminReportStatus = "open" | "dismissed" | "actioned";
export type AdminReport = {
  id: string;
  reason: ReportReason;
  details: string | null;
  reporterEmail: string | null;
  status: AdminReportStatus;
  createdAt: string;
  handledAt: string | null;
  campaignId: string | null;
  publicId: string | null;
  campaignName: string | null;
  businessName: string | null;
  campaignStatus: string | null;
  complianceStatus: ComplianceStatus | null;
  landingUrl: string | null;
  ownerEmail: string | null;
};

export const listAdminReports = (status: AdminReportStatus) =>
  api<{ status: AdminReportStatus; reports: AdminReport[] }>(`/admin/reports?status=${status}`);

export const dismissReport = (reportId: string) =>
  api<unknown>(`/admin/reports/${reportId}/dismiss`, { method: "POST" });

export type TakedownResult = {
  takenDown: true;
  google: "paused" | "not_launched" | "already_paused" | "failed" | "unreachable";
  videos: { videoId: string; private: boolean; reason?: string }[];
};

export const takeDownCampaign = (campaignId: string, reason: string) =>
  api<TakedownResult>(`/admin/campaigns/${campaignId}/takedown`, { method: "POST", body: JSON.stringify({ reason }) });

export type ComplianceCampaign = {
  campaignId: string;
  name: string;
  businessName: string;
  businessCategory: string | null;
  offerDetails: string | null;
  status: string;
  complianceStatus: ComplianceStatus;
  complianceReasons: ComplianceReason[] | null;
  takenDownAt: string | null;
  takenDownReason: string | null;
  updatedAt: string;
  ownerEmail: string;
};

export const getComplianceQueue = () =>
  api<{ needsReview: ComplianceCampaign[]; takenDown: ComplianceCampaign[] }>("/admin/compliance");

export const approveWording = (campaignId: string) =>
  api<{ id: string; complianceStatus: ComplianceStatus }>(`/admin/compliance/${campaignId}/approve`, { method: "POST" });
