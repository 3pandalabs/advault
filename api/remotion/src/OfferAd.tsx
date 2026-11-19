import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/Poppins";

// The template ad: the look of the home-page demos (advault-creative-lab
// src/OfferAd.tsx), adapted for production input. Differences from the lab:
//   - the timeline stretches to durationSeconds instead of a fixed 15 s;
//   - area and website are optional (a real advertiser may have neither);
//   - no phone number: we never put a number on screen the advertiser didn't
//     give us for that purpose, so the end card shows their website instead;
//   - assets are full URLs served by render.mjs, never staticFile().
//
// Poppins covers Latin, the ₹ sign and Devanagari.
const { fontFamily } = loadFont("normal", {
  weights: ["600", "800", "900"],
  subsets: ["latin", "devanagari"],
});

export type Caption = { text: string; from: number; to: number };

export type OfferAdProps = {
  shopName: string;
  area: string;
  priceText: string;
  itemText: string;
  validText: string;
  benefits: string[];
  ctaLabel: string;
  website: string;
  brandColor: string;
  accentColor: string;
  photos: string[];
  voiceover?: string;
  /** Real estate: the agent's own photo, shown round on the end card. */
  portrait?: string;
  captions: Caption[];
  /**
   * Cinematic add-on: the visuals are generated film, so they play full
   * screen in both formats (no blur under the hook, no framed reel, no side
   * panel in landscape).
   */
  cinematic?: boolean;
  /**
   * Mixed ad (2026-11-14): a generated cinematic opening shot. It replaces the
   * blurred first photo under the hook, plays sharp, and the hook runs a
   * little longer; every real photo then goes to the reel.
   */
  opener?: string;
  /**
   * Before & after pairs (2026-11-17, api lib/beforeAfter): the advertiser's
   * own photos of one job, shown PLAIN (no AI pass, no motion, no zoom; both
   * halves treated identically) after the opener: BEFORE, a wipe, AFTER.
   */
  beforeAfter?: { before: string; after: string }[];
  /** Seconds per pair (api BEFORE_AFTER_PAIR_SECONDS). */
  beforeAfterSeconds?: number;
  /**
   * Trust badges the owner attested (2026-11-20, api lib/categories/badges):
   * small chips on the end card ("Licensed & insured", "LIC #12345").
   */
  badges?: string[];
  durationSeconds: number;
  width: number;
  height: number;
};

const HOOK_END = 2.6;
const OPENER_HOOK_END = 4;
const END_CARD_SECONDS = 4.2;

