// The password-reset core against PGlite with every migration applied, matching
// routes/sitevaultAuth.test.ts. Mail is never sent here (MAILER_URL unset), so
// the token is inserted directly to drive the confirm path.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { hashSecret, verifySecret } from "../../auth/password.js";
import * as schema from "../../db/schema.js";
import { passwordResetTokens, users } from "../../db/schema.js";
import type { Db } from "../sharedAccount/index.js";
import { changePassword, confirmPasswordReset, requestPasswordReset } from "./index.js";

let pg: PGlite;
let db: Db;

const CTX = { productName: "SiteVault", fromName: "SiteVault", resetUrlBase: "https://sitevault.3pandalabs.com/reset-password" };
const noop = () => {};

async function makeUser(email: string, password: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: email.toLowerCase(), passwordHash: await hashSecret(password) })
    .returning({ id: users.id });
  return u!.id;
}

async function putToken(userId: string, secret: string, expiresAt: Date, usedAt: Date | null = null): Promise<string> {
  const [row] = await db
    .insert(passwordResetTokens)
    .values({ userId, tokenHash: await hashSecret(secret), expiresAt, usedAt })
    .returning({ id: passwordResetTokens.id });
  return row!.id;
}

beforeAll(async () => {
  pg = new PGlite();
  const dir = join(__dirname, "../../../drizzle");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  db = drizzle(pg, { schema }) as unknown as Db;
}, 60_000);

describe("requestPasswordReset", () => {
  it("creates one token for a real account, replaces a prior one, and no-ops for an unknown email", async () => {
    const id = await makeUser("reset-a@x.test", "origpass8");
    await requestPasswordReset(db, "RESET-A@x.test", CTX, noop);
    expect((await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, id))).length).toBe(1);
    await requestPasswordReset(db, "reset-a@x.test", CTX, noop);
    expect((await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, id))).length).toBe(1);
    await requestPasswordReset(db, "nobody@x.test", CTX, noop); // must not throw
  });
});

describe("confirmPasswordReset", () => {
  it("sets the new password once, then the token is spent", async () => {
    const id = await makeUser("reset-b@x.test", "origpass8");
    const secret = "s3cr3t-value";
    const tokenId = await putToken(id, secret, new Date(Date.now() + 60_000));
    expect((await confirmPasswordReset(db, `${tokenId}.${secret}`, "brandnew9")).ok).toBe(true);
    const [u] = await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, id));
    expect(await verifySecret("brandnew9", u!.h)).toBe(true);
    expect(await verifySecret("origpass8", u!.h)).toBe(false);
    expect((await confirmPasswordReset(db, `${tokenId}.${secret}`, "another99")).ok).toBe(false); // single-use
  });

  it("rejects a bad shape, a wrong secret, and an expired token", async () => {
    const id = await makeUser("reset-c@x.test", "origpass8");
    expect((await confirmPasswordReset(db, "not-a-token", "brandnew9")).ok).toBe(false);
    expect((await confirmPasswordReset(db, "00000000-0000-0000-0000-000000000000.nope", "brandnew9")).ok).toBe(false);
    const good = await putToken(id, "right", new Date(Date.now() + 60_000));
    expect((await confirmPasswordReset(db, `${good}.wrong`, "brandnew9")).ok).toBe(false);
    const expired = await putToken(id, "right", new Date(Date.now() - 1_000));
    expect((await confirmPasswordReset(db, `${expired}.right`, "brandnew9")).ok).toBe(false);
  });
});

describe("changePassword", () => {
  it("needs the current password", async () => {
    const id = await makeUser("chg@x.test", "origpass8");
    expect((await changePassword(db, "chg@x.test", "wrongpass", "newpass99")).ok).toBe(false);
    expect((await changePassword(db, "chg@x.test", "origpass8", "newpass99")).ok).toBe(true);
    const [u] = await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, id));
    expect(await verifySecret("newpass99", u!.h)).toBe(true);
  });
});
