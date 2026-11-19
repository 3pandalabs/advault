// POST /campaigns with the inputs that shape the FIRST ad (badges, category
// extras, before & after), through Fastify against PGlite (every
// drizzle/*.sql applied). Then generateForCampaign on the created row, to
// prove the first ad's script carries them. Nothing here calls Google, the
// script writer or R2.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.js";

const holder = vi.hoisted(() => {
  const dummy: Record<string, string> = {
    DATABASE_URL: "postgres://unused@localhost/unused",
    JWT_SECRET: "test-jwt-secret-test-jwt-secret-0000",
    TOKEN_ENCRYPTION_KEY: "0".repeat(64),
  };
  for (const [k, v] of Object.entries(dummy)) process.env[k] ??= v;
  return { db: null as unknown, scriptInputs: [] as Record<string, unknown>[] };
});

vi.mock("../db/index.js", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("../auth/plugin.js", () => ({
  requireAuth: async (req: FastifyRequest, reply: FastifyReply) => {
    const id = req.headers["x-test-user"];
    if (typeof id !== "string") return reply.code(401).send({ error: "unauthorized" });
    (req as FastifyRequest & { userId?: string }).userId = id;
  },
}));
// The script writer: records what it was told, returns a minimal script.
vi.mock("../lib/ai/script/index.js", () => ({
  generateScript: async (input: Record<string, unknown>) => {
    holder.scriptInputs.push(input);
    return { script: { hook: "Hook", body: "Body", voiceoverText: "Voice", scenes: [] }, source: "fallback" };
  },
}));
vi.mock("../plugins/r2.js", () => ({ presignDownload: async (k: string) => `https://r2.test/${k}` }));
vi.mock("../render/jobs.js", () => ({ enqueueRender: async () => undefined }));

const MIGRATIONS = join(__dirname, "../../drizzle");
let app: FastifyInstance;
let pg: PGlite;
let owner: string;
let stranger: string;

beforeAll(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });
  owner = (await pg.query<{ id: string }>(`insert into users (email, password_hash) values ('first@x.test', 'x') returning id`)).rows[0]!.id;
  stranger = (await pg.query<{ id: string }>(`insert into users (email, password_hash) values ('other@x.test', 'x') returning id`)).rows[0]!.id;
  const { campaignRoutes } = await import("./campaigns.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(campaignRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

async function photo(userId = owner): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into assets (user_id, kind, r2_key, content_type) values ($1, 'photo', $2, 'image/jpeg') returning id`,
    [userId, `users/${userId}/${Math.random().toString(36).slice(2)}.jpg`],
  );
  return r.rows[0]!.id;
}

const base = (businessCategory: string) => ({
  name: "First ad",
  businessName: "Tony's",
  businessCategory,
  callToAction: "Call now",
  landingUrl: null,
  offerDetails: "$49 drain cleaning this month.",
  targetZipCodes: ["08817"],
  radiusMiles: 10,
  dailyBudgetCents: 500,
});

const create = (payload: object) =>
  app.inject({ method: "POST", url: "/campaigns", headers: { "x-test-user": owner }, payload });

const campaignCount = async () =>
  (await pg.query<{ n: number }>(`select count(*)::int as n from campaigns where user_id = $1`, [owner])).rows[0]!.n;

async function refused(payload: object, error: string) {
  const before = await campaignCount();
  const res = await create(payload);
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe(error);
  // The whole create is refused: no half-made campaign is left behind.
  expect(await campaignCount()).toBe(before);
}

describe("POST /campaigns with first-ad inputs", () => {
  it("without them: unchanged, all three empty", async () => {
    const res = await create(base("Plumbing"));
    expect(res.statusCode).toBe(201);
    const c = res.json();
    expect(c.badges).toBeNull();
    expect(c.categoryExtras).toBeNull();
    expect(c.beforeAfter).toBeNull();
  });

  it("plumbing: saves attested badges and before/after pairs on the new row", async () => {
    const [b, a] = [await photo(), await photo()];
    const res = await create({
      ...base("Plumbing"),
      badges: { ids: ["license_number", "licensed_insured"], licenseNumber: " PL-1234 ", attested: true },
      beforeAfter: { pairs: [{ beforeAssetId: b, afterAssetId: a }], attested: true },
    });
    expect(res.statusCode).toBe(201);
    const c = res.json();
    expect(c.badges).toEqual({ ids: ["license_number", "licensed_insured"], licenseNumber: "PL-1234" });
    expect(c.badgesAttestedAt).toBeTruthy();
    expect(c.badgesAttestedBy).toBe(owner);
    expect(c.beforeAfter).toEqual([{ beforeAssetId: b, afterAssetId: a }]);
    expect(c.beforeAfterAttestedAt).toBeTruthy();
    expect(c.beforeAfterAttestedBy).toBe(owner);
  });

  it("restaurant: saves the featured dish (own photo) and order link, trimmed", async () => {
    const dish = await photo();
    const res = await create({
      ...base("Restaurant"),
      categoryExtras: { spotlight: { dish: " Margherita ", price: "$14", assetId: dish }, orderUrl: " https://order.example.com/tonys " },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().categoryExtras).toEqual({
      spotlight: { dish: "Margherita", price: "$14", assetId: dish },
      orderUrl: "https://order.example.com/tonys",
    });
  });

  it("empty selections save as none", async () => {
    const res = await create({
      ...base("Auto repair"),
      badges: { ids: [], attested: false },
      categoryExtras: { makes: [] },
      beforeAfter: { pairs: [] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().badges).toBeNull();
    expect(res.json().categoryExtras).toBeNull();
    expect(res.json().beforeAfter).toBeNull();
  });

  it("refuses the wrong category for each input", async () => {
    await refused({ ...base("Restaurant"), categoryExtras: { makes: ["Ford"] } }, "extras_not_for_category");
    await refused({ ...base("Plumbing"), badges: { ids: ["ase_certified"], attested: true } }, "badge_not_for_category");
    const [b, a] = [await photo(), await photo()];
    await refused(
      { ...base("Restaurant"), beforeAfter: { pairs: [{ beforeAssetId: b, afterAssetId: a }], attested: true } },
      "before_after_not_for_category",
    );
    await refused(
      { ...base("Dentistry"), beforeAfter: { pairs: [{ beforeAssetId: b, afterAssetId: a }], attested: true } },
      "before_after_not_for_category",
    );
  });

  it("refuses a missing attestation", async () => {
    await refused({ ...base("Plumbing"), badges: { ids: ["licensed_insured"] } }, "badge_attestation_required");
    await refused({ ...base("Plumbing"), badges: { ids: ["licensed_insured"], attested: false } }, "badge_attestation_required");
    const [b, a] = [await photo(), await photo()];
    await refused(
      { ...base("Plumbing"), beforeAfter: { pairs: [{ beforeAssetId: b, afterAssetId: a }] } },
      "before_after_attestation_required",
    );
  });

  it("refuses the same photo twice and photos that are not theirs", async () => {
    const [p1, p2, p3] = [await photo(), await photo(), await photo()];
    await refused(
      { ...base("Plumbing"), beforeAfter: { pairs: [{ beforeAssetId: p1, afterAssetId: p1 }], attested: true } },
      "before_after_same_photo",
    );
    await refused(
      {
        ...base("Plumbing"),
        beforeAfter: {
          pairs: [
            { beforeAssetId: p1, afterAssetId: p2 },
            { beforeAssetId: p3, afterAssetId: p2 },
          ],
          attested: true,
        },
      },
      "before_after_duplicate_photo",
    );
    const theirs = await photo(stranger);
    await refused(
      { ...base("Plumbing"), beforeAfter: { pairs: [{ beforeAssetId: p1, afterAssetId: theirs }], attested: true } },
      "unknown_assets",
    );
    await refused({ ...base("Restaurant"), categoryExtras: { spotlight: { dish: "Pie", assetId: theirs } } }, "unknown_assets");
  });

  it("refuses invalid extras and a missing license number", async () => {
    await refused({ ...base("Restaurant"), categoryExtras: { orderUrl: "javascript:alert(1)" } }, "order_url_invalid");
    await refused({ ...base("Landscaping"), categoryExtras: { neighborZips: ["08817", "560001"] } }, "neighbor_zips_invalid");
    await refused({ ...base("Plumbing"), badges: { ids: ["license_number"], attested: true } }, "badge_license_number_required");
  });
});

describe("the first ad uses what the wizard saved", () => {
  it("badges, makes and before/after reach the first script", async () => {
    const [ad1, ad2, b, a] = [await photo(), await photo(), await photo(), await photo()];
    const res = await create({
      ...base("Auto repair"),
      badges: { ids: ["ase_certified"], attested: true },
      categoryExtras: { makes: ["Toyota", "Honda"] },
      beforeAfter: { pairs: [{ beforeAssetId: b, afterAssetId: a }], attested: true },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;

    // The generate route and the paid order both load the row and call this.
    const { generateForCampaign } = await import("../lib/creatives/generate.js");
    const { campaigns } = schema;
    const { eq } = await import("drizzle-orm");
    const db = holder.db as ReturnType<typeof drizzle<typeof schema>>;
    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id));
    holder.scriptInputs.length = 0;
    const out = await generateForCampaign({
      campaign: row!,
      userId: owner,
      assetIds: [ad1, ad2],
      aspectRatios: ["16:9", "9:16"],
      warn: () => undefined,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const keys = await pg.query<{ id: string; r2_key: string }>(`select id, r2_key from assets where id = any($1)`, [[b, a]]);
    const key = new Map(keys.rows.map((r) => [r.id, r.r2_key]));
    for (const creative of out.creatives) {
      const script = creative.script as Record<string, unknown>;
      expect(script.badges).toEqual(["ASE certified"]);
      expect(script.endCardLine).toBe("We service Toyota · Honda");
      expect(script.beforeAfter).toEqual([{ beforeKey: key.get(b), afterKey: key.get(a) }]);
    }
    expect(holder.scriptInputs).toHaveLength(2);
    for (const input of holder.scriptInputs) {
      expect(input.confirmedFacts).toEqual(["ASE certified mechanics", "Makes we service: Toyota, Honda."]);
      expect(input.beforeAfterPairs).toBe(1);
    }
  });

  it("the restaurant's dish photo leads the first ad", async () => {
    const [p1, p2, dish] = [await photo(), await photo(), await photo()];
    const res = await create({
      ...base("Restaurant"),
      categoryExtras: { spotlight: { dish: "Margherita", price: "$14", assetId: dish } },
    });
    const { generateForCampaign } = await import("../lib/creatives/generate.js");
    const { eq } = await import("drizzle-orm");
    const db = holder.db as ReturnType<typeof drizzle<typeof schema>>;
    const [row] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, res.json().id));
    const out = await generateForCampaign({ campaign: row!, userId: owner, assetIds: [p1, p2], aspectRatios: ["16:9"], warn: () => undefined });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const dishKey = (await pg.query<{ r2_key: string }>(`select r2_key from assets where id = $1`, [dish])).rows[0]!.r2_key;
    expect(out.creatives[0]!.sourceAssetKeys[0]).toBe(dishKey);
    expect((out.creatives[0]!.script as Record<string, unknown>).endCardLine).toBe("Try our Margherita · $14");
  });
});
