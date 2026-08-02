import Link from "next/link";
import { Wordmark, WordmarkName, WordmarkTag } from "@/components/Wordmark";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { BudgetCalculator } from "@/components/BudgetCalculator";

// Server-rendered. The calculator inside is the only client component, so the
// page produces a real link preview and is up even when the API is not.

const STEPS = [
  {
    title: "Tell us about your business",
    body: "Name, what you do, and the neighbourhood you serve. Thirty seconds.",
  },
  {
    title: "Upload three photos",
    body: "Your shop, your team, your work. That is the entire asset list — no camera crew, no agency.",
  },
  {
    title: "Pick a budget and go live",
    body: "We write the script, make the video in both YouTube formats, and run the campaign for you. You never open Google Ads.",
  },
];

const FOR_WHOM = ["Salons", "Restaurants", "Tuition centres", "Gyms", "Plumbers", "Clinics"];

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

      <section className="mx-auto w-full max-w-5xl px-6 pt-10 pb-14 sm:pt-16">
        <p className="mb-4 inline-block rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-xs font-medium tracking-wide text-amber-200 uppercase">
          Vocal for Local
        </p>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
          The shop down the road is on YouTube. You should be too.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-zinc-400">
          A salon in Indiranagar does not need an agency, a video team, or a Google Ads
          course. Upload three photos, tell us your pin code, pick a budget. We write it,
          make the video, and run the campaign — you never touch Google Ads.
        </p>

        <div className="mt-6 flex flex-wrap gap-2">
          {FOR_WHOM.map((w) => (
            <span
              key={w}
              className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-sm text-zinc-400"
            >
              {w}
            </span>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 pb-16">
        <BudgetCalculator />
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 pb-16">
        <h2 className="mb-5 text-2xl font-semibold tracking-tight">Three steps, one sitting</h2>
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Card className="border-amber-400/20 bg-amber-400/[0.04]">
            <CardTitle>You never open Google Ads</CardTitle>
            <CardDescription>
              We create and run your ad account for you under our Google partner account.
              No billing setup, no campaign builder, no jargon. Top up a balance, and your
              ads run until it is spent — never a rupee more.
            </CardDescription>
          </Card>
          <Card>
            <CardTitle>Or bring your own account</CardTitle>
            <CardDescription>
              Already running Google Ads? Connect your own account instead and we will build
              campaigns into it, paused, for you to switch on yourself. Your account, your
              card, your control.
            </CardDescription>
          </Card>
        </div>

        <p className="mt-8 text-center text-sm text-zinc-500">
          <Wordmark />
        </p>
      </section>
    </main>
  );
}
