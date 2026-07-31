import Link from "next/link";
import { Wordmark, WordmarkName, WordmarkTag } from "@/components/Wordmark";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

// Server-rendered and fully static — no API call, so this page is up even when
// the backend is not, and it produces a real link preview.

const STEPS = [
  {
    title: "Upload a few photos",
    body: "Three to five shots of your storefront, your van, your work. Your logo if you have one. That is the whole asset list.",
  },
  {
    title: "Pick your ZIP codes",
    body: "The neighbourhoods you actually serve, plus a radius. No one outside it sees your ad, so none of your budget goes there.",
  },
  {
    title: "Set a daily budget",
    body: "Start at five dollars a day. AdVault writes the script, renders a 16:9 pre-roll and a 9:16 Shorts cut, and builds the campaign in your own Google Ads account.",
  },
];

export default function LandingPage() {
  return (
    <main>
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-6">
        <div className="text-lg font-semibold tracking-tight">
          <Link href="/">
            <WordmarkName />
          </Link>
          <WordmarkTag />
        </div>
        <nav className="flex items-center gap-2 text-sm">
          <Link href="/login" className="rounded-lg px-3 py-2 text-zinc-300 hover:bg-white/10">
            Log in
          </Link>
          <Link
            href="/signup"
            className="rounded-lg bg-amber-400 px-3 py-2 font-medium text-zinc-950 hover:bg-amber-300"
          >
            Get started
          </Link>
        </nav>
      </header>

      <section className="mx-auto w-full max-w-5xl px-6 pt-10 pb-16 sm:pt-20">
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
          YouTube ads for the five ZIP codes you actually serve.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-zinc-400">
          A plumber does not need an agency to run a video ad. Upload a few photos of your
          work, tell us where your customers are, and set a daily budget. AdVault writes the
          script, renders the video in both YouTube formats, and builds the geotargeted campaign
          in your own Google Ads account.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/signup"
            className="rounded-lg bg-amber-400 px-6 py-3 font-medium text-zinc-950 hover:bg-amber-300"
          >
            Create your first ad
          </Link>
          <Link
            href="/login"
            className="rounded-lg border border-white/15 px-6 py-3 font-medium text-zinc-200 hover:bg-white/10"
          >
            I already have an account
          </Link>
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 pb-16">
        <div className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <Card key={step.title}>
              <span className="font-mono text-xs tracking-widest text-amber-300/80">
                STEP {i + 1}
              </span>
              <CardTitle className="mt-2">{step.title}</CardTitle>
              <CardDescription>{step.body}</CardDescription>
            </Card>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 pb-24">
        <Card className="border-amber-400/20 bg-amber-400/[0.04]">
          <CardTitle>Your ad account stays yours</CardTitle>
          <CardDescription>
            AdVault connects to Google Ads through your own account and creates every campaign{" "}
            <strong className="font-medium text-zinc-200">paused</strong>. You review it in
            Google Ads and switch it on yourself — nothing here starts spending on its own, and
            you can disconnect at any time.
          </CardDescription>
        </Card>
        <p className="mt-8 text-center text-sm text-zinc-500">
          <Wordmark />
        </p>
      </section>
    </main>
  );
}
