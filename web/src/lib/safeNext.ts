// Where to go after signing in: only a relative, same-origin path ("/...").
// Never "//host", "/\host", a scheme or control characters, so a `next` or
// `to` in a link can't send anyone off AdVault (no open redirect). Mirrors
// api/src/lib/signinHandoff safeNextPath.
export function safeNextPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 500) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  try {
    const base = "https://app.invalid";
    const u = new URL(raw, base);
    if (u.origin !== base) return fallback;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return fallback;
  }
}