// A photo that keeps moving: slow zoom plus a drift, direction varies per shot.
const MovingPhoto: React.FC<{ photo: string; seconds: number; dir: number; blur?: number }> = ({
  photo,
  seconds,
  dir,
  blur = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = frame / (seconds * fps);
  // AI clips already move; adding our own zoom on top looks seasick.
  if (/\.(mp4|webm|mov)(\?|$)/i.test(photo)) {
    return (
      <AbsoluteFill style={{ overflow: "hidden" }}>
        <OffthreadVideo
          src={photo}
          muted
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: "scale(1.04)",
            filter: blur ? `blur(${blur}px) brightness(0.7)` : undefined,
          }}
        />
      </AbsoluteFill>
    );
  }
  const scale = interpolate(p, [0, 1], [1.12, 1.24]);
  const x = interpolate(p, [0, 1], [-30 * dir, 30 * dir]);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Img
        src={photo}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale}) translateX(${x}px)`,
          filter: blur ? `blur(${blur}px) brightness(0.7)` : undefined,
        }}
      />
    </AbsoluteFill>
  );
};

// One plain photo, whole (fit inside the frame over a blurred copy of itself),
// never moving. Used for BOTH halves of a pair so they look exactly alike.
const PlainPhoto: React.FC<{ photo: string }> = ({ photo }) => (
  <AbsoluteFill style={{ overflow: "hidden", background: "#000" }}>
    <Img
      src={photo}
      style={{ width: "100%", height: "100%", objectFit: "cover", filter: "blur(28px) brightness(0.55)", transform: "scale(1.1)" }}
    />
    <AbsoluteFill>
      <Img src={photo} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
    </AbsoluteFill>
  </AbsoluteFill>
);

const BaLabel: React.FC<{ text: string; side: "left" | "right"; u: number; bg: string; fg: string; show: number }> = ({
  text,
  side,
  u,
  bg,
  fg,
  show,
}) => (
  <div
    style={{
      position: "absolute",
      top: 70 * u,
      [side]: 50 * u,
      fontFamily,
      fontWeight: 900,
      fontSize: 64 * u,
      letterSpacing: 4 * u,
      color: fg,
      background: bg,
      padding: `${10 * u}px ${32 * u}px`,
      borderRadius: 18 * u,
      boxShadow: "0 12px 40px rgba(0,0,0,.45)",
      opacity: show,
      transform: `scale(${interpolate(show, [0, 1], [0.7, 1])})`,
    }}
  >
    {text}
  </div>
);

// BEFORE for ~40% of the pair, then a left-to-right wipe (a bright edge
// travelling across) reveals AFTER, which holds to the end.
const BeforeAfterPair: React.FC<{ before: string; after: string; seconds: number; u: number; accent: string; brand: string }> = ({
  before,
  after,
  seconds,
  u,
  accent,
  brand,
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const t = frame / fps;
  const wipeStart = seconds * 0.38;
  const wipeEnd = wipeStart + 0.9;
  const p = interpolate(t, [wipeStart, wipeEnd], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // Ease in-out so the edge doesn't start or stop abruptly.
  const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  const edge = e * width;
  const beforeIn = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 10 });
  return (
    <AbsoluteFill>
      <PlainPhoto photo={before} />
      <AbsoluteFill style={{ clipPath: `inset(0 ${100 - e * 100}% 0 0)` }}>
        <PlainPhoto photo={after} />
      </AbsoluteFill>
      {e > 0 && e < 1 && (
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: edge - 4 * u,
            width: 8 * u,
            background: "#fff",
            boxShadow: `0 0 ${30 * u}px ${accent}`,
          }}
        />
      )}
      <BaLabel text="BEFORE" side="left" u={u} bg="rgba(0,0,0,.78)" fg="#fff" show={beforeIn * (1 - e)} />
      <BaLabel text="AFTER" side="right" u={u} bg={accent} fg={brand} show={e} />
    </AbsoluteFill>
  );
};

const SlideIn: React.FC<{ children: React.ReactNode; framed: boolean }> = ({ children, framed }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 10 });
  const x = interpolate(s, [0, 1], [100, 0]);
  return (
    <AbsoluteFill
      style={{
        transform: `translateX(${x}%)`,
        ...(framed
          ? { inset: "6% 4% 6% 46%", borderRadius: 36, overflow: "hidden", boxShadow: "0 30px 80px rgba(0,0,0,.45)" }
          : {}),
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

// Hard cut with a quick slide between photos, like a Shorts edit.
const PhotoReel: React.FC<{ photos: string[]; seconds: number; framed: boolean }> = ({ photos, seconds, framed }) => {
  const { fps } = useVideoConfig();
  const per = Math.max(1, Math.floor((seconds * fps) / photos.length));
  return (
    <>
      {/* Each photo outlives its slot by the slide-in length, so the next one
          slides in OVER it instead of over a black frame. */}
      {photos.map((p, i) => (
        <Sequence key={p + i} from={i * per} durationInFrames={i === photos.length - 1 ? undefined : per + 12}>
          <SlideIn framed={framed}>
            <MovingPhoto photo={p} seconds={per / fps} dir={i % 2 ? -1 : 1} />
          </SlideIn>
        </Sequence>
      ))}
    </>
  );
};

// The price sticker: slams in, wobbles, keeps a slow pulse so it stays alive.
const PriceSticker: React.FC<OfferAdProps & { size: number }> = ({ priceText, itemText, validText, accentColor, brandColor, size }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 9, stiffness: 140 } });
  const pulse = 1 + 0.03 * Math.sin(frame / 6);
  const barIn = spring({ frame: frame - 8, fps, config: { damping: 200 } });
  const tagIn = spring({ frame: frame - 16, fps, config: { damping: 200 } });
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: size * 0.06 }}>
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: accentColor,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${pop * pulse}) rotate(${interpolate(pop, [0, 1], [-25, -8])}deg)`,
          boxShadow: `0 0 0 ${size * 0.04}px #fff, 0 ${size * 0.08}px ${size * 0.2}px rgba(0,0,0,.4)`,
        }}
      >
        {/* Longer badges ("$10 OFF") shrink to stay inside the circle. */}
        <span
          style={{
            fontFamily,
            fontWeight: 900,
            fontSize: size * 0.36 * Math.min(1, 4 / priceText.length),
            color: brandColor,
            letterSpacing: -2,
            textAlign: "center",
            lineHeight: 1,
          }}
        >
          {priceText}
        </span>
      </div>
      <div
        style={{
          fontFamily,
          fontWeight: 900,
          // Long items shrink to stay on one line.
          fontSize: size * 0.26 * Math.min(1, 9 / itemText.length),
          whiteSpace: "nowrap",
          color: "#fff",
          background: brandColor,
          padding: `${size * 0.02}px ${size * 0.1}px`,
          borderRadius: 14,
          transform: `translateX(${interpolate(barIn, [0, 1], [-140, 0])}%)`,
          opacity: barIn,
        }}
      >
        {itemText}
      </div>
      <div
        style={{
          fontFamily,
          fontWeight: 800,
          fontSize: size * 0.1 * Math.min(1, 16 / validText.length),
          whiteSpace: "nowrap",
          color: brandColor,
          background: "#fff",
          padding: `${size * 0.015}px ${size * 0.06}px`,
          borderRadius: 999,
          opacity: tagIn,
          transform: `translateY(${interpolate(tagIn, [0, 1], [40, 0])}px)`,
        }}
      >
        {validText}
      </div>
    </div>
  );
};

