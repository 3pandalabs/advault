import Link from "next/link";
import { Wordmark, WordmarkName, WordmarkTag } from "@/components/Wordmark";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { CostSimulator } from "@/components/CostSimulator";
import { timesShownEstimate } from "@/lib/budget";

// Server-rendered. The cost simulator inside is the only client component, so the
// page produces a real link preview and is up even when the API is not.
// Prices here are "from $55 a month" (owner 2026-11-19): Keep it running =
// lib/pricing us-evergreen $20 + the customer's chosen monthly ad budget (from
// $35), recharged; or "Just this once" (no plan, no renewals). Plus the
// us-new_ad and us-website $10s. Change them together with web/src/lib/prices.
// Times-shown numbers always come from timesShownEstimate, never typed in.

const EST = timesShownEstimate(3_500, "USD");
const SHOWN = `${EST.low.toLocaleString("en-US")}–${EST.high.toLocaleString("en-US")}`;

const STEPS = [
  {
    title: "Tell us about your business",
    body: "Name, what you do, your offer, and the ZIP codes you serve. Real estate agents give the listing address instead.",
  },
  {
    title: "Upload three photos",
    body: "Your shop, your team, your work. We write the script, add a voiceover and captions, and make the video. Already have a video? Upload it instead.",
  },
  {
    title: "Top up and go live",
    body: "Top up from $35. Your ad shows on YouTube and Shorts to people near you until your budget runs out. You never open Google Ads.",
  },
];

// Self-hosted (web/public/demo), not YouTube embeds: an embed sets cookies,
// and the privacy policy says this site sets none. preload="none" so the
// page costs nothing until someone presses play.
const DEMOS = [
  { src: "/demo/realty.mp4", poster: "/demo/realty.jpg", title: "Real estate agent", note: "Just listed + open house" },
  { src: "/demo/salon.mp4", poster: "/demo/salon.jpg", title: "Hair salon", note: "$10 off first cut" },
  { src: "/demo/dentist.mp4", poster: "/demo/dentist.jpg", title: "Dentist", note: "$49 new patient exam" },
  { src: "/demo/bakery.mp4", poster: "/demo/bakery.jpg", title: "Bakery", note: "$2 off coffee + pastry" },
  { src: "/demo/advault.mp4", poster: "/demo/advault.jpg", title: "AdVault itself", note: "Our own ad" },
];

export default function LandingPage() {
  return (
    <main>
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-6 sm:px-6">
        {/* At phone width an inline tag squeezes the nav, so it stacks under
            the name instead (never hidden: brand.md consistency rules). */}
        <div className="flex flex-col items-start text-lg leading-tight font-semibold tracking-tight sm:block sm:leading-normal">
          <Link href="/">
            <WordmarkName />
          </Link>
          <WordmarkTag stackOnPhone />
        </div>
        <nav className="flex shrink-0 items-center gap-1 whitespace-nowrap text-sm sm:gap-2">
          <Link href="#pricing" className="hidden rounded-lg px-3 py-2 text-zinc-300 hover:bg-white/10 sm:inline">
            Pricing
          </Link>
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
          YouTube ads for local businesses
        </p>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
          Your business on YouTube, seen by people nearby.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-zinc-300">
          Send us three photos. We make your video ad and run it on YouTube and Shorts for
          people near you. No agency, no video team, no Google Ads.
        </p>
        <p className="mt-4 text-xl font-semibold tracking-tight">
          <span className="text-amber-300">From $55 a month.</span> We make your ad and your website, and show your
          business about{" "}
          <span className="estimate-flash font-semibold text-amber-300">{SHOWN}</span> times to people near you.
        </p>
        <p className="mt-2 text-base text-zinc-300">
          YouTube ads need a website to go live. No website? Don&apos;t worry, we&apos;ve got you covered: we&apos;ll
          build one in minutes while we make your ad.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="#pricing"
            className="rounded-xl bg-amber-400 px-5 py-3 text-base font-semibold text-zinc-950 hover:bg-amber-300"
          >
            See pricing
          </Link>
          <Link
            href="#ads"
            className="rounded-xl border border-white/15 px-5 py-3 text-base font-medium text-zinc-200 hover:bg-white/10"
          >
            See ads we made
          </Link>
        </div>
        <p className="mt-3 text-sm text-zinc-500">No contract. Cancel any time.</p>

      </section>

      <section id="ads" className="mx-auto w-full max-w-5xl scroll-mt-6 px-6 pb-16">
        <h2 className="text-2xl font-semibold tracking-tight">Ads we made</h2>
        <p className="mt-2 mb-5 text-sm text-zinc-400">
          15-second ads with your offer, a voiceover and captions. Each one comes vertical for
          Shorts and widescreen for regular YouTube.
        </p>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {DEMOS.map((d) => (
            <figure key={d.src} className="mx-auto w-full max-w-[280px]">
              <video
                src={d.src}
                poster={d.poster}
                controls
                playsInline
                preload="none"
                className="aspect-[9/16] w-full rounded-2xl border border-white/10 bg-black object-cover"
              />
              <figcaption className="mt-2 text-sm">
                <span className="font-medium text-zinc-200">{d.title}</span>
                <span className="block text-zinc-500">{d.note}</span>
              </figcaption>
            </figure>
          ))}
        </div>
        <p className="mt-4 text-xs text-zinc-500">
          Demo businesses with AI-generated images, made to show the format. Your ad uses your
          own photos and offer.
        </p>
      </section>

      <section id="pricing" className="mx-auto w-full max-w-5xl scroll-mt-6 px-6 pb-16">
        <h2 className="mb-5 text-2xl font-semibold tracking-tight">Simple pricing</h2>
        <CostSimulator ctaHref="/signup" />
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 pb-16">
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-6">
          <h2 className="text-xl font-semibold tracking-tight">What is AdVault?</h2>
          <p className="mt-3 text-zinc-400">
            <strong className="text-zinc-200">AdVault</strong> is a self-serve advertising tool
            for small local businesses. It turns a few photos of your business into short video
            ads for YouTube and YouTube Shorts, and runs them as a Google Ads campaign targeted
            to the area you serve. We create and run the ad account under our Google Ads
            manager account, so there is no billing setup, campaign builder or jargon for you.
          </p>
        </div>
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

      <section className="mx-auto w-full max-w-5xl px-6 pb-16">
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] px-6 py-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Ready to get your business on YouTube?
          </h2>
          <p className="mt-2 text-zinc-400">Three photos and a few minutes. We handle the rest.</p>
          <Link
            href="/signup"
            className="mt-6 inline-block rounded-xl bg-amber-400 px-6 py-3 text-base font-semibold text-zinc-950 hover:bg-amber-300"
          >
            Make my ad
          </Link>
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 pb-24">
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-6">
          <h2 className="text-base font-semibold tracking-tight">
            How AdVault uses your Google account
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            You don&apos;t need a Google account to use AdVault. If you choose to publish ads
            to your own YouTube channel, AdVault asks for these permissions and uses each only
            for the purpose listed:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-zinc-400">
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
            </Link>{" "}
            and{" "}
            <Link href="/terms" className="text-amber-300 underline">
              terms
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
