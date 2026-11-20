import { YOUTUBE_API_BASE, YOUTUBE_UPLOAD_BASE } from "./env.js";

export class YouTubeUploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Whether retrying this exact request could ever succeed. */
    readonly retryable: boolean,
    readonly details?: unknown,
    /**
     * YouTube's per-channel daily upload cap (`uploadLimitExceeded`, ~6/day
     * on an unverified channel). Not the video's fault and not permanent:
     * the job waits hours and tries again (youtubeJobs.ts UPLOAD_LIMIT_WAIT).
     */
    readonly uploadLimit = false,
  ) {
    super(message);
  }
}

export type UploadVideoArgs = {
  accessToken: string;
  bytes: Buffer;
  title: string;
  description: string;
  /** Rendered ads are AI-assisted; see containsSyntheticMedia below. */
  synthetic: boolean;
};

// Resumable upload, in two requests: initiate to get a session URI, then send
// the bytes to it.
//
// Resumable rather than the one-shot `uploadType=media` path even though the
// whole file is already in memory, for one reason: a one-shot upload that dies
// at 90% returns nothing to resume from, and these run on a shared box whose
// network is the least reliable part of the render pipeline. The session URI is
// also what makes a failure distinguishable from a rejection — see below.
export async function uploadVideo(args: UploadVideoArgs): Promise<string> {
  const metadata = {
    snippet: {
      // YouTube truncates past 100 characters and rejects angle brackets.
      title: args.title.slice(0, 100).replace(/[<>]/g, ""),
      description: args.description.slice(0, 5000),
      // 22 = "People & Blogs". Ads are not a YouTube category, and an invalid
      // categoryId is a hard 400 — this is the uncontroversial default.
      categoryId: "22",
    },
    status: {
      // Unlisted, never public. A Google Ads video ad serves perfectly well
      // from an unlisted video, and public would put every local shop's ad in
      // the org channel's public feed and subscriptions.
      privacyStatus: "unlisted",
      // Required by YouTube's own policy surface: without a declaration, videos
      // can be held or age-restricted. These are local business ads, not
      // children's content.
      selfDeclaredMadeForKids: false,
      // Required disclosure when the pipeline used an AI motion or voice
      // provider — a Kling/Luma clip or a synthesised voiceover is altered or
      // synthetic media under YouTube's rules. Passed through from the
      // creative's recorded motion/voice sources rather than hardcoded,
      // because the default pipeline (Ken Burns stills, no voice) is neither.
      containsSyntheticMedia: args.synthetic,
      embeddable: true,
    },
  };

  const initiate = await fetch(
    `${YOUTUBE_UPLOAD_BASE}/videos?uploadType=resumable&part=snippet,status`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.accessToken}`,
        "content-type": "application/json",
        "x-upload-content-length": String(args.bytes.byteLength),
        "x-upload-content-type": "video/mp4",
      },
      body: JSON.stringify(metadata),
    },
  );

  if (!initiate.ok) {
    const body = (await initiate.json().catch(() => null)) as {
      error?: { message?: string; errors?: { reason?: string }[] };
    } | null;
    const reason = body?.error?.errors?.[0]?.reason;
    throw new YouTubeUploadError(
      body?.error?.message ?? `YouTube upload initiate failed (${initiate.status})`,
      initiate.status,
      // quotaExceeded is the one worth distinguishing and the one most likely
      // to be hit: a fresh channel's default is ~6 uploads a day until it is
      // verified, which MAX_CREATIVES_PER_DAY (20) does not respect. It is
      // retryable, but not for hours — the caller's backoff handles the wait.
      isRetryableStatus(initiate.status) || reason === "quotaExceeded" || reason === "uploadLimitExceeded",
      body?.error,
      reason === "uploadLimitExceeded" || /exceeded the number of videos/i.test(body?.error?.message ?? ""),
    );
  }

  const sessionUri = initiate.headers.get("location");
  if (!sessionUri) {
    throw new YouTubeUploadError("YouTube returned no resumable session URI", 502, true);
  }

  const upload = await fetch(sessionUri, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      "content-type": "video/mp4",
      "content-length": String(args.bytes.byteLength),
    },
    body: new Uint8Array(args.bytes),
  });

  const body = (await upload.json().catch(() => null)) as
    | { id?: string; error?: { message?: string } }
    | null;

  if (!upload.ok || !body?.id) {
    throw new YouTubeUploadError(
      body?.error?.message ?? `YouTube upload failed (${upload.status})`,
      upload.status,
      isRetryableStatus(upload.status),
      body?.error,
    );
  }

  // The 11-character id that a Google Ads YoutubeVideoAsset wants. Note the
  // video is not necessarily *processed* yet — YouTube returns the id as soon
  // as the bytes land, and a video still transcoding cannot be attached to an
  // ad. The ad-attachment step at launch is what tolerates that, not this.
  return body.id;
}

// 5xx and 429 are transient; a 401 means the token needs refreshing and the
// caller already does that per attempt; everything else in the 4xx range is the
// request being wrong or the video being rejected, and retrying it burns upload
// quota for nothing.
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

// Takedown (lib/compliance/takedown.ts): make a published video private.
//
// videos.update replaces the WHOLE `status` part, so the current status is read
// first (videos.list, youtube.readonly) and sent back with only privacyStatus
// changed; otherwise the made-for-kids and synthetic-media declarations would
// reset. NOTE: videos.update needs the `youtube` (or youtube.force-ssl) scope.
// The org channel's refresh token was minted with youtube.upload + readonly
// only (env.ts YOUTUBE_SCOPES), so until it is re-minted with `youtube` this
// answers 403 and the takedown tells ops to set the video private by hand.
export type SetPrivateResult = { ok: true } | { ok: false; status: number; reason: string };

export async function setVideoPrivate(accessToken: string, videoId: string): Promise<SetPrivateResult> {
  const auth = { authorization: `Bearer ${accessToken}` };
  const read = await fetch(`${YOUTUBE_API_BASE}/videos?part=status&id=${encodeURIComponent(videoId)}`, { headers: auth });
  const readBody = (await read.json().catch(() => null)) as {
    items?: { status?: Record<string, unknown> }[];
    error?: { message?: string };
  } | null;
  if (!read.ok) return { ok: false, status: read.status, reason: readBody?.error?.message ?? `videos.list ${read.status}` };
  const status = readBody?.items?.[0]?.status;
  if (!status) return { ok: false, status: 404, reason: "video_not_found_on_channel" };
  if (status.privacyStatus === "private") return { ok: true };
  const { uploadStatus: _u, failureReason: _f, rejectionReason: _r, publishAt: _p, ...writable } = status;
  const res = await fetch(`${YOUTUBE_API_BASE}/videos?part=status`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ id: videoId, status: { ...writable, privacyStatus: "private" } }),
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return { ok: false, status: res.status, reason: body?.error?.message ?? `videos.update ${res.status}` };
}
