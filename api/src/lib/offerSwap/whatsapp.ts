// The WhatsApp half of "Change my offer" (2026-11-21), for Keep it running
// subscribers. Runs ONLY for users offerSwapAllowedFor() accepts (sends on,
// OFFER_SWAP_WHATSAPP internal/on, the owner's opt-in, internal accounts only
// in `internal` mode); otherwise handleSwapInbound returns
// { handled: false } and every notify is a no-op, so the web page is the
// whole product. The rules it keeps from the original loop (lib/offers,
// CLAUDE.md "Local ads are OFFER ads"):
//   - a conversation is only ever OPENED by a pre-approved template
//     (sendTemplate); free text / buttons / video only inside the 24-hour
//     window opened by the owner's own last message (sendText, sendButtons,
//     sendVideo);
//   - the monthly prompt and its reminders are the existing offer_cycles
//     sweep (2 reminders, then it stops);
//   - every inbound is recorded and de-duplicated by Meta's message id.

import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { assets, campaigns, offerChanges, offerCycles, users, whatsappMessages } from "../../db/schema.js";
import { assetKey, deleteObject, presignDownload, putObject } from "../../plugins/r2.js";
import { transcribe } from "../ai/stt.js";
import { offerSwapAllowedFor, recordMessage, userForPhone, whatsAppUser } from "../offers/index.js";
import { hasOfferChanges, type ProductLine } from "../pricing/index.js";
import { liveSubscriptionFor } from "../subscriptions/index.js";
import { ATTESTATION_ACCURACY_TEXT, ATTESTATION_MEDIA_TEXT } from "../compliance/texts.js";
import {
  downloadMedia,
  offerSwapWhatsAppEnabled,
  sendButtons,
  sendTemplate,
  sendText,
  sendVideo,
  TEMPLATES,
  type InboundAny,
} from "../whatsapp/index.js";
import {
  cancelOfferChange,
  confirmOfferChange,
  createOfferChange,
  offerChangeView,
  quoteOfferChange,
  recordWhatsAppAttestation,
} from "./index.js";
import {
  BUTTON_APPROVE,
  BUTTON_REJECT,
  classifySwapReply,
  MAX_VOICE_BYTES,
  noLiveCampaignMessage,
  notAllowedMessage,
  swapPaymentMessage,
  swapPreviewMessage,
  swapSubmittedMessage,
  transcriptionAllowed,
  typeItMessage,
} from "./policy.js";

const MAX_PHOTO_BYTES = 8_000_000;
const WINDOW_MS = 24 * 3_600_000;

type Change = typeof offerChanges.$inferSelect;

export async function windowOpen(userId: string, now = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.userId, userId),
        eq(whatsappMessages.direction, "inbound"),
        gte(whatsappMessages.createdAt, new Date(now.getTime() - WINDOW_MS)),
      ),
    );
  return (row?.n ?? 0) > 0;
}

/** The owner's phone, only when the offer-change loop runs for them (opt-in, mode). */
async function phoneOf(userId: string): Promise<string | null> {
  const u = await whatsAppUser(userId);
  return u && offerSwapAllowedFor(u) ? u.phone : null;
}

/** Free text to the owner, inside the window only. */
async function say(userId: string, to: string, body: string, changeId?: string | null): Promise<void> {
  const r = await sendText({ to, body });
  await recordMessage({ userId, direction: "outbound", phone: to, body, providerRef: r.providerRef });
  if (changeId) await tagLastOutbound(r.providerRef, changeId);
}

async function tagLastOutbound(providerRef: string, changeId: string) {
  if (!providerRef) return;
  await db.update(whatsappMessages).set({ offerChangeId: changeId }).where(eq(whatsappMessages.providerRef, providerRef));
}

/**
 * News about a change for the owner: free text inside the window, else the
 * named template. No-op (false) when the loop is off or there is no phone.
 */
export async function notifyOwner(args: {
  userId: string;
  changeId: string;
  text: string;
  template: string;
  params: string[];
  now?: Date;
}): Promise<boolean> {
  if (!offerSwapWhatsAppEnabled()) return false;
  const to = await phoneOf(args.userId);
  if (!to) return false;
  try {
    if (await windowOpen(args.userId, args.now)) {
      await say(args.userId, to, args.text, args.changeId);
    } else {
      const r = await sendTemplate({ to, template: args.template, params: args.params });
      await recordMessage({ userId: args.userId, direction: "outbound", phone: to, body: `[template ${args.template}] ${args.params.join(" | ")}`, providerRef: r.providerRef });
    }
    return true;
  } catch (err) {
    console.log(JSON.stringify({ job: "offer-swap", msg: "owner WhatsApp failed", extra: { changeId: args.changeId, error: String(err) } }));
    return false;
  }
}

