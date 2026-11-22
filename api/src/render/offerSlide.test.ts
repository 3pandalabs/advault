// The "This month's offer" end slide (render/offerSlide.ts): the pure layout
// and ffmpeg argument builder, plus a real small encode when ffmpeg and a
// font are on this machine (skipped otherwise).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { offerSlideCommand, parseProbe, probeSource, renderOfferSlide, slideLayout, wrapText, type SourceProbe } from "./offerSlide.js";

const probe916: SourceProbe = { width: 1080, height: 1920, fps: "30", hasAudio: true, durationSeconds: 12.5 };

describe("wrapText", () => {
  it("wraps on words, never over the limit, splits a word longer than a line", () => {
    expect(wrapText("$25 off any move-out clean until Dec 15", 16)).toEqual(["$25 off any", "move-out clean", "until Dec 15"]);
    expect(wrapText("  a   b  ", 10)).toEqual(["a b"]);
    const long = wrapText("Supercalifragilistic deal", 8);
    expect(long.every((l) => l.length <= 8)).toBe(true);
    expect(long.join("")).toBe("Supercalifragilisticdeal");
  });
});

describe("slideLayout", () => {
  for (const [w, h] of [
    [1080, 1920],
    [1920, 1080],
    [720, 1280],
    [1280, 720],
  ] as const) {
    it(`fits a long offer inside the safe margins at ${w}x${h}`, () => {
      const offer = "Free gutter cleaning with every full roof inspection booked before the end of the month, all neighborhoods";
      const l = slideLayout({ width: w, height: h, heading: "This month's offer", offer, until: "Until Dec 31" });
      expect(l.texts[0]!.text).toBe("This month's offer");
      expect(l.texts.at(-1)!.text).toBe("Until Dec 31");
      for (const t of l.texts) {
        // Estimated width at 0.66 em a character stays inside 84% of the width.
        expect(t.text.length * t.size * 0.66).toBeLessThanOrEqual(w * 0.84 + 1);
        expect(t.y).toBeGreaterThanOrEqual(h * 0.05);
        expect(t.y + t.size).toBeLessThanOrEqual(h * 0.95);
      }
      expect(l.bar.x).toBeGreaterThan(0);
      expect(l.bar.x + l.bar.w).toBeLessThan(w);
      // The whole offer is there (no truncation for a normal length).
      expect(l.texts.slice(1, -1).map((t) => t.text).join(" ")).toBe(offer);
    });
  }

  it("a 500-character offer still fits (shrinks, then cuts with an ellipsis)", () => {
    const offer = "Big savings on everything ".repeat(20).trim();
    const l = slideLayout({ width: 1920, height: 1080, heading: "This month's offer", offer, until: "Until Dec 31" });
    const last = l.texts.at(-1)!;
    expect(last.y + last.size).toBeLessThanOrEqual(1080);
    expect(l.texts.length - 2).toBeLessThanOrEqual(8);
  });
});

describe("parseProbe", () => {
  it("evens the size, keeps a sane frame rate, finds audio and the length", () => {
    const p = parseProbe({
      streams: [
        { codec_type: "video", width: 1081, height: 1921, r_frame_rate: "30000/1001", duration: "10.010" },
        { codec_type: "audio", sample_rate: "44100", channels: 1 },
      ],
      format: { duration: "10.2" },
    });
    expect(p).toEqual({ width: 1080, height: 1920, fps: "30000/1001", hasAudio: true, durationSeconds: 10.01 });
  });
  it("odd frame rates fall back to the average, then 30; no audio; format duration", () => {
    const p = parseProbe({ streams: [{ codec_type: "video", width: 1920, height: 1080, r_frame_rate: "90000/1", avg_frame_rate: "0/0" }], format: { duration: "7" } });
    expect(p).toMatchObject({ fps: "30", hasAudio: false, durationSeconds: 7 });
    expect(() => parseProbe({ streams: [{ codec_type: "audio" }] })).toThrow(/no video/);
  });
});

