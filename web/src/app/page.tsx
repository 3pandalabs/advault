/* eslint-disable @next/next/no-img-element -- static demo posters in public/ */
import Link from "next/link";
import { Bricolage_Grotesque } from "next/font/google";
import { WordmarkName, WordmarkTag, Wordmark } from "@/components/Wordmark";
import { CostSimulator } from "@/components/CostSimulator";
import { timesShownEstimate } from "@/lib/budget";
import "./home.css";

// Server-rendered. The cost simulator inside is the only client component, so the
// page produces a real link preview and is up even when the API is not.
// Prices here are "from $55 a month" (owner 2026-11-19): Keep it running =
// lib/pricing us-evergreen $20 + the customer's chosen monthly ad budget (from
// $35), recharged; or "Just this once" (no plan, no renewals). Plus the
// us-new_ad and us-website $10s. Change them together with web/src/lib/prices.
// Times-shown numbers always come from timesShownEstimate, never typed in.
// Motion lives in ./home.css (av- prefix) and is off under reduced motion.

// Self-hosted by next/font (no request to Google from the visitor's browser,
// so the privacy page's "no third parties" stays true).
const display = Bricolage_Grotesque({ subsets: ["latin"], weight: ["600", "800"], variable: "--font-display" });

const EST = timesShownEstimate(3_500, "USD");
const SHOWN = `${EST.low.toLocaleString("en-US")}–${EST.high.toLocaleString("en-US")}`;