/**
 * The preview: the 9:16 cut as a video message, then the text with YES / NO
 * buttons and the two attestation sentences (a YES is the owner's tick).
 * Only inside the window; outside it the campaign page has the preview.
 */
export async function sendSwapPreview(change: Change, now = new Date()): Promise<boolean> {
  if (!offerSwapWhatsAppEnabled() || change.source !== "whatsapp" || !change.offerText || !change.endsAt) return false;
  const to = await phoneOf(change.userId);
  if (!to || !(await windowOpen(change.userId, now))) return false;
  try {
    const view = await offerChangeView(change);
    const cut = view.creatives.find((c) => c.aspectRatio === "9:16") ?? view.creatives[0];
    if (cut?.videoUrl) {
      const r = await sendVideo({ to, link: cut.videoUrl, caption: "Your ad with the new offer" });
      await recordMessage({ userId: change.userId, direction: "outbound", phone: to, body: "[preview video]", providerRef: r.providerRef });
    }
    const quote = await quoteOfferChange(change.userId, now);
    const body =
      swapPreviewMessage({
        offer: change.offerText,
        endsAt: change.endsAt,
        inferred: change.endsAtInferred,
        priceDisplay: quote.charge === "paid" ? quote.display : null,
        previewUrl: null,
      }) + `\n\nBy replying YES you confirm: ${ATTESTATION_ACCURACY_TEXT} ${ATTESTATION_MEDIA_TEXT}`;
    const r = await sendButtons({ to, body, buttons: [{ id: BUTTON_APPROVE, title: "YES, put it live" }, { id: BUTTON_REJECT, title: "Not now" }] });
    await recordMessage({ userId: change.userId, direction: "outbound", phone: to, body, providerRef: r.providerRef });
    await tagLastOutbound(r.providerRef, change.id);
    return true;
  } catch (err) {
    console.log(JSON.stringify({ job: "offer-swap", msg: "preview WhatsApp failed", extra: { changeId: change.id, error: String(err) } }));
    return false;
  }
}

export type SwapInboundOutcome =
  | { handled: false }
  | { handled: true; action: "duplicate" | "offer" | "approved" | "payment_link" | "rejected" | "photo_saved" | "type_it" | "refused" | "unclear" | "no_campaign"; changeId?: string };

/** The owner's launched campaign the loop works on (newest live, else paused). */
async function swapCampaign(userId: string) {
  const [c] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.userId, userId), inArray(campaigns.status, ["live", "paused"]), isNotNull(campaigns.googleAdGroupResourceName)))
    .orderBy(sql`case when ${campaigns.status} = 'live' then 0 else 1 end`, desc(campaigns.launchedAt))
    .limit(1);
  return c ?? null;
}

async function openCycle(userId: string) {
  const [c] = await db
    .select()
    .from(offerCycles)
    .where(and(eq(offerCycles.userId, userId), inArray(offerCycles.status, ["pending", "prompted", "answered", "previewed"])))
    .orderBy(desc(offerCycles.periodMonth))
    .limit(1);
  return c ?? null;
}

/** A photo sent in the last 24 h and not used by a change yet. */
async function unusedPhoto(userId: string, now: Date): Promise<{ messageId: string; assetId: string } | null> {
  const [m] = await db
    .select({ id: whatsappMessages.id, key: whatsappMessages.mediaKey })
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.userId, userId),
        eq(whatsappMessages.mediaType, "image"),
        isNotNull(whatsappMessages.mediaKey),
        isNull(whatsappMessages.offerChangeId),
        gte(whatsappMessages.createdAt, new Date(now.getTime() - WINDOW_MS)),
      ),
    )
    .orderBy(desc(whatsappMessages.createdAt))
    .limit(1);
  if (!m?.key) return null;
  const [a] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.r2Key, m.key), eq(assets.userId, userId))).limit(1);
  return a ? { messageId: m.id, assetId: a.id } : null;
}

