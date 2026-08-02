// Copied verbatim from 3pandalabs/brand `footer/` — do not reword.
//
// The exact copy and the two-span layout (copyright left, "All rights
// reserved." right) are the canonical org footer, and RentVault, RsvpVault and
// MealMargin all render it identically. branding.md makes the brand repo the
// source of truth precisely so these don't drift app by app.
//
// AdVault briefly rendered "© 3PandaLabs LLC · Registered in USA. All rights
// reserved." as one span, which came from a product spec rather than the brand
// repo. If a future spec asks for different footer wording again, change it in
// 3pandalabs/brand first and sweep every app — one app quietly disagreeing
// about the company's own legal line is the failure mode this comment exists to
// prevent.
//
// The link back to 3pandalabs.com deliberately lives in the attribution tag
// (see Wordmark.tsx), not here — same as the other apps.
export function Footer() {
  return (
    <footer className="border-t border-white/10 px-6 py-8">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 text-sm text-zinc-500">
        <span>&copy; 3PandaLabs LLC, USA.</span>
        <span>All rights reserved.</span>
      </div>
    </footer>
  );
}