describe("offerSlideCommand", () => {
  const layout = slideLayout({ width: 1080, height: 1920, heading: "This month's offer", offer: "50% off: Mike's 'deep' clean; 100% [fun]", until: "Until Dec 31" });

  it("text goes in through textfiles only, never inline in the filter graph", () => {
    const cmd = offerSlideCommand({ inputPath: "/w/source.mp4", outputPath: "/w/out.mp4", probe: probe916, layout, slideSeconds: 4 });
    const graph = cmd.args[cmd.args.indexOf("-filter_complex") + 1]!;
    expect(graph).not.toContain("Mike");
    expect(graph).not.toContain("text='");
    expect(cmd.textFiles.map((f) => f.text).join(" ")).toContain("Mike's");
    for (const f of cmd.textFiles) expect(graph).toContain(`textfile=${f.name}`);
    expect(graph).toContain("fontfile=bold.ttf");
    expect(graph).toContain("fontfile=regular.ttf");
    expect(graph).toContain("expansion=none");
  });

  it("normalises both segments to the source's size, fps, SAR, pixel format and 48 kHz stereo, then concats", () => {
    const cmd = offerSlideCommand({ inputPath: "/w/source.mp4", outputPath: "/w/out.mp4", probe: { ...probe916, fps: "30000/1001" }, layout, slideSeconds: 4 });
    const graph = cmd.args[cmd.args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920");
    expect(graph).toContain("setsar=1,fps=30000/1001,format=yuv420p,trim=duration=12.500");
    expect(graph).toContain("color=c=0x09090b:s=1080x1920:r=30000/1001:d=4.000");
    expect(graph).toContain("[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=12.500");
    expect(graph).toContain("anullsrc=r=48000:cl=stereo,atrim=duration=4.000[a1]");
    expect(graph).toContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]");
    expect(cmd.args.slice(0, 2)).toEqual(["-i", "/w/source.mp4"]);
    expect(cmd.args.at(-1)).toBe("/w/out.mp4");
    expect(cmd.args).toEqual(expect.arrayContaining(["-map", "[v]", "[a]", "libx264", "aac"]));
  });

  it("a silent source gets silence under its video part", () => {
    const cmd = offerSlideCommand({ inputPath: "s.mp4", outputPath: "o.mp4", probe: { ...probe916, hasAudio: false }, layout, slideSeconds: 4 });
    const graph = cmd.args[cmd.args.indexOf("-filter_complex") + 1]!;
    expect(graph).not.toContain("[0:a]");
    expect(graph).toContain("anullsrc=r=48000:cl=stereo,atrim=duration=12.500[a0]");
  });
});

// --- a real encode, when this machine can --------------------------------------

function hasBin(bin: string): boolean {
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const FONT_CANDIDATES = [
  process.env.RENDER_FONT_BOLD,
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  "C:/Windows/Fonts/arialbd.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
].filter((p): p is string => Boolean(p));
const FONT = FONT_CANDIDATES.find((p) => existsSync(p));
const canEncode = hasBin("ffmpeg") && hasBin("ffprobe") && Boolean(FONT);

describe.skipIf(!canEncode)("a real encode (ffmpeg on this machine)", () => {
  for (const [w, h, withAudio] of [
    [360, 640, true],
    [640, 360, false],
  ] as const) {
    it(`${w}x${h} ${withAudio ? "with" : "without"} audio: source + 4 s slide, same size, audio track`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "offer-slide-test-"));
      try {
        const src = join(dir, "src.mp4");
        execFileSync("ffmpeg", [
          "-y", "-hide_banner", "-loglevel", "error",
          "-f", "lavfi", "-i", `testsrc=size=${w}x${h}:rate=25:duration=2`,
          ...(withAudio ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2"] : []),
          "-c:v", "libx264", "-pix_fmt", "yuv420p", ...(withAudio ? ["-c:a", "aac", "-ac", "1"] : []),
          "-shortest", src,
        ]);
        const out = await renderOfferSlide({
          inputPath: src,
          workDir: dir,
          heading: "This month's offer",
          offer: "50% off: Mike's 'deep' clean; 100% [fun] \\ until Friday",
          until: "Until Dec 31",
          slideSeconds: 4,
          fonts: { bold: FONT!, regular: FONT! },
        });
        const p = await probeSource(out.videoPath);
        expect(p.width).toBe(w);
        expect(p.height).toBe(h);
        expect(p.hasAudio).toBe(true);
        expect(p.durationSeconds).toBeGreaterThan(5.8);
        expect(p.durationSeconds).toBeLessThan(6.3);
        expect(existsSync(out.thumbnailPath)).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 60_000);
  }
});
