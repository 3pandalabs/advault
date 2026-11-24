import type { Metadata } from "next";
import Link from "next/link";
import { WordmarkName, WordmarkTag } from "@/components/Wordmark";
import { FAQ } from "@/lib/help/faq";

export const metadata: Metadata = {
  title: "FAQ",
  description: "How AdVault works: your ad, your website, prices, ad budget and how often your ad is shown.",
  alternates: { canonical: "/faq" },
};

const LINK = "font-medium text-amber-300 underline";

export default function FaqPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <div className="mb-10 text-lg font-semibold tracking-tight">
        <Link href="/">
          <WordmarkName />
        </Link>
        <WordmarkTag />
      </div>
      <h1 className="text-3xl font-semibold tracking-tight">Frequently asked questions</h1>
      <p className="mt-3 text-zinc-400">
        Can&apos;t find your answer?{" "}
        <Link href="/contact" className={LINK}>
          Contact us
        </Link>
        .
      </p>
      <div className="mt-8 divide-y divide-white/10 rounded-xl border border-white/10">
        {FAQ.map((f) => (
          <details key={f.q} className="group px-5 py-4">
            <summary className="cursor-pointer list-none font-medium text-zinc-200 [&::-webkit-details-marker]:hidden">
              <span className="mr-2 inline-block text-amber-300 transition group-open:rotate-90">›</span>
              {f.q}
            </summary>
            <p className="mt-2 pl-5 text-sm text-zinc-400">{f.a}</p>
          </details>
        ))}
      </div>
    </main>
  );
}
