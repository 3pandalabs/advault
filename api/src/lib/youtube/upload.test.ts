import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadVideo, YouTubeUploadError } from "./upload.js";

const args = {
  accessToken: "t",
  bytes: Buffer.from("x"),
  title: "t",
  description: "d",
  synthetic: true,
};

function rejectInitiate(status: number, reason: string, message: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: { message, errors: [{ reason }] } }), { status })),
  );
}

async function caught(): Promise<YouTubeUploadError> {
  try {
    await uploadVideo(args);
  } catch (err) {
    return err as YouTubeUploadError;
  }
  throw new Error("expected a rejection");
}

afterEach(() => vi.unstubAllGlobals());

describe("uploadVideo error classification", () => {
  // Seen live 2026-11-17: the org channel's ~6/day cap. It used to be treated
  // as permanent, leaving finished ads "Not published" forever.
  it("treats the channel's daily upload cap as a wait-and-retry, not a rejection", async () => {
    rejectInitiate(400, "uploadLimitExceeded", "The user has exceeded the number of videos they may upload.");
    const err = await caught();
    expect(err).toBeInstanceOf(YouTubeUploadError);
    expect(err.retryable).toBe(true);
    expect(err.uploadLimit).toBe(true);
  });

  it("keeps a genuinely bad request permanent", async () => {
    rejectInitiate(400, "invalidTitle", "Invalid title");
    const err = await caught();
    expect(err.retryable).toBe(false);
    expect(err.uploadLimit).toBe(false);
  });
});
