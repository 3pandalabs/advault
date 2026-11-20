// The public "Report this ad" link (web /report?ad=<public id>). Uses the
// campaign's unguessable public_id (migration 0043), never its internal uuid.
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "https://advault.3pandalabs.com";

export function reportUrl(publicId: string): string {
  return `${WEB_ORIGIN}/report?ad=${encodeURIComponent(publicId)}`;
}

export const REPORT_REASONS = [
  "false_or_misleading",
  "scam_or_fraud",
  "offensive",
  "copyright_or_privacy",
  "prohibited_product",
  "other",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** Reports one IP may file per hour (POST /reports). */
export const REPORTS_PER_IP_PER_HOUR = 5;
