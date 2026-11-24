import type { Metadata } from "next";
import Link from "next/link";
import { WordmarkName, WordmarkTag } from "@/components/Wordmark";

export const metadata: Metadata = {
  title: "Contact us",
  description: "Email or call the AdVault team at 3PandaLabs.",
  alternates: { canonical: "/contact" },
};

const LINK = "font-medium text-amber-300 underline";

export default function ContactPage() {
  return (
    <main className="mx-auto w-full max-w-xl px-6 py-12">
      <div className="mb-10 text-lg font-semibold tracking-tight">
        <Link href="/">
          <WordmarkName />
        </Link>
        <WordmarkTag />
      </div>
      <h1 className="text-3xl font-semibold tracking-tight">Contact us</h1>
      <p className="mt-3 text-zinc-400">
        Questions about your ad, your website or a charge? Email or call us. AdVault is made by 3PandaLabs LLC.
      </p>
      <dl className="mt-8 space-y-5 rounded-xl border border-white/10 bg-white/[0.02] p-6">
        <div>
          <dt className="text-sm text-zinc-500">Email</dt>
          <dd>
            <a href="mailto:advault@3pandalabs.com" className={LINK}>
              advault@3pandalabs.com
            </a>
          </dd>
        </div>
        <div>
          <dt className="text-sm text-zinc-500">Phone</dt>
          <dd>
            <a href="tel:+13323168453" className={LINK}>
              +1 (332) 316-8453
            </a>
          </dd>
        </div>
      </dl>
      <p className="mt-6 text-sm text-zinc-400">
        Something wrong with an ad you saw?{" "}
        <Link href="/report" className={LINK}>
          Report an ad
        </Link>
        .
      </p>
    </main>
  );
}
