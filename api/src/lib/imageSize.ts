// Reads the pixel size of a PNG or JPEG from its header bytes. Enough to check
// a logo against Google's rules without adding an image library to the API
// image (which deliberately carries no native image tooling).

export type ImageInfo = { format: "png" | "jpeg"; width: number; height: number };

export function imageSize(buf: Buffer): ImageInfo | null {
  // PNG: 8-byte signature, then the IHDR chunk with width/height at 16 and 20.
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf.toString("ascii", 1, 4) === "PNG" &&
    buf.toString("ascii", 12, 16) === "IHDR"
  ) {
    return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // JPEG: walk the segments until a start-of-frame marker.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      // Fill bytes between segments.
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      const length = buf.readUInt16BE(i + 2);
      // SOF0..SOF15, excluding DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { format: "jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + length;
    }
  }
  return null;
}

// Google Demand Gen logo rules: 1:1 (±1%), at least 128x128, at most 5,120 KB.
export const LOGO_MIN_PX = 128;
export const LOGO_MAX_BYTES = 5120 * 1024;

export type LogoCheck =
  | { ok: true; info: ImageInfo }
  | { ok: false; reason: "unreadable" | "not_square" | "too_small" | "too_large" };

export function checkLogo(buf: Buffer): LogoCheck {
  if (buf.length > LOGO_MAX_BYTES) return { ok: false, reason: "too_large" };
  const info = imageSize(buf);
  if (!info) return { ok: false, reason: "unreadable" };
  if (Math.min(info.width, info.height) < LOGO_MIN_PX) return { ok: false, reason: "too_small" };
  if (Math.abs(info.width - info.height) / Math.max(info.width, info.height) > 0.01) {
    return { ok: false, reason: "not_square" };
  }
  return { ok: true, info };
}
