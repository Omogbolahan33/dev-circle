# Deployment

This app supports two durable options and one ephemeral demo option:

- **Supabase Postgres** (recommended) — durable, managed, free tier available. Set `DATABASE_URL`.
- **Render Postgres** — durable, managed. Set `DATABASE_URL`.
- **SQLite on ephemeral disk** — demo only, data disappears on deploy/restart. Set `DEVCIRCLE_DB_PATH=/tmp/...`.

The app switches automatically: if `DATABASE_URL` is set it uses `pg` + Postgres; otherwise it uses `better-sqlite3` + SQLite.

## Option A — Supabase Postgres (Recommended)

Supabase gives you Postgres + Storage + a dashboard, and the app is ready for it out of the box (see `docs/supabase.md` for full guide).

1. Create a Supabase project at [supabase.com](https://supabase.com).
2. In Supabase Dashboard → **Database** → **Connection string** → copy the **pooled** URI (port `6543`, `pgbouncer=true`) for the app.
3. In Supabase Dashboard → **Settings** → **API** → copy `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (for Storage uploads).
4. In your host (Render / Fly / Railway / Supabase Edge), set:

```sh
DATABASE_URL=postgres://postgres:PASSWORD@db.xxxxx.supabase.co:6543/postgres?pgbouncer=true
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_STORAGE_BUCKET=uploads   # optional, default "uploads"
# PG_POOL_MAX=10                 # optional pool tuning
APP_URL=https://your-domain.com
CORS_ORIGINS=https://your-domain.com
NODE_ENV=production
DEV_HUB_SSO_SECRET=<strong random>
BOOTSTRAP_API_KEY=<strong random>
```

5. Create the Storage bucket if using Supabase Storage: Supabase Dashboard → **Storage** → New bucket → `uploads` (public).
6. Deploy. The schema is applied on first boot (`CREATE TABLE IF NOT EXISTS`). You can also paste `src/db/schema.postgres.js` (`SCHEMA_POSTGRES`) into Supabase SQL Editor.

No SQLite paths needed. See `docs/supabase.md` for migrations, local dev with Postgres, and troubleshooting.

## Option B — Render Postgres

1. In Render → **New** → **PostgreSQL** → create a database.
2. Copy its **External Database URL** (starts `postgres://`).
3. In your Render Web Service → **Environment**, set:

```sh
DATABASE_URL=<paste External Database URL>
APP_URL=https://<service>.onrender.com
CORS_ORIGINS=https://<service>.onrender.com
NODE_ENV=production
DEV_HUB_SSO_SECRET=<strong random>
BOOTSTRAP_API_KEY=<strong random>
```

4. Deploy. No disk needed.

## Option C — SQLite (Free Demo, Ephemeral)

This avoids a managed DB and works for demos/testing, but data and uploads can disappear after deploys, restarts, service suspends, or instance replacement.

- Render runs one Node web service.
- SQLite uses writable temporary storage at `/tmp`.
- The live database is stored at `/tmp/devcircle.db`.
- The API sandbox database is stored at `/tmp/devcircle-sandbox.db`.
- Uploaded assets are stored at `/tmp/devcircle-uploads`.

### Render Setup (SQLite)

1. Push this repo to GitHub, GitLab, or Bitbucket.
2. In Render, choose **New > Web Service** and connect the repo.
3. Use these service settings:
   - Runtime: `Node`
   - Build command: `npm ci`
   - Start command: `npm start`
   - Instance type: `Free`
   - Health check path: `/api/health`
   - Auto deploy: your preference
4. Do not add a disk.
5. Add the environment variables listed in `.env.render.example` (SQLite section).
6. Deploy the service.
7. Confirm the health endpoint: `https://<service>.onrender.com/api/health`.

Render will run:

```sh
npm ci
npm start
```

The database schema and pending migrations are applied during app startup. Do not set a pre-deploy migration command for the free setup.

### Required Environment (SQLite)

Set these database paths in Render:

```sh
DEVCIRCLE_DB_PATH=/tmp/devcircle.db
DEVCIRCLE_SANDBOX_DB_PATH=/tmp/devcircle-sandbox.db
DEVCIRCLE_UPLOAD_DIR=/tmp/devcircle-uploads
```

Also set:

```sh
NODE_ENV=production
NODE_VERSION=24.18.0
APP_URL=https://<service>.onrender.com
CORS_ORIGINS=https://<service>.onrender.com
DEV_HUB_SSO_SECRET=<strong random value>
BOOTSTRAP_API_KEY=<strong random value>
```

### Free-Tier Tradeoffs (SQLite)

- Data is not permanent.
- Uploaded assets are not permanent.
- The service may spin down when idle.
- On cold start, the app may create a fresh empty SQLite database.
- For durable data, use **Option A (Supabase)** or **Option B (Render Postgres)** — the app already supports them via `DATABASE_URL`.

## Health Check

`GET /api/health` returns `{ status: "ok", version, uptime, database }` where `database` is `postgres` or `sqlite` and, in Postgres mode, verifies the pool is reachable.

## Switching Between Databases

| Env | Result |
|-----|--------|
| No `DATABASE_URL` | SQLite at `DEVCIRCLE_DB_PATH` (default `./data/devcircle.db`) |
| `DATABASE_URL` set | Postgres via `pg` Pool (Supabase, Render Postgres, Neon, local) |
| `DATABASE_URL` + `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Postgres + Supabase Storage for uploads |
| `UPLOAD_BACKEND=local` | Force disk even when Supabase is configured |
| `UPLOAD_BACKEND=supabase` | Force Supabase Storage (errors if not configured) |

Tests always use SQLite (they inject `DEVCIRCLE_DB_PATH` to a tmp file), so switching to Postgres never breaks CI.

## Environment Templates

- `.env.example` — full annotated template (SQLite + Postgres + Supabase).
- `.env.render.example` — Render checklist (both DB options).
- `.env.supabase.example` — Supabase-only template.

## Database Tooling

```sh
npm run migrate          # apply pending migrations (works for both adapters)
npm run migrate:status   # show applied / pending
npm run seed             # populate demo data (respects DATABASE_URL — seeds Postgres if set)
```
