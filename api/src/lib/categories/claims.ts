// Claim checks per category. The rules moved to lib/compliance/claimRules.ts
// (2026-11-20) so block / review / warn live in ONE config; this module keeps
// the old import path. The API refuses blocks on every route that saves an
// offer (POST/PATCH /campaigns, PUT /campaigns/:id/offer), flags reviews
// (lib/compliance), and the web shows every flag as the owner types.
export { claimBlock, claimFlags, claimReviews, type ClaimFlag, type ClaimLevel } from "../compliance/claimRules.js";