// Word-by-word pop captions, timed to the voiceover.
const Captions: React.FC<{ captions: Caption[]; fontSize: number; accent: string }> = ({ captions, fontSize, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const cur = captions.find((c) => t >= c.from && t < c.to);
  if (!cur) return null;
  const words = cur.text.split(" ");
  const per = (cur.to - cur.from) / words.length;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: fontSize * 0.25, maxWidth: "90%" }}>
      {words.map((w, i) => {
        const start = cur.from + i * per;
        const local = (t - start) * fps;
        const s = spring({ frame: local, fps, config: { damping: 12, stiffness: 200 } });
        const active = t >= start && t < start + per;
        return (
          <span
            key={i}
            style={{
              fontFamily,
              fontWeight: 900,
              fontSize,
              color: active ? accent : "#fff",
              textTransform: "uppercase",
              WebkitTextStroke: `${fontSize * 0.06}px #000`,
              paintOrder: "stroke",
              opacity: local < 0 ? 0 : 1,
              transform: `scale(${local < 0 ? 0.6 : interpolate(s, [0, 1], [0.6, 1])})`,
              display: "inline-block",
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

const BenefitChips: React.FC<{ benefits: string[]; fontSize: number; brand: string }> = ({ benefits, fontSize, brand }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: fontSize * 0.5, alignItems: "flex-start" }}>
      {benefits.map((b, i) => {
        const s = spring({ frame: frame - i * 12, fps, config: { damping: 14 } });
        return (
          <div
            key={b + i}
            style={{
              fontFamily,
              fontWeight: 800,
              fontSize,
              background: "rgba(255,255,255,.95)",
              color: brand,
              padding: `${fontSize * 0.25}px ${fontSize * 0.6}px`,
              borderRadius: 999,
              transform: `translateX(${interpolate(s, [0, 1], [-120, 0])}%)`,
              opacity: s,
              boxShadow: "0 10px 30px rgba(0,0,0,.3)",
            }}
          >
            ✓ {b}
          </div>
        );
      })}
    </div>
  );
};

const EndCard: React.FC<OfferAdProps & { vertical: boolean }> = (p) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const inS = spring({ frame, fps, config: { damping: 200 } });
  const btn = spring({ frame: frame - 10, fps, config: { damping: 10 } });
  const pulse = 1 + 0.04 * Math.sin(frame / 5);
  const u = p.vertical ? width / 1080 : width / 1920;
  const nameSize = 120 * u * Math.min(1, 16 / p.shopName.length);
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(circle at 50% 30%, ${p.brandColor}, #120a2e)`,
        alignItems: "center",
        justifyContent: "center",
        gap: 40 * u,
        opacity: inS,
        padding: 60 * u,
      }}
    >
      {p.portrait && (
        <Img
          src={p.portrait}
          style={{
            width: 300 * u,
            height: 300 * u,
            borderRadius: "50%",
            objectFit: "cover",
            border: `${10 * u}px solid ${p.accentColor}`,
            boxShadow: "0 20px 60px rgba(0,0,0,.45)",
            transform: `scale(${interpolate(inS, [0, 1], [0.8, 1])})`,
          }}
        />
      )}
      <div style={{ fontFamily, fontWeight: 900, fontSize: nameSize, color: "#fff", textAlign: "center", lineHeight: 1.05 }}>
        {p.shopName}
      </div>
      {p.area && <div style={{ fontFamily, fontWeight: 600, fontSize: 48 * u, color: "#ffffffcc" }}>{p.area}</div>}
      <div
        style={{
          fontFamily,
          fontWeight: 900,
          fontSize: 64 * u * Math.min(1, 18 / p.ctaLabel.length),
          whiteSpace: "nowrap",
          color: p.brandColor,
          background: p.accentColor,
          padding: `${22 * u}px ${60 * u}px`,
          borderRadius: 999,
          transform: `scale(${btn * pulse})`,
          boxShadow: "0 20px 60px rgba(0,0,0,.4)",
        }}
      >
        {p.ctaLabel}
      </div>
      {p.website && (
        <div style={{ fontFamily, fontWeight: 800, fontSize: 52 * u * Math.min(1, 24 / p.website.length), color: "#fff" }}>
          {p.website}
        </div>
      )}
      <div style={{ fontFamily, fontWeight: 800, fontSize: 40 * u, color: p.accentColor, textAlign: "center" }}>
        {p.priceText} · {p.itemText.toLowerCase()} · {p.validText.toLowerCase()}
      </div>
      {(p.badges ?? []).length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 16 * u, maxWidth: "92%" }}>
          {(p.badges ?? []).slice(0, 4).map((b) => (
            <div
              key={b}
              style={{
                fontFamily,
                fontWeight: 800,
                fontSize: 30 * u,
                color: "#fff",
                border: `${3 * u}px solid ${p.accentColor}`,
                borderRadius: 999,
                padding: `${8 * u}px ${24 * u}px`,
                whiteSpace: "nowrap",
                background: "rgba(0,0,0,.25)",
              }}
            >
              ✓ {b}
            </div>
          ))}
        </div>
      )}
    </AbsoluteFill>
  );
};

