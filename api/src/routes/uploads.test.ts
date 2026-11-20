// "Use my own video" in both shapes (2026-11-19) through Fastify against
// PGlite (every drizzle/*.sql applied), R2 and ntfy stubbed. An internal
// account or admin may upload a 9:16 AND a 16:9; the owner's file replaces
// AdVault's blurred copy in that shape. Nothing here calls a paid API.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.js";

const holder = vi.hoisted(() => {
  const dummy: Record<string, string> = {
    DATABASE_URL: "postgres://unused@localhost/unused",
    JWT_SECRET: "test-jwt-secret-test-jwt-secret-0000",
    R2_ACCOUNT_ID: "x",
    R2_ACCESS_KEY_ID: "x",
    R2_SECRET_ACCESS_KEY: "x",
    R2_BUCKET: "x",
    R2_ENDPOINT: "https://r2.invalid",
    TOKEN_ENCRYPTION_KEY: "0".repeat(64),
  };
  for (const [k, v] of Object.entries(dummy)) process.env[k] ??= v;
  delete process.env.OWN_VIDEO_UPLOADS;
  return { db: null as unknown, deleted: [] as string[] };
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
    const r = req as FastifyRequest & { userId?: string };
    r.userId = id;
    r.userRole = req.headers["x-test-role"] === "admin" ? "admin" : "advertiser";
  },
}));
vi.mock("../plugins/r2.js", () => ({
  creativeVideoKey: (c: string, id: string) => `campaigns/${c}/creatives/${id}.mp4`,
  creativeThumbnailKey: (c: string, id: string) => `campaigns/${c}/creatives/${id}.jpg`,
  headObject: async () => ({ sizeBytes: 1000, contentType: "video/mp4" }),
  presignUpload: async (key: string) => `https://r2.invalid/${key}`,
  deleteObject: async (key: string) => {
    holder.deleted.push(key);
  },
}));
vi.mock("../lib/ops/notify.js", () => ({ notifyOps: async () => undefined }));

const MIGRATIONS = join(__dirname, "../../drizzle");
let app: FastifyInstance;
let pg: PGlite;
let admin: string;
let internal: string;
let customer: string;

const VERTICAL = { width: 1080, height: 1920, durationSeconds: 20 };
const WIDE = { width: 1920, height: 1080, durationSeconds: 20 };

beforeAll(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  holder.db = drizzle(pg, { schema });
  const user = async (email: string, role: string, isInternal: boolean) =>
    (await pg.query<{ id: string }>(
      `insert into users (email, password_hash, role, is_internal) values ($1, 'x', $2, $3) returning id`,
      [email, role, isInternal],
    )).rows[0]!.id;
  admin = await user("admin@x.test", "admin", false);
  internal = await user("advault@x.test", "advertiser", true);
  customer = await user("shop@x.test", "advertiser", false);
  const { uploadRoutes } = await import("./uploads.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(uploadRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  holder.deleted.length = 0;
});