const STEPS = [
  {
    title: "Tell us about your business",
    body: "Name, what you do, your offer, and the ZIP codes you serve. Real estate agents give the listing address instead.",
  },
  {
    title: "Upload a few photos",
    body: "Up to five: your shop, your team, your work. We write the script, add a voiceover and captions, and make the video. Already have a video? Contact us.",
  },
  {
    title: "Pick a budget and go live",
    body: "From $35, recharged each month or just once. Your ad shows on YouTube and Shorts to people near you while your budget lasts. You never open Google Ads.",
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

// The hero phone cycles the same demo posters (no video download on load).
const HERO = [
  { poster: "/demo/salon.jpg", name: "Hair salon", offer: "$10 off your first cut", area: "Shown in 78704, 78702 (TX)" },
  { poster: "/demo/realty.jpg", name: "Real estate", offer: "Open house this Sunday", area: "Shown near the listing" },
  { poster: "/demo/dentist.jpg", name: "Dentist", offer: "$49 new patient exam", area: "Shown in 3 ZIP codes" },
  { poster: "/demo/bakery.jpg", name: "Bakery", offer: "$2 off coffee + pastry", area: "Shown within your area" },
  { poster: "/demo/advault.jpg", name: "AdVault", offer: "Your ad, made for you", area: "Shown to people nearby" },
];
const SLOT = 4;

function rot(i: number): React.CSSProperties {
  const n = HERO.length;
  return {
    "--rot-dur": `${n * SLOT}s`,
    "--rot-delay": `${i * SLOT - SLOT * 0.1}s`,
  } as React.CSSProperties;
}

const TRADES = [
  "Plumbers", "Hair salons", "Dentists", "Bakeries", "Real estate agents", "HVAC", "Electricians",
  "Auto repair", "Landscapers", "Cleaners", "Restaurants", "Car washes", "Spas", "Gyms", "Pet groomers",
];

const CAPTION = ["Your", "ad,", "made", "from", "a", "few", "photos!"];

export default function LandingPage() {
  return (
    <main className={`${display.variable} overflow-x-clip`}>
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-6 sm:px-6">
        {/* At phone width an inline tag squeezes the nav, so it stacks under
            the name instead (never hidden: brand.md consistency rules). */}
        <div className="flex flex-col items-start text-lg leading-tight font-semibold tracking-tight sm:block sm:leading-normal">
          <Link href="/">
            <WordmarkName />
          </Link>
          <WordmarkTag stackOnPhone />
        </div>
        <nav className="flex shrink-0 items-center gap-1 whitespace-nowrap text-sm sm:gap-2">
          <Link href="#ads" className="hidden rounded-lg px-3 py-2 text-zinc-300 hover:bg-white/10 md:inline">
            Ads we made
          </Link>
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

      {/* ---------- Hero ---------- */}
      <section className="mx-auto grid w-full max-w-6xl items-center gap-14 px-6 pt-6 pb-20 lg:grid-cols-[1.1fr_1fr] lg:pt-12">
        <div>
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-xs font-medium tracking-wide text-amber-200 uppercase">
            <span className="av-live size-2 rounded-full bg-rose-500" />
            YouTube ads for local businesses
          </p>
          <h1 className="av-display text-[2.5rem] leading-[1.03] font-extrabold text-balance sm:text-6xl xl:text-[4.25rem]">
            Your business on YouTube,{" "}
            <span className="av-scribble">
              <span className="av-shimmer">seen by people nearby.</span>
              <svg viewBox="0 0 300 20" preserveAspectRatio="none" aria-hidden>
                <path d="M3 14 C 60 4, 120 18, 180 9 S 270 6, 297 12" fill="none" stroke="#fbbf24" strokeWidth="4" strokeLinecap="round" />
              </svg>
            </span>
          </h1>
          <p className="mt-7 max-w-xl text-lg text-zinc-300">
            Send us a few photos. We make your video ad and run it on YouTube and Shorts for
            people near you. No agency, no video team, no Google Ads.
          </p>
          <p className="mt-5 text-xl font-semibold tracking-tight">
            <span className="text-amber-300">From $55 a month.</span> We make your ad and your website, and show your
            business about{" "}
            <span className="estimate-flash font-semibold text-amber-300">{SHOWN}</span> times to people near you.
          </p>
          <p className="mt-2 max-w-xl text-base text-zinc-400">
            YouTube ads need a website to go live. No website? Don&apos;t worry, we&apos;ve got you covered: we&apos;ll
            build one in minutes while we make your ad.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/signup"
              className="av-btn-shine rounded-xl bg-amber-400 px-6 py-3.5 text-base font-semibold text-zinc-950 shadow-[0_10px_40px_-10px_rgba(251,191,36,.7)] hover:bg-amber-300"
            >
              Make my ad
            </Link>
            <Link
              href="#ads"
              className="rounded-xl border border-white/15 px-5 py-3.5 text-base font-medium text-zinc-200 hover:bg-white/10"
            >
              See ads we made
            </Link>
          </div>
          <p className="mt-3 text-sm text-zinc-500">No contract. Cancel any time.</p>
        </div>

        <HeroStage />
      </section>

      {/* ---------- Who it's for ---------- */}
      <section aria-label="Made for local businesses" className="av-marquee border-y border-white/10 bg-white/[0.02] py-5">
        <div className="av-marquee-track">
          {[0, 1].map((k) => (
            <div key={k} className="flex shrink-0 items-center" aria-hidden={k === 1 || undefined}>
              {TRADES.map((t) => (
                <span key={t} className="av-display flex items-center gap-6 px-6 text-2xl font-semibold whitespace-nowrap text-zinc-400 sm:text-3xl">
                  {t}
                  <span className="text-amber-400/70">✦</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </section>

      {/* ---------- Photos in, ad out ---------- */}
      <section className="mx-auto w-full max-w-6xl px-6 py-24">
        <SectionHead
          kicker="Photos in, ad out"
          title={<>A few photos become a <span className="av-shimmer">real video ad.</span></>}
          body="No filming, no editing app, no voiceover booth. You send the photos, we do the rest."
        />
        <div className="av-machine mt-14 grid items-center gap-10 lg:grid-cols-[1fr_auto_1fr]">
          <div className="relative mx-auto flex h-64 w-full max-w-sm items-center justify-center">
            {["/demo/realty.jpg", "/demo/bakery.jpg", "/demo/advault.jpg"].map((src, i) => (
              <div
                key={src}
                className="av-photo absolute w-36 rounded-md bg-white p-2 pb-7 shadow-2xl sm:w-40"
                style={{ rotate: `${[-9, 2, 11][i]}deg`, translate: `${[-70, 0, 70][i]}px ${[10, -10, 14][i]}px` }}
              >
                <img src={src} alt="" className="aspect-square w-full object-cover" style={{ objectPosition: `50% ${[0, 0, 45][i]}%` }} />
                <span className="absolute bottom-1.5 left-2 font-mono text-[10px] text-zinc-500">photo_{i + 1}.jpg</span>
              </div>
            ))}
          </div>

          <div className="flex flex-col items-center gap-3">
            <div className="av-flow hidden h-[3px] w-40 lg:block" />
            <div className="av-flow-v h-14 w-[3px] lg:hidden" />
            <div className="av-spark grid size-20 place-items-center rounded-2xl bg-gradient-to-br from-amber-300 to-rose-400 text-4xl shadow-[0_0_60px_-10px_rgba(251,191,36,.8)]">
              🐼
            </div>
            <ul className="flex flex-wrap justify-center gap-2 text-xs text-zinc-300 lg:max-w-44">
              {["Script", "Voiceover", "Captions", "Motion", "Vertical + wide"].map((x) => (
                <li key={x} className="rounded-full border border-white/15 bg-white/5 px-2.5 py-1">{x}</li>
              ))}
            </ul>
            <div className="av-flow-v h-14 w-[3px] lg:hidden" />
            <div className="av-flow hidden h-[3px] w-40 lg:block" />
          </div>

          <div className="mx-auto w-48 sm:w-52">
            <Phone>
              <img src="/demo/advault.jpg" alt="" className="av-kenburns absolute inset-0 size-full object-cover" style={{ objectPosition: "50% 40%" }} />
              <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-transparent to-black/30" />
              <div className="absolute inset-x-3 top-16 text-center text-lg leading-tight font-extrabold text-white drop-shadow-[0_2px_4px_rgba(0,0,0,.8)]">
                {CAPTION.map((w, i) => (
                  <span key={i} className="av-word mr-1" style={{ "--w": `${i * 0.32}s` } as React.CSSProperties}>
                    {i < 2 || i > 4 ? <span className="text-amber-300">{w}</span> : w}
                  </span>
                ))}
              </div>
              <AdChrome />
            </Phone>
            <p className="mt-3 text-center text-xs text-zinc-500">Captions appear word by word, like this.</p>
          </div>
        </div>
      </section>

      {/* ---------- Ads we made ---------- */}
      <section id="ads" className="scroll-mt-6 py-10">
        <div className="mx-auto w-full max-w-6xl px-6">
          <SectionHead
            kicker="Ads we made"
            title="Press play. These took minutes."
            body="15-second ads with your offer, a voiceover and captions. Each one comes vertical for Shorts and widescreen for regular YouTube."
          />
        </div>
        <div className="mt-10 overflow-x-auto pb-6">
          <div className="mx-auto flex w-max gap-5 px-6">
            {DEMOS.map((d, i) => (
              <figure key={d.src} className="av-reel w-52 shrink-0 sm:w-56" style={{ rotate: `${[-2, 1.5, -1, 2, -1.5][i]}deg` }}>
                <div className="rounded-[1.8rem] border border-white/15 bg-zinc-900 p-1.5 shadow-2xl">
                  <video
                    src={d.src}
                    poster={d.poster}
                    controls
                    playsInline
                    preload="none"
                    className="aspect-[9/16] w-full rounded-[1.4rem] bg-black object-cover"
                  />
                </div>
                <figcaption className="mt-3 px-1 text-sm">
                  <span className="font-medium text-zinc-100">{d.title}</span>
                  <span className="block text-amber-300/90">{d.note}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
        <p className="mx-auto max-w-6xl px-6 text-xs text-zinc-500">
          Demo businesses with AI-generated images, made to show the format. Your ad uses your
          own photos and offer.
        </p>
      </section>

      {/* ---------- Neighbourhood ---------- */}
      <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-6 py-24 lg:grid-cols-2">
        <NeighborhoodMap />
        <div>
          <SectionHead
            align="left"
            kicker="Just your neighborhood"
            title={<>Don&apos;t pay to reach <span className="av-shimmer">the whole state.</span></>}
            body="Pick the ZIP codes you serve, and your ad shows only to people who are there. Real estate agents get the area around the listing instead."
          />
          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            <Fact icon="📍" title="People who are actually there" body="Not people elsewhere who just searched about your town." />
            <Fact icon="📱" title="YouTube and Shorts" body="Before videos people watch, and between Shorts." />
            <Fact icon="🧾" title="No Google Ads account" body="We set it up and run it. You never open Google Ads." />
            <Fact icon="📊" title="See how it's doing" body="Times shown, views, clicks and spend, in plain words." />
          </div>
        </div>
      </section>

      {/* ---------- How it works ---------- */}
      <section className="mx-auto w-full max-w-6xl px-6 py-16">
        <SectionHead kicker="How it works" title="Three steps, one sitting" />
        <ol className="relative mt-12 grid gap-6 md:grid-cols-3">
          <div aria-hidden className="av-dash absolute top-7 right-[16%] left-[16%] hidden h-[2px] md:block" />
          {STEPS.map((step, i) => (
            <li key={step.title} className="av-tile relative rounded-2xl border border-white/10 bg-zinc-900/70 p-6 backdrop-blur">
              <span className="av-display relative grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-amber-300 to-amber-500 text-2xl font-extrabold text-zinc-950 shadow-[0_10px_30px_-10px_rgba(251,191,36,.8)]">
                {i + 1}
              </span>
              <h3 className="mt-5 text-lg font-semibold tracking-tight">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ---------- Pricing ---------- */}
      <section id="pricing" className="mx-auto w-full max-w-5xl scroll-mt-6 px-6 py-16">
        <SectionHead
          kicker="Simple pricing"
          title={<>From <span className="av-shimmer">$55 a month.</span> No contract.</>}
          body="Every dollar of your ad budget goes to Google. Try the numbers:"
        />
        <div className="av-ring-border mt-10">
          <div className="rounded-[calc(1.5rem-1px)] bg-zinc-950 p-1">
            <CostSimulator ctaHref="/signup" />
          </div>
        </div>
      </section>

      {/* ---------- What is AdVault ---------- */}
      <section className="mx-auto w-full max-w-5xl px-6 pb-16">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-8">
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

      {/* ---------- Final CTA ---------- */}
      <section className="mx-auto w-full max-w-6xl px-6 pb-16">
        <div className="av-glow relative overflow-hidden rounded-[2rem] border border-white/10 px-6 py-16 text-center sm:py-20">
          <h2 className="av-display mx-auto max-w-2xl text-4xl leading-tight font-extrabold text-balance sm:text-6xl">
            Ready to get your business on <span className="av-shimmer">YouTube?</span>
          </h2>
          <p className="mt-4 text-lg text-zinc-300">A few photos and a few minutes. We handle the rest.</p>
          <Link
            href="/signup"
            className="av-btn-shine mt-8 inline-block rounded-xl bg-amber-400 px-8 py-4 text-lg font-semibold text-zinc-950 shadow-[0_10px_40px_-10px_rgba(251,191,36,.8)] hover:bg-amber-300"
          >
            Make my ad
          </Link>
          <p className="mt-3 text-sm text-zinc-400">No contract. Cancel any time.</p>
        </div>
      </section>

      {/* ---------- Google account use (OAuth verification: keep) ---------- */}
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

/* ---------- Pieces ---------- */

function SectionHead({
  kicker,
  title,
  body,
  align = "center",
}: {
  kicker: string;
  title: React.ReactNode;
  body?: string;
  align?: "center" | "left";
}) {
  const c = align === "center" ? "mx-auto text-center" : "";
  return (
    <div className={`max-w-2xl ${c}`}>
      <p className="font-mono text-xs tracking-[0.2em] text-amber-300/90 uppercase">{kicker}</p>
      <h2 className="av-display mt-3 text-3xl leading-tight font-extrabold text-balance sm:text-5xl">{title}</h2>
      {body ? <p className="mt-4 text-zinc-400">{body}</p> : null}
    </div>
  );
}

function Fact({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="av-tile rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <p className="text-sm font-semibold text-zinc-100">
        <span className="mr-2">{icon}</span>
        {title}
      </p>
      <p className="mt-1 text-sm text-zinc-400">{body}</p>
    </div>
  );
}

function Phone({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-[2.4rem] border border-white/20 bg-zinc-900 p-2 shadow-[0_40px_80px_-30px_rgba(0,0,0,.9)] ${className}`}>
      <div className="relative aspect-[9/16] overflow-hidden rounded-[1.9rem] bg-black">
        <div className="absolute top-2 left-1/2 z-20 h-5 w-20 -translate-x-1/2 rounded-full bg-black" />
        {children}
      </div>
    </div>
  );
}

/** Generic short-video UI (no platform logos). */
function AdChrome() {
  return (
    <>
      <span className="absolute top-9 left-3 z-10 rounded bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold text-zinc-950">
        Sponsored
      </span>
      <div className="absolute right-2.5 bottom-20 z-10 flex flex-col items-center gap-3 text-white/90" aria-hidden>
        {["♥", "💬", "↗"].map((x) => (
          <span key={x} className="grid size-8 place-items-center rounded-full bg-black/40 text-sm backdrop-blur">{x}</span>
        ))}
      </div>
      <span className="av-pulse absolute inset-x-3 bottom-4 z-10 rounded-full bg-white py-2 text-center text-xs font-bold text-zinc-950">
        Visit website
      </span>
    </>
  );
}

function HeroStage() {
  return (
    <div className="av-stage relative mx-auto w-full max-w-md py-6" aria-label="Example ads rotating on a phone" role="img">
      {/* Widescreen cut behind the phone */}
      <div className="av-wide absolute top-10 -left-6 w-64 rounded-xl border border-white/15 bg-zinc-900 p-1.5 shadow-2xl sm:-left-16 sm:w-80">
        <div className="relative aspect-video overflow-hidden rounded-lg">
          {HERO.map((h, i) => (
            <img
              key={h.poster}
              src={h.poster}
              alt=""
              data-first={i === 0 || undefined}
              className="av-rot absolute inset-0 size-full object-cover blur-[1px] brightness-75"
              style={{ ...rot(i), objectPosition: "50% 35%" }}
            />
          ))}
          <span className="absolute bottom-1.5 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-zinc-200">16:9 · YouTube</span>
        </div>
      </div>

      <div className="av-float relative mx-auto w-60 sm:w-64">
        <Phone>
          {HERO.map((h, i) => (
            <div key={h.poster} data-first={i === 0 || undefined} className="av-rot absolute inset-0" style={rot(i)}>
              <img src={h.poster} alt="" className="av-kenburns size-full object-cover" />
            </div>
          ))}
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/40" />
          {/* progress bars, like a story */}
          <div className="absolute inset-x-3 top-[1.9rem] z-10 flex gap-1">
            {HERO.map((h, i) => (
              <span key={h.poster} className="relative h-0.5 flex-1 overflow-hidden rounded bg-white/30">
                <span data-first={i === 0 || undefined} className="av-rot av-rot-bar absolute inset-0 bg-white" style={rot(i)} />
              </span>
            ))}
          </div>
          {HERO.map((h, i) => (
            <p
              key={h.poster}
              data-first={i === 0 || undefined}
              className="av-rot av-rot-text absolute top-[2.35rem] left-[5.6rem] z-10 text-[10px] font-semibold text-white drop-shadow"
              style={rot(i)}
            >
              {h.name}
            </p>
          ))}
          <AdChrome />
        </Phone>
      </div>

      {/* Floating chips */}
      <div className="av-chip absolute top-0 -right-2 z-20 w-44 rounded-2xl border border-white/15 bg-zinc-900/90 p-3 shadow-2xl backdrop-blur sm:-right-10">
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 40 40" className="size-10 shrink-0" aria-hidden>
            <circle cx="20" cy="20" r="18" fill="rgba(251,191,36,.08)" stroke="rgba(251,191,36,.35)" />
            <circle cx="20" cy="20" r="10" fill="none" stroke="rgba(251,191,36,.25)" />
            <g className="av-sweep">
              <path d="M20 20 L20 2 A18 18 0 0 1 35 11 Z" fill="rgba(251,191,36,.35)" />
            </g>
            <circle cx="20" cy="20" r="2.5" fill="#fbbf24" />
          </svg>
          <div className="relative min-w-0">
            <p className="text-xs font-semibold text-zinc-100">Only your ZIP codes</p>
            {HERO.map((h, i) => (
              <p key={h.poster} data-first={i === 0 || undefined} className="av-rot av-rot-text absolute text-[11px] text-amber-300" style={rot(i)}>
                {h.area}
              </p>
            ))}
            <p className="invisible text-[11px]">.</p>
          </div>
        </div>
      </div>

      <div className="av-chip av-chip-2 absolute bottom-24 -left-3 z-20 rounded-2xl border border-white/15 bg-zinc-900/90 px-3.5 py-2.5 shadow-2xl backdrop-blur sm:-left-12">
        <p className="text-[11px] text-zinc-400">With a $35 budget, about</p>
        <p className="av-display text-lg font-extrabold text-amber-300">{SHOWN} times shown</p>
      </div>

      <div className="av-chip av-chip-3 absolute -right-1 -bottom-4 z-20 rounded-full border border-emerald-400/30 bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-200 shadow-xl backdrop-blur sm:-right-8">
        🎬 Made for you: script, voice, captions
      </div>
    </div>
  );
}

// Hex grid "map": the highlighted cells are the ZIPs you picked.
function NeighborhoodMap() {
  const cells: { x: number; y: number; on: boolean; d: number }[] = [];
  const on = new Set(["3,2", "4,2", "3,3", "4,3", "5,3", "4,4", "2,3"]);
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 8; c++) {
      cells.push({ x: c * 52 + (r % 2 ? 26 : 0) + 20, y: r * 45 + 30, on: on.has(`${c},${r}`), d: (c + r) * 0.25 });
    }
  }
  const hex = (x: number, y: number) =>
    Array.from({ length: 6 }, (_, k) => {
      const a = (Math.PI / 3) * k + Math.PI / 6;
      return `${(x + 28 * Math.cos(a)).toFixed(1)},${(y + 28 * Math.sin(a)).toFixed(1)}`;
    }).join(" ");
  return (
    <div className="relative mx-auto w-full max-w-lg">
      <div className="rounded-3xl border border-white/10 bg-zinc-900/60 p-4 shadow-2xl backdrop-blur">
        <svg viewBox="0 0 460 350" className="w-full" role="img" aria-label="Map: your ad shows only in the ZIP codes you pick">
          {cells.map((h, i) => (
            <polygon
              key={i}
              points={hex(h.x, h.y)}
              className={`av-hex ${h.on ? "av-hex-on" : ""}`}
              fill={h.on ? "rgba(251,191,36,.25)" : "rgba(255,255,255,.03)"}
              stroke={h.on ? "rgba(251,191,36,.7)" : "rgba(255,255,255,.08)"}
              strokeWidth="1.5"
              style={{ "--d": `${h.d}s` } as React.CSSProperties}
            />
          ))}
          <g transform="translate(228 165)">
            <circle r="18" fill="none" stroke="#fbbf24" strokeWidth="2" className="av-ping" />
            <circle r="18" fill="none" stroke="#fbbf24" strokeWidth="2" className="av-ping av-ping-2" />
            <circle r="18" fill="none" stroke="#fbbf24" strokeWidth="2" className="av-ping av-ping-3" />
            <path d="M0 -26 C -14 -26 -20 -15 -20 -8 C -20 6 0 22 0 22 C 0 22 20 6 20 -8 C 20 -15 14 -26 0 -26 Z" fill="#fbbf24" />
            <circle cy="-9" r="7" fill="#18181b" />
          </g>
          <text x="228" y="214" textAnchor="middle" className="fill-zinc-100 text-[13px] font-semibold">Your shop</text>
        </svg>
        <div className="mt-2 flex flex-wrap gap-2 px-1 text-xs">
          {["78704 TX", "60614 IL", "94110 CA", "33139 FL", "98103 WA", "10001 NY"].map((z) => (
            <span key={z} className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 font-mono text-amber-200">{z} ✓</span>
          ))}
          <span className="rounded-full border border-white/10 px-2.5 py-1 font-mono text-zinc-500">+ add ZIP</span>
        </div>
      </div>
      <p className="mt-3 text-center text-xs text-zinc-500">Example ZIP codes from across the USA. Pick the ones near you.</p>
    </div>
  );
}
