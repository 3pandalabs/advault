import Link from "next/link";
import { Wordmark, WordmarkName, WordmarkTag } from "@/components/Wordmark";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { BudgetCalculator } from "@/components/BudgetCalculator";

// Server-rendered. The calculator inside is the only client component, so the
// page produces a real link preview and is up even when the API is not.
// Prices here are the Keep it running plan (lib/pricing us-evergreen + the
// us-new_ad add-on); change them together.

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
    title: "Pick a budget and go live",
    body: "From $1 a day. We run the campaign on YouTube and Shorts for people near you. You never open Google Ads.",
  },
];

const INCLUDED = [
  "Script, voiceover and captions written for you",
  "Your ad in both formats: vertical for Shorts, widescreen for YouTube",
  "Shown to people near your business, not the whole country",
  "Views, clicks and cost per view in your dashboard",
  "Your ad budget is capped. Never a dollar more.",
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

const FOR_WHOM = [
  "Real estate agents",
  "Salons",
  "Barbershops",
  "Dentists",
  "Restaurants",
  "Bakeries",
  "Gyms",
  "Plumbers",
];

const FAQ = [
  {
    q: "Do I need a Google Ads or YouTube account?",
    a: "No. We create and run the ad account for you. You never log in to Google Ads, and you don't need a YouTube channel.",
  },
  {
    q: "What does the $49 a month pay for?",
    a: "$30 goes to Google as your ad budget (about $1 a day) and $19 is the AdVault fee. Add more budget any time for more views. The fee stays $19.",
  },
  {
    q: "How many people will see my ad?",
    a: "At $1 a day we estimate 5,000 to 10,000 local views a month, depending on your area. It's an estimate, not a guarantee. Your dashboard shows the real numbers.",
  },
  {
    q: "Is there a contract?",
    a: "No. Cancel any time from your dashboard. Your ad keeps running until the end of the month you paid for, and the videos we made are yours to keep.",
  },
  {
    q: "Can I change my ad later?",
    a: "Yes. A new ad is $10, the same as the first. Make one when you have a new offer, a new season or new photos.",
  },
  {
    q: "I already have a video. Can I use it?",
    a: "Yes. Upload it instead of photos. We check every uploaded video before it runs, including that it has no copyrighted music.",
  },
  {
    q: "I'm a real estate agent. Is that allowed?",
    a: "Yes. US housing ads follow Google's fair-housing rules, so we show your listing to people within a distance of the property instead of by ZIP code, age or gender. We set that up for you.",
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
          <span className="text-amber-300">$10</span> makes your ad.{" "}
          <span className="text-amber-300">From $49/month</span> keeps it running.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/signup"
            className="rounded-xl bg-amber-400 px-5 py-3 text-base font-semibold text-zinc-950 hover:bg-amber-300"
          >
            Make my ad
          </Link>
          <Link
            href="#ads"
            className="rounded-xl border border-white/15 px-5 py-3 text-base font-medium text-zinc-200 hover:bg-white/10"
          >
            See ads we made
          </Link>
        </div>
        <p className="mt-3 text-sm text-zinc-500">No contract. Cancel any time.</p>

        <div className="mt-8 flex flex-wrap gap-2">
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

      <section id="pricing" className="mx-auto w-full max-w-5xl scroll-mt-6 px-6 pb-16">
        <h2 className="text-2xl font-semibold tracking-tight">Simple pricing</h2>
        <p className="mt-2 mb-5 text-sm text-zinc-400">One plan. No setup fee, no contract.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Card className="border-amber-400/20 bg-amber-400/[0.04]">
            <CardDescription>Making your ad</CardDescription>
            <p className="mt-2 text-4xl font-semibold tracking-tight">
              $10 <span className="text-base font-normal text-zinc-400">one-time, per ad</span>
            </p>
            <p className="mt-3 text-sm text-zinc-400">
              Script, voiceover, captions, both video formats. New offer next month? Another
              ad is $10 too.
            </p>
          </Card>
          <Card className="border-amber-400/20 bg-amber-400/[0.04]">
            <CardDescription>Keeping it running</CardDescription>
            <p className="mt-2 text-4xl font-semibold tracking-tight">
              From $49 <span className="text-base font-normal text-zinc-400">/ month</span>
            </p>
            <p className="mt-3 text-sm text-zinc-400">
              $30 ad budget paid to Google (about $1 a day) + $19 AdVault fee. More budget
              means more views; the fee stays $19.
            </p>
          </Card>
        </div>
        <ul className="mt-6 grid gap-2 text-sm text-zinc-300 sm:grid-cols-2">
          {INCLUDED.map((item) => (
            <li key={item} className="flex gap-2">
              <span className="text-emerald-400">✓</span>
              {item}
            </li>
          ))}
        </ul>
        <div className="mt-8">
          <BudgetCalculator />
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 pb-16">
        <h2 className="mb-5 text-2xl font-semibold tracking-tight">Questions</h2>
        <div className="divide-y divide-white/10 rounded-xl border border-white/10">
          {FAQ.map((f) => (
            <details key={f.q} className="group px-5 py-4">
              <summary className="cursor-pointer list-none font-medium text-zinc-200 marker:hidden">
                <span className="mr-2 inline-block text-amber-300 transition group-open:rotate-90">›</span>
                {f.q}
              </summary>
              <p className="mt-2 pl-5 text-sm text-zinc-400">{f.a}</p>
            </details>
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
          <h2 className="text-xl font-semibold tracking-tight">About AdVault</h2>
          <p className="mt-3 text-sm text-zinc-400">
            <strong className="text-zinc-200">AdVault</strong> is a self-serve advertising tool
            for small local businesses. It turns a few photos of your business into short video
            ads for YouTube and YouTube Shorts, and runs them as a Google Ads campaign targeted
            to the area you serve. We create and run the ad account under our Google Ads
            manager account, so there is no billing setup, campaign builder or jargon for you.
          </p>

          <h3 className="mt-6 text-base font-semibold tracking-tight">
            How AdVault uses your Google account
          </h3>
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