const REFUSAL_TEXT: Record<string, string> = {
  offer_change_in_progress: "Your last offer change is still with Google. We'll message you when it's live; then you can send another.",
  offer_change_daily_limit: "That's the most new versions we can make today. Please try again tomorrow.",
  live_ad_is_upload: "Your ad is your own video, so we can't change the offer in it. Upload a new video on AdVault instead (free).",
  campaign_not_launched: "You don't have an ad running right now, so there's nothing to change. Open AdVault to launch one.",
  ends_on_in_past: "That date has already passed. Please send the offer with a later end date.",
};

/**
 * One inbound message for the offer-change loop. Returns { handled: false }
 * (the caller then uses the original offer loop) when the loop is off, the
 * sender is unknown, or their plan has no offer changes.
 */
export async function handleSwapInbound(msg: InboundAny, opts: { now?: Date; log?: (m: string, e?: unknown) => void } = {}): Promise<SwapInboundOutcome> {
  const now = opts.now ?? new Date();
  if (!offerSwapWhatsAppEnabled()) return { handled: false };
  const user = await userForPhone(msg.from);
  if (!user) return { handled: false };
  // Not opted in, or not internal while OFFER_SWAP_WHATSAPP=internal.
  if (!offerSwapAllowedFor(user)) return { handled: false };
  const sub = await liveSubscriptionFor(user.id);
  if (!sub || !hasOfferChanges(sub.line as ProductLine)) return { handled: false };

  const cycle = await openCycle(user.id);
  const logged = await recordMessage({
    userId: user.id,
    offerCycleId: cycle?.id ?? null,
    direction: "inbound",
    phone: msg.from,
    body: msg.body,
    providerRef: msg.providerRef,
  });
  if (logged.duplicate) return { handled: true, action: "duplicate" };
  const setMsg = (patch: Partial<typeof whatsappMessages.$inferInsert>) =>
    db.update(whatsappMessages).set(patch).where(eq(whatsappMessages.providerRef, msg.providerRef));
  const reply = (body: string, changeId?: string | null) => say(user.id, msg.from, body, changeId);

  const campaign = await swapCampaign(user.id);
  if (!campaign) {
    await reply(noLiveCampaignMessage());
    return { handled: true, action: "no_campaign" };
  }
  const [awaiting] = await db
    .select()
    .from(offerChanges)
    .where(and(eq(offerChanges.campaignId, campaign.id), eq(offerChanges.kind, "offer"), inArray(offerChanges.status, ["preview", "awaiting_payment"])))
    .orderBy(desc(offerChanges.createdAt))
    .limit(1);

  let text = msg.body;
  let photoAssetId: string | null = null;

  if (msg.kind === "audio" && msg.mediaId) {
    const [{ n: used }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(whatsappMessages)
      .where(and(eq(whatsappMessages.userId, user.id), isNotNull(whatsappMessages.transcript), gte(whatsappMessages.createdAt, new Date(now.getTime() - WINDOW_MS))));
    let transcript: string | null = null;
    const dl = await downloadMedia(msg.mediaId, MAX_VOICE_BYTES).catch(() => null);
    if (dl && !("tooLarge" in dl) && transcriptionAllowed({ bytes: dl.bytes.byteLength, usedToday: used ?? 0 })) {
      // Kept in R2 only long enough for the transcriber to fetch it.
      const key = `whatsapp/${user.id}/${msg.providerRef.replace(/[^A-Za-z0-9_.-]/g, "")}.ogg`;
      try {
        await putObject(key, dl.bytes, dl.mimeType.split(";")[0] || "audio/ogg");
        await setMsg({ mediaType: "audio", mediaKey: key });
        transcript = await transcribe(await presignDownload(key));
      } finally {
        await deleteObject(key).catch(() => undefined);
        await setMsg({ mediaKey: null });
      }
    }
    if (!transcript) {
      await reply(typeItMessage());
      return { handled: true, action: "type_it" };
    }
    await setMsg({ transcript });
    text = transcript;
  }

  if (msg.kind === "image" && msg.mediaId) {
    const dl = await downloadMedia(msg.mediaId, MAX_PHOTO_BYTES).catch(() => null);
    const type = dl && !("tooLarge" in dl) ? dl.mimeType.split(";")[0] : null;
    const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : type === "image/jpeg" ? "jpg" : null;
    if (!dl || "tooLarge" in dl || !ext) {
      await reply("Sorry, we couldn't use that photo. Please send it as a normal photo (JPG or PNG).");
      return { handled: true, action: "refused" };
    }
    // The photo becomes one of the owner's AdVault photos (assets), like an upload.
    const key = assetKey(user.id, ext);
    await putObject(key, dl.bytes, type!);
    const [asset] = await db
      .insert(assets)
      .values({ userId: user.id, kind: "photo", r2Key: key, contentType: type!, sizeBytes: dl.bytes.byteLength, originalFilename: "whatsapp-photo" })
      .returning();
    await setMsg({ mediaType: "image", mediaKey: key });
    photoAssetId = asset!.id;
    if (!text.trim()) {
      if (awaiting?.offerText) {
        text = awaiting.offerText; // same offer, now with this photo
      } else {
        await reply("Got your photo. What's the offer? For example \"$10 off any cleaning until Dec 15\".");
        return { handled: true, action: "photo_saved" };
      }
    }
  }

  const intent = classifySwapReply(
    { kind: msg.kind === "audio" ? "text" : msg.kind === "image" ? "text" : msg.kind, text, buttonId: msg.buttonId },
    awaiting?.status === "preview",
  );

  switch (intent.intent) {
    case "unclear":
      return { handled: true, action: "unclear" };
    case "reject": {
      if (awaiting) await cancelOfferChange(awaiting.id, user.id);
      await reply("OK. Your current ad keeps running. Send a new offer any time.");
      return { handled: true, action: "rejected" };
    }
    case "approve": {
      if (!awaiting || awaiting.status !== "preview") return { handled: true, action: "unclear" };
      await recordWhatsAppAttestation(campaign, user.id, awaiting.id);
      const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, user.id)).limit(1);
      const r = await confirmOfferChange({ changeId: awaiting.id, userId: user.id, userEmail: u?.email?.endsWith(".invalid") ? null : u?.email, now });
      if (!r.ok) {
        await reply(
          r.body.error === "needs_review"
            ? "We're checking some of the wording before it can run (usually within a day). We'll message you when it's sent to Google."
            : "Sorry, we couldn't put it live. Please try again on your campaign page.",
          awaiting.id,
        );
        return { handled: true, action: "refused", changeId: awaiting.id };
      }
      if (cycle) await db.update(offerCycles).set({ status: "approved", approvedAt: now, updatedAt: now }).where(eq(offerCycles.id, cycle.id));
      if (r.status === "awaiting_payment") {
        await reply(
          r.checkoutUrl ? swapPaymentMessage(r.display, r.checkoutUrl) : "Please finish the payment on your campaign page to put it live.",
          awaiting.id,
        );
        return { handled: true, action: "payment_link", changeId: awaiting.id };
      }
      await reply(swapSubmittedMessage(), awaiting.id);
      return { handled: true, action: "approved", changeId: awaiting.id };
    }
    case "photo":
    case "voice":
    case "offer": {
      const offerText = intent.intent === "offer" ? intent.text : text;
      const photo = photoAssetId ? { messageId: null, assetId: photoAssetId } : await unusedPhoto(user.id, now);
      const res = await createOfferChange({
        campaign,
        userId: user.id,
        offerText,
        photoAssetId: photo?.assetId ?? null,
        source: "whatsapp",
        offerCycleId: cycle?.id ?? null,
        now,
        warn: opts.log,
      });
      if (!res.ok) {
        const code = String(res.body.error);
        await reply(code === "claim_not_allowed" ? notAllowedMessage(String(res.body.detail ?? "")) : (REFUSAL_TEXT[code] ?? "Sorry, we couldn't use that offer. Please try again on your campaign page."));
        return { handled: true, action: "refused" };
      }
      if (photo?.messageId) await db.update(whatsappMessages).set({ offerChangeId: res.change.id }).where(eq(whatsappMessages.id, photo.messageId));
      await setMsg({ offerChangeId: res.change.id });
      if (cycle) {
        await db
          .update(offerCycles)
          .set({ status: "answered", offerText, offerExpiresAt: res.change.endsAt, answeredAt: now, campaignId: campaign.id, updatedAt: now })
          .where(eq(offerCycles.id, cycle.id));
      }
      await reply(`Making your ad with "${offerText}". We'll send you a preview in a few minutes.`, res.change.id);
      return { handled: true, action: "offer", changeId: res.change.id };
    }
  }
}



