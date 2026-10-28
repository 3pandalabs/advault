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
          AdVault: YouTube ads for local businesses
        </h1>
        <p className="mt-4 max-w-3xl text-2xl font-medium tracking-tight text-zinc-200 text-balance">
          The shop down the road is on YouTube. You should be too.
        </p>
        <p className="mt-6 max-w-2xl text-lg text-zinc-400">
          A salon in Indiranagar does not need an agency, a video team, or a Google Ads
          course. Upload three photos, tell us your pin code, pick a budget. We write it,
          make the video, and run the campaign — you never touch Google Ads.
        </p>
        <p className="mt-4 max-w-2xl text-base text-zinc-300">
          <strong>AdVault</strong> is a self-serve advertising tool for small local
          businesses. It turns a few photos of your business into short video ads for
          YouTube and YouTube Shorts, and runs them as a Google Ads campaign targeted to the
          neighbourhood you serve. You can read what it does below without an account.
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
              We create and run your ad account for you under our Google Ads manager
              account.
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

        <div className="mt-12 rounded-xl border border-white/10 bg-white/[0.02] p-6">
          <h2 className="text-xl font-semibold tracking-tight">
            How AdVault uses your Google account
          </h2>
          <p className="mt-3 text-sm text-zinc-400">
            Connecting Google is optional and only happens when you choose it. AdVault asks
            for these permissions, and uses each only for the purpose listed:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-zinc-400">
            <li>
              <strong className="text-zinc-200">Google Ads</strong> — to create, pause and
              report on the campaigns you ask AdVault to run in your own Google Ads account.
            </li>
            <li>
              <strong className="text-zinc-200">YouTube upload</strong> — to publish your
              finished ad to your YouTube channel as an unlisted video, because a YouTube
              ad must be a YouTube video.
            </li>
            <li>
              <strong className="text-zinc-200">YouTube read-only</strong> — to read your
              channel&apos;s name and ID so you can see which channel is connected.
            </li>
          </ul>
          <p className="mt-3 text-sm text-zinc-400">
            We never sell Google user data, never use it for advertising, and never send it
            to an AI provider. Full details are in our{" "}
            <Link href="/privacy" className="text-amber-300 underline">
              privacy policy
            </Link>
            .
          </p>
        </div>

        <p className="mt-8 text-center text-sm text-zinc-500">
          <Wordmark />
        </p>
      </section>
    </main>
  );
}