export const OfferAd: React.FC<OfferAdProps> = (p) => {
  const { fps, width, height } = useVideoConfig();
  const vertical = height > width;
  const f = (s: number) => Math.round(s * fps);
  const u = vertical ? width / 1080 : height / 1080;
  const hookEnd = p.opener ? OPENER_HOOK_END : HOOK_END;
  const pairs = p.cinematic ? [] : (p.beforeAfter ?? []).slice(0, 2);
  const pairSeconds = p.beforeAfterSeconds ?? 3.5;
  // The before & after scene sits between the hook and the reel.
  const reelStart = hookEnd + pairs.length * pairSeconds;
  const photosEnd = Math.max(reelStart + 5, p.durationSeconds - END_CARD_SECONDS);
  // The hook uses the first photo (or the opener); the reel the rest (or all,
  // if only one or two, or if the opener took the hook).
  const reel = p.opener || p.photos.length <= 2 ? p.photos : p.photos.slice(1);

  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {/* 1. Hook: the offer, from frame 0 */}
      <Sequence durationInFrames={f(hookEnd)}>
        <MovingPhoto
          photo={p.opener ?? p.photos[0]}
          seconds={hookEnd}
          dir={1}
          blur={p.cinematic || p.opener ? 0 : vertical ? 6 : 10}
        />
        {/* Sticker sits high so the captions below never collide with it. */}
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-start", paddingTop: vertical ? 300 : 50 * u }}>
          <PriceSticker {...p} size={vertical ? 520 : 400 * u} />
        </AbsoluteFill>
      </Sequence>

      {/* 1b. Before & after: full screen in both formats, plain photos. */}
      {pairs.map((pair, i) => (
        <Sequence key={pair.before + i} from={f(hookEnd + i * pairSeconds)} durationInFrames={f(pairSeconds)}>
          <BeforeAfterPair before={pair.before} after={pair.after} seconds={pairSeconds} u={u} accent={p.accentColor} brand={p.brandColor} />
        </Sequence>
      ))}

      {/* 2. The business, moving. Landscape frames the photos on the right. */}
      <Sequence from={f(reelStart)} durationInFrames={f(photosEnd - reelStart)}>
        {!vertical && !p.cinematic && <MovingPhoto photo={p.photos[0]} seconds={photosEnd - reelStart} dir={-1} blur={24} />}
        <PhotoReel photos={reel} seconds={photosEnd - reelStart} framed={!vertical && !p.cinematic} />
        {!vertical && !p.cinematic && (
          <AbsoluteFill style={{ inset: "0 56% 0 4%", justifyContent: "center" }}>
            <div style={{ fontFamily, fontWeight: 900, fontSize: 110 * u * Math.min(1, 6 / p.priceText.length), color: p.accentColor, lineHeight: 1 }}>
              {p.priceText}
            </div>
            <div style={{ fontFamily, fontWeight: 900, fontSize: 80 * u * Math.min(1, 12 / p.itemText.length), color: "#fff", marginBottom: 40 * u }}>
              {p.itemText}
            </div>
            <Sequence from={f(2.2)} layout="none">
              <BenefitChips benefits={p.benefits.slice(0, 2)} fontSize={44 * u} brand={p.brandColor} />
            </Sequence>
          </AbsoluteFill>
        )}
        {(vertical || p.cinematic) && p.benefits.length > 0 && (
          <Sequence from={f(2.2)}>
            <AbsoluteFill style={{ padding: vertical ? 60 : 50 * u, justifyContent: "flex-start", paddingTop: vertical ? 260 : 50 * u }}>
              <BenefitChips benefits={p.benefits.slice(0, 2)} fontSize={vertical ? 52 : 40 * u} brand={p.brandColor} />
            </AbsoluteFill>
          </Sequence>
        )}
        {/* Persistent mini badge so the offer never leaves the screen. */}
        {vertical && (
          <AbsoluteFill style={{ alignItems: "flex-end", padding: 50 }}>
            <div
              style={{
                fontFamily,
                fontWeight: 900,
                fontSize: 64 * Math.min(1, 6 / p.priceText.length),
                color: p.brandColor,
                background: p.accentColor,
                borderRadius: 24,
                padding: "8px 28px",
                transform: "rotate(-4deg)",
                boxShadow: "0 10px 30px rgba(0,0,0,.4)",
              }}
            >
              {p.priceText}
            </div>
          </AbsoluteFill>
        )}
      </Sequence>

      {/* 3. End card */}
      <Sequence from={f(photosEnd)}>
        <EndCard {...p} vertical={vertical} />
      </Sequence>

      {/* Captions sit above everything except the end card */}
      <Sequence durationInFrames={f(photosEnd)}>
        <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: vertical ? 300 : 70 * u }}>
          <Captions captions={p.captions} fontSize={vertical ? 76 : 58 * u} accent={p.accentColor} />
        </AbsoluteFill>
      </Sequence>

      {p.voiceover && <Audio src={p.voiceover} />}
    </AbsoluteFill>
  );
};