async function campaign(owner: string): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into campaigns (user_id, name, business_name, business_category, target_zip_codes, daily_budget_cents)
     values ($1, 'Brand', 'AdVault', 'Marketing', '{08817}', 1000) returning id`,
    [owner],
  );
  return r.rows[0]!.id;
}

const headers = (user: string) => ({ "x-test-user": user, "x-test-role": user === admin ? "admin" : "advertiser" });

const presign = (user: string, campaignId: string, meta: object) =>
  app.inject({ method: "POST", url: `/campaigns/${campaignId}/creatives/upload-url`, headers: headers(user), payload: meta });

const confirm = (user: string, campaignId: string, meta: object, creativeId = randomUUID()) =>
  app.inject({
    method: "POST",
    url: `/campaigns/${campaignId}/creatives/upload`,
    headers: headers(user),
    payload: { ...meta, creativeId, rightsAttested: true },
  });

type Row = { id: string; aspect_ratio: string; render_status: string; engine: string | null; review_status: string | null };
const uploads = async (campaignId: string) =>
  (await pg.query<Row>(
    `select id, aspect_ratio, render_status, render_info->>'engine' as engine, review_status
       from creatives where campaign_id = $1 and kind = 'upload' order by created_at`,
    [campaignId],
  )).rows;

const renderJobsFor = async (creativeId: string) =>
  (await pg.query(`select id from render_jobs where creative_id = $1`, [creativeId])).rows.length;

describe("own video in both shapes", () => {
  it("admin: the first upload is approved and AdVault queues a copy in the other shape", async () => {
    const c = await campaign(admin);
    const res = await confirm(admin, c, VERTICAL);
    expect(res.statusCode).toBe(201);
    const rows = await uploads(c);
    expect(rows.map((r) => [r.aspect_ratio, r.engine, r.render_status])).toEqual([
      ["9:16", null, "ready"],
      ["16:9", "reformat", "queued"],
    ]);
    expect(await renderJobsFor(rows[1]!.id)).toBe(1);
  });

  it("a second upload in the SAME shape is 409 already_uploaded (presign and confirm)", async () => {
    const c = await campaign(admin);
    expect((await confirm(admin, c, VERTICAL)).statusCode).toBe(201);
    const p = await presign(admin, c, VERTICAL);
    expect(p.statusCode).toBe(409);
    expect(p.json()).toEqual({ error: "already_uploaded" });
    const res = await confirm(admin, c, VERTICAL);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "already_uploaded" });
    expect((await uploads(c)).filter((r) => r.aspect_ratio === "9:16")).toHaveLength(1);
  });

  it("the other shape replaces AdVault's queued copy: row, render job and files gone, never resurrected", async () => {
    const c = await campaign(admin);
    await confirm(admin, c, VERTICAL);
    const copy = (await uploads(c)).find((r) => r.engine === "reformat")!;
    const job = (await pg.query<{ id: string; attempts: number; max_attempts: number }>(
      `select id, attempts, max_attempts from render_jobs where creative_id = $1`,
      [copy.id],
    )).rows[0]!;
    // As if the renderer had already claimed it and is encoding right now.
    await pg.query(`update creatives set render_status = 'rendering' where id = $1`, [copy.id]);

    expect((await presign(admin, c, WIDE)).statusCode).toBe(200);
    const own = randomUUID();
    const res = await confirm(admin, c, WIDE, own);
    expect(res.statusCode).toBe(201);

    const rows = await uploads(c);
    expect(rows.map((r) => [r.aspect_ratio, r.engine, r.id === own])).toEqual([
      ["9:16", null, false],
      ["16:9", null, true],
    ]);
    expect(await renderJobsFor(copy.id)).toBe(0);
    expect(holder.deleted).toEqual([]); // the copy had no files yet
    // Both own uploads approved: no new copy either way.
    expect(rows.every((r) => r.review_status === "approved")).toBe(true);

    // The renderer finishes the stale job: nothing is recreated or published.
    const { completeJob } = await import("../render/jobs.js");
    const kept = await completeJob(
      { id: job.id, creativeId: copy.id, attempts: job.attempts, maxAttempts: job.max_attempts },
      { videoKey: "k.mp4", thumbnailKey: "k.jpg", durationSeconds: 20, sizeBytes: 1 },
    );
    expect(kept).toBe(false);
    expect((await pg.query(`select 1 from creatives where id = $1`, [copy.id])).rows).toHaveLength(0);
    expect((await pg.query(`select 1 from youtube_upload_jobs where creative_id = $1`, [copy.id])).rows).toHaveLength(0);
  });

  it("a READY copy is replaced and its MP4 and thumbnail are deleted from R2", async () => {
    const c = await campaign(admin);
    await confirm(admin, c, WIDE);
    const copy = (await uploads(c)).find((r) => r.engine === "reformat")!;
    expect(copy.aspect_ratio).toBe("9:16");
    await pg.query(
      `update creatives set render_status = 'ready', video_key = $2, thumbnail_key = $3 where id = $1`,
      [copy.id, `v/${copy.id}.mp4`, `v/${copy.id}.jpg`],
    );
    await pg.query(`update render_jobs set status = 'done' where creative_id = $1`, [copy.id]);
    expect((await confirm(admin, c, VERTICAL)).statusCode).toBe(201);
    expect((await uploads(c)).some((r) => r.id === copy.id)).toBe(false);
    expect(holder.deleted.sort()).toEqual([`v/${copy.id}.jpg`, `v/${copy.id}.mp4`]);
  });

  it("refuses to replace a copy mid-upload to YouTube", async () => {
    const c = await campaign(admin);
    await confirm(admin, c, VERTICAL);
    const copy = (await uploads(c)).find((r) => r.engine === "reformat")!;
    await pg.query(`update creatives set render_status = 'ready', youtube_upload_status = 'uploading' where id = $1`, [copy.id]);
    const res = await confirm(admin, c, WIDE);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "upload_in_progress" });
    expect((await uploads(c)).some((r) => r.id === copy.id)).toBe(true);
  });

  it("internal account: both uploads wait for review, and approving the first makes no copy", async () => {
    const c = await campaign(internal);
    expect((await confirm(internal, c, VERTICAL)).statusCode).toBe(201);
    expect((await uploads(c)).map((r) => r.review_status)).toEqual(["pending_review"]); // no copy until approved
    expect((await confirm(internal, c, WIDE)).statusCode).toBe(201);
    expect((await confirm(internal, c, WIDE)).statusCode).toBe(409);
    const rows = await uploads(c);
    expect(rows.map((r) => [r.aspect_ratio, r.review_status])).toEqual([
      ["9:16", "pending_review"],
      ["16:9", "pending_review"],
    ]);
    // An admin approves the 9:16: the owner's own 16:9 is there, so no copy.
    await pg.query(`update creatives set review_status = 'approved' where id = $1`, [rows[0]!.id]);
    const { queueOtherFormat } = await import("../lib/uploads/otherFormat.js");
    expect(await queueOtherFormat(rows[0]!.id)).toBeNull();
    expect(await uploads(c)).toHaveLength(2);
  });

  it("queueOtherFormat skips when the owner uploaded that shape, even after a copy was replaced", async () => {
    const c = await campaign(admin);
    await confirm(admin, c, VERTICAL);
    await confirm(admin, c, WIDE);
    const { queueOtherFormat } = await import("../lib/uploads/otherFormat.js");
    for (const r of await uploads(c)) expect(await queueOtherFormat(r.id)).toBeNull();
    expect((await uploads(c)).every((r) => r.engine === null)).toBe(true);
  });

  it("removing one of the two own videos brings AdVault's copy back for that shape", async () => {
    const c = await campaign(admin);
    await confirm(admin, c, VERTICAL);
    const wide = randomUUID();
    await confirm(admin, c, WIDE, wide);
    const del = await app.inject({ method: "DELETE", url: `/creatives/${wide}`, headers: headers(admin) });
    expect(del.statusCode).toBe(204);
    expect((await uploads(c)).map((r) => [r.aspect_ratio, r.engine])).toEqual([
      ["9:16", null],
      ["16:9", "reformat"],
    ]);
  });

  it("removing the source video removes the copy made from it", async () => {
    const c = await campaign(admin);
    const src = randomUUID();
    await confirm(admin, c, VERTICAL, src);
    expect(await uploads(c)).toHaveLength(2);
    const del = await app.inject({ method: "DELETE", url: `/creatives/${src}`, headers: headers(admin) });
    expect(del.statusCode).toBe(204);
    expect(await uploads(c)).toHaveLength(0);
  });

  it("a plain customer is unchanged: still 403 own_video_paused", async () => {
    const c = await campaign(customer);
    for (const res of [await presign(customer, c, VERTICAL), await confirm(customer, c, WIDE)]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "own_video_paused" });
    }
  });
});
