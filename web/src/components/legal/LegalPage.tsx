import Link from "next/link";
import { WordmarkName, WordmarkTag } from "@/components/Wordmark";

// Shared shell for the legal pages. Two reasons it exists rather than each page
// carrying its own markup:
//
//   The prose styling is long (twelve arbitrary variants) and a legal page that
//   silently drifts from its sibling looks careless in exactly the place a
//   reader is deciding whether to trust us.
//
//   The Google Ads API reviewer reaches these pages from a bare URL, not from
//   the app, so each needs its own header and its own way back to the site.
//
// No @tailwindcss/typography here on purpose — it would be a dependency added
// for two pages, and the variants below are the same handful of rules.
const PROSE = [
  "[&_h2]:mt-12 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-zinc-100",
  "[&_h3]:mt-8 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-zinc-200",
  "[&_p]:my-4 [&_p]:leading-relaxed [&_p]:text-zinc-400",
  "[&_ul]:my-4 [&_ul]:space-y-2 [&_ul]:pl-5 [&_li]:list-disc [&_li]:text-zinc-400 [&_li]:leading-relaxed",
  "[&_li>strong]:font-medium [&_li>strong]:text-zinc-200",
  "[&_a]:text-amber-300 [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-amber-200",
  "[&_table]:my-6 [&_table]:w-full [&_table]:border-collapse [&_table]:text-left [&_table]:text-sm",
  "[&_th]:border-b [&_th]:border-white/15 [&_th]:pb-2 [&_th]:pr-4 [&_th]:font-medium [&_th]:text-zinc-300",
  "[&_td]:border-b [&_td]:border-white/5 [&_td]:py-3 [&_td]:pr-4 [&_td]:align-top [&_td]:text-zinc-400",
  "[&_strong]:text-zinc-200",
].join(" ");

export function LegalPage({
  title,
  effective,
  summary,
  children,
}: {
  title: string;
  effective: string;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <main>
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-6 py-6">
        <div className="text-lg font-semibold tracking-tight">
          <Link href="/">
            <WordmarkName />
          </Link>
          <WordmarkTag />
        </div>
        <nav className="text-sm">
          <Link href="/" className="rounded-lg px-3 py-2 text-zinc-300 hover:bg-white/10">
            Back to site
          </Link>
        </nav>
      </header>

      <article className="mx-auto w-full max-w-3xl px-6 pt-6 pb-20">
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 text-sm text-zinc-500">Effective {effective}</p>
        <p className="mt-6 border-l-2 border-amber-400/40 pl-4 text-lg leading-relaxed text-zinc-300">
          {summary}
        </p>
        <div className={PROSE}>{children}</div>
      </article>
    </main>
  );
}
