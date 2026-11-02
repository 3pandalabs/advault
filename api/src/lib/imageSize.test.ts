import { describe, expect, it } from "vitest";
import { checkLogo, imageSize } from "./imageSize.js";

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

// SOI, an APP0 segment to skip over, then SOF0 with the size.
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

describe("imageSize", () => {
  it("reads PNG dimensions", () => {
    expect(imageSize(png(512, 300))).toEqual({ format: "png", width: 512, height: 300 });
  });

  it("reads JPEG dimensions past earlier segments", () => {
    expect(imageSize(jpeg(640, 480))).toEqual({ format: "jpeg", width: 640, height: 480 });
  });

  it("returns null for anything else", () => {
    expect(imageSize(Buffer.from("RIFF0000WEBPVP8 "))).toBeNull();
  });
});

describe("checkLogo", () => {
  it("accepts a square logo of at least 128px", () => {
    expect(checkLogo(png(512, 512)).ok).toBe(true);
    expect(checkLogo(jpeg(128, 128)).ok).toBe(true);
  });

  it("allows Google's 1% aspect tolerance and no more", () => {
    expect(checkLogo(png(500, 504)).ok).toBe(true);
    expect(checkLogo(png(500, 520))).toEqual({ ok: false, reason: "not_square" });
  });

  it("rejects small, unreadable and oversized files", () => {
    expect(checkLogo(png(100, 100))).toEqual({ ok: false, reason: "too_small" });
    expect(checkLogo(Buffer.from("not an image"))).toEqual({ ok: false, reason: "unreadable" });
    expect(checkLogo(Buffer.alloc(5120 * 1024 + 1))).toEqual({ ok: false, reason: "too_large" });
  });
});
