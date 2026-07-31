import { and, eq } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import { db } from "../db/index.js";
import { adAccounts, assets, campaigns, creatives } from "../db/schema.js";

// Every "does this user own this row" check funnels through here, so the answer
// to "can route X reach row Y" is one grep rather than a reading of every
// handler.
//
// All of these answer 404, never 403, for a row that exists but belongs to
// someone else. A 403 confirms the id is real, which turns a sequential-ish id
// space into an enumeration oracle for how many campaigns the platform has.

export async function loadOwnedCampaign(campaignId: string, userId: string, reply: FastifyReply) {
  const [row] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .limit(1);
  if (!row) {
    reply.code(404).send({ error: "not_found" });
    return null;
  }
  return row;
}

export async function loadOwnedAsset(assetId: string, userId: string, reply: FastifyReply) {
  const [row] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.userId, userId)))
    .limit(1);
  if (!row) {
    reply.code(404).send({ error: "not_found" });
    return null;
  }
  return row;
}

export async function loadOwnedAdAccount(adAccountId: string, userId: string, reply: FastifyReply) {
  const [row] = await db
    .select()
    .from(adAccounts)
    .where(and(eq(adAccounts.id, adAccountId), eq(adAccounts.userId, userId)))
    .limit(1);
  if (!row) {
    reply.code(404).send({ error: "not_found" });
    return null;
  }
  return row;
}

// Creatives have no userId of their own — ownership is inherited through the
// campaign. Joining here rather than trusting a campaignId from the request
// body is what stops a caller pairing their own campaign id with someone
// else's creative id.
export async function loadOwnedCreative(creativeId: string, userId: string, reply: FastifyReply) {
  const [row] = await db
    .select({ creative: creatives, campaign: campaigns })
    .from(creatives)
    .innerJoin(campaigns, eq(creatives.campaignId, campaigns.id))
    .where(and(eq(creatives.id, creativeId), eq(campaigns.userId, userId)))
    .limit(1);
  if (!row) {
    reply.code(404).send({ error: "not_found" });
    return null;
  }
  return row;
}
