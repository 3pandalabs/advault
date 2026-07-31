// Applies drizzle/*.sql migrations. In production this runs automatically on
// every deploy via the API Dockerfile's CMD, as the compiled
// `node dist/db/migrate.js` (`npm run db:migrate:prod`) — the runtime image is
// --omit=dev and has no tsx/src, so `npm run db:migrate` (tsx) is dev-only.
//
// ONLY the API container runs this. Dockerfile.renderer deliberately does not:
// two containers migrating on the same deploy race the `drizzle` bookkeeping
// table, and the loser crash-loops.
//
// Migrations run as the SAME role as the runtime (DATABASE_URL). On the shared
// 3pandalabs-postgres instance, `advault_app` owns the `advault` database and
// every table in it, so it runs DDL fine. There is no privileged/least-privilege
// split.
//
// MIGRATION_DATABASE_URL is kept as an escape hatch for environments that do
// separate the roles, but LEAVE IT UNSET here. Pointing it at the `postgres`
// superuser actively breaks things: the shared instance has no default
// privileges configured, so tables created by a superuser run would be owned by
// `postgres` and the runtime role would then fail 42501 on them. This is
// exactly how RentVault's `drizzle` bookkeeping schema ended up mis-owned and
// crash-looped its API for a day. If a fresh environment hits 42501 here, check
// schema ownership (`\dn+`) before reaching for a superuser connection string.
//
// Kept dependency-light (own pool, no env.ts import) so the compiled output
// runs under plain node with only prod deps and without requiring the full
// runtime env (JWT/R2/encryption key) just to migrate.
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("MIGRATION_DATABASE_URL (preferred) or DATABASE_URL is required to run migrations");
}

const pool = new Pool({ connectionString });
const db = drizzle(pool);

await migrate(db, { migrationsFolder: "./drizzle" });
await pool.end();
console.log("Migrations applied.");
