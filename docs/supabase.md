# Supabase Setup for Dev Circle

This app now supports **Postgres** via `DATABASE_URL` — including **Supabase Postgres** — while keeping **SQLite** for local dev and tests. No code change is needed to switch; set `DATABASE_URL` and the app uses `pg` automatically.

## Architecture

| Mode | When | Driver | Storage for uploads |
|------|------|--------|---------------------|
| **SQLite** (default) | No `DATABASE_URL` | `better-sqlite3` | Local disk (`./data/uploads` or `DEVCIRCLE_UPLOAD_DIR`) |
| **Postgres** | `DATABASE_URL` set | `pg` Pool | Local disk *or* Supabase Storage (if Supabase keys set) |
| **Supabase** | `DATABASE_URL` + `SUPABASE_URL` | `pg` Pool + `@supabase/supabase-js` | Supabase Storage bucket `uploads` |

Tests always use SQLite (they inject `DEVCIRCLE_DB_PATH` to a temp file), so CI stays fast and hermetic.

## 1. Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) → New project.
2. Wait for provisioning (1–2 min).
3. In Dashboard → **Database** → **Connection string** → **URI** tab:
   - Copy the **pooled** string (port `6543`, `pgbouncer=true`) for the app.
   - Copy the **direct** string (port `5432`) for running migrations from your machine or CI.
4. In Dashboard → **Settings** → **API**: copy `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

## 2. Configure the App

Copy the Supabase env template:

```sh
cp .env.supabase.example .env
# fill in DATABASE_URL, SUPABASE_URL, etc.
```

Minimal required for Postgres:

```env
DATABASE_URL=postgres://postgres:PASSWORD@db.xxxxx.supabase.co:6543/postgres?pgbouncer=true
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...   # needed for Storage uploads
```

For plain Postgres (Render Postgres, Neon, local):

```env
DATABASE_URL=postgres://user:password@host:5432/devcircle?sslmode=require
# no Supabase vars needed — uploads stay on disk
```

## 3. Create the Schema

The app applies the schema on first boot, but you can also run it manually:

```sh
# With DATABASE_URL in env
npm run migrate          # applies pending migrations (no-op for fresh Postgres — schema is comprehensive)
npm run migrate:status   # shows applied / pending
```

For Supabase you can also paste `src/db/schema.postgres.js` (`SCHEMA_POSTGRES`) into the **SQL Editor** — it is idempotent (`IF NOT EXISTS`).

## 4. Storage Bucket (if using Supabase Storage)

1. Dashboard → **Storage** → New bucket → `uploads` (public, or private if you prefer).
2. Set bucket to **public** so `/uploads/:name` can be served via Supabase public URL, or keep it private and the app will fetch via the service role and stream it.
3. The app detects `SUPABASE_SERVICE_ROLE_KEY` and automatically uses Supabase Storage; set `UPLOAD_BACKEND=local` to force disk.

## 5. Deploy

### Render with Supabase

- **Runtime**: Node
- **Build**: `npm ci`
- **Start**: `npm start`
- **Env**: Set `DATABASE_URL` (pooled 6543), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEV_HUB_SSO_SECRET`, `BOOTSTRAP_API_KEY`, `APP_URL`, `CORS_ORIGINS`.
- Do **not** set `DEVCIRCLE_DB_PATH` — it is ignored when `DATABASE_URL` is present.

### Supabase Edge / Self-host

Any Node host works (Fly, Railway, self-hosted). Just provide `DATABASE_URL`.

## 6. Local Dev with Postgres

```sh
# Use the direct connection string for migrations
DATABASE_URL=postgres://postgres:password@db.xxxxx.supabase.co:5432/postgres npm run migrate:status
npm run dev
```

Or keep SQLite locally (no `DATABASE_URL`) and only set it in production — the codebase supports both.

## 7. Migrating Existing SQLite Data

To move data from a SQLite dump to Postgres:

```sh
# 1) Dump SQLite to SQL (or use the seed)
npm run seed   # recreates demo data in current DB

# 2) For a real migration, use pgloader or a small script:
#    sqlite3 data/devcircle.db .dump | pgloader ...

# Or use the app's seed to populate a fresh Postgres:
DATABASE_URL=postgres://... npm run seed
```

## 8. Monitoring

- **Health**: `GET /api/health` → `{ status: "ok", version, uptime }`. In Postgres mode it also pings the pool.
- **Config**: `GET /api/admin/credentials` (requires `credentials.read`) reports `database: postgres|sqlite` and `supabase: true/false`.

## 9. Troubleshooting

- `DATABASE_URL is not set — postgres pool unavailable`: you set Supabase keys but not `DATABASE_URL`. The DB still uses SQLite.
- `self signed certificate`: set `PGSSLMODE=require` implicitly does `rejectUnauthorized: false`. For local Postgres without SSL set `PGSSLMODE=disable`.
- `too many connections`: lower `PG_POOL_MAX` (default 10) — Supabase pgbouncer already pools.
- Uploads 404 after switch: create the `uploads` bucket in Supabase Storage, or set `UPLOAD_BACKEND=local`.

## Environment Reference

| Var | Required | Example |
|-----|----------|---------|
| `DATABASE_URL` / `POSTGRES_URL` | For Postgres | `postgres://...@db.supabase.co:6543/postgres?pgbouncer=true` |
| `SUPABASE_URL` | For Storage | `https://xxxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | For Storage | `eyJhb...` |
| `SUPABASE_SERVICE_ROLE_KEY` | For Storage writes | `eyJhb...` |
| `SUPABASE_STORAGE_BUCKET` | Optional | `uploads` (default) |
| `UPLOAD_BACKEND` | Optional | `auto` / `local` / `supabase` |
| `PG_POOL_MAX` | Optional | `10` |
| `PGSSLMODE` | Optional | `require` / `disable` |
| `DEVCIRCLE_SANDBOX_DATABASE_URL` | Optional | Separate DB for sandbox |
