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
  captions: Caption[];
  durationSeconds: number;
  width: number;
  height: number;
};

const HOOK_END = 2.6;
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
    </AbsoluteFill>
  );
};

export const OfferAd: React.FC<OfferAdProps> = (p) => {
  const { fps, width, height } = useVideoConfig();
  const vertical = height > width;
  const f = (s: number) => Math.round(s * fps);
  const u = vertical ? width / 1080 : height / 1080;
  const photosEnd = Math.max(HOOK_END + 5, p.durationSeconds - END_CARD_SECONDS);
  // The hook uses the first photo; the reel the rest (or all, if only one or two).
  const reel = p.photos.length > 2 ? p.photos.slice(1) : p.photos;

  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {/* 1. Hook: the offer, from frame 0 */}
      <Sequence durationInFrames={f(HOOK_END)}>
        <MovingPhoto photo={p.photos[0]} seconds={HOOK_END} dir={1} blur={vertical ? 6 : 10} />
        {/* Sticker sits high so the captions below never collide with it. */}
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-start", paddingTop: vertical ? 300 : 50 * u }}>
          <PriceSticker {...p} size={vertical ? 520 : 400 * u} />
        </AbsoluteFill>
      </Sequence>

      {/* 2. The business, moving. Landscape frames the photos on the right. */}
      <Sequence from={f(HOOK_END)} durationInFrames={f(photosEnd - HOOK_END)}>
        {!vertical && <MovingPhoto photo={p.photos[0]} seconds={photosEnd - HOOK_END} dir={-1} blur={24} />}
        <PhotoReel photos={reel} seconds={photosEnd - HOOK_END} framed={!vertical} />
        {!vertical && (
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
        {vertical && p.benefits.length > 0 && (
          <Sequence from={f(2.2)}>
            <AbsoluteFill style={{ padding: 60, justifyContent: "flex-start", paddingTop: 260 }}>
              <BenefitChips benefits={p.benefits.slice(0, 2)} fontSize={52} brand={p.brandColor} />
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
