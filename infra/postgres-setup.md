# Postgres — `advault` database on the shared instance

One shared Postgres (`3pandalabs-postgres` in Coolify) holds one database per
app, each owned by its own scoped role. This is what lets a fifth app cost €0 in
RAM rather than running a fifth Postgres container.

## ⚠️ There are two `postgres:17-alpine` containers on the box

Only one holds the app databases; the other has template databases only. Confirm
before running anything:

```bash
ssh root@167.233.223.241
docker ps --filter ancestor=postgres:17-alpine --format '{{.ID}}  {{.Names}}'

# For each candidate, check which one already has nrighar / receiptcash /
# evitevault. That is the right container.
docker exec -it <container-id> psql -U postgres -c '\l'
```

## Create the role and database

Generate the password first — do not reuse another app's:

```bash
openssl rand -base64 24
```

Then, in the correct container:

```bash
docker exec -it <container-id> psql -U postgres
```

```sql
CREATE ROLE advault_app LOGIN PASSWORD '<generated-password>';
CREATE DATABASE advault OWNER advault_app;
\connect advault
ALTER SCHEMA public OWNER TO advault_app;
```

**`ALTER SCHEMA public OWNER TO advault_app` is not optional.** Without it the
runtime role cannot create objects in its own database and every migration fails
with a 42501 permission error — the failure that crash-looped `nrighar-api` for
a day on 2026-07-24.

Verify:

```sql
\dn+
-- public should show Owner = advault_app
```

## Connection string

Coolify's internal network resolves the Postgres service by name, so the API and
renderer both use the internal host, not the box's public IP:

```
postgres://advault_app:<password>@<postgres-service-name>:5432/advault
```

Copy the service name from the existing `nrighar-api` env var rather than
guessing it — it is a Coolify-generated identifier.

## Record the password

Put it in Claude memory (`advault_db_password`), the same as every other app's.
It is not recoverable from the container.

## Do NOT set `MIGRATION_DATABASE_URL`

There is no privileged/least-privilege split here. `advault_app` owns its own
database and runs its own DDL. Pointing `MIGRATION_DATABASE_URL` at the
`postgres` superuser creates tables owned by `postgres` that the runtime role
then cannot read — the shared instance has no default privileges configured.
Leave it unset.

## Only the API container migrates

`api/Dockerfile` runs `node dist/db/migrate.js` before starting the server.
`api/Dockerfile.renderer` deliberately does not. Two containers migrating on the
same deploy race the `drizzle` bookkeeping table and the loser crash-loops.

## Backups

Configure the Coolify Postgres backup schedule to the `advault-backups` bucket
after [r2-setup.md](r2-setup.md) — the Backups tab only offers S3 storages that
have already been registered globally and validated.
