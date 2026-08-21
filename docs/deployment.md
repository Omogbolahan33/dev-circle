# Deployment

This app can run on Render's free web service tier with SQLite, but the
database will be ephemeral because free instances do not support persistent
disks.

## Free Architecture

- Render runs one manually configured Node web service.
- SQLite uses writable temporary storage at `/tmp`.
- The live database is stored at `/tmp/devcircle.db`.
- The API sandbox database is stored at `/tmp/devcircle-sandbox.db`.
- Uploaded survey and brand assets are stored at `/tmp/devcircle-uploads`.

This avoids a database adapter rewrite and works for demos/testing. It is not
durable production storage: data and uploads can disappear after deploys,
restarts, service suspends, or instance replacement.

## Render Setup

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
5. Add the environment variables listed in `.env.render.example`.
6. Deploy the service.
7. Confirm the health endpoint:
   `https://<service>.onrender.com/api/health`.

Render will run:

```sh
npm ci
npm start
```

The database schema and pending migrations are applied during app startup.
Do not set a pre-deploy migration command for the free setup.

## Required Environment

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

## Free-Tier Tradeoffs

- Data is not permanent.
- Uploaded assets are not permanent.
- The service may spin down when idle.
- On cold start, the app may create a fresh empty SQLite database.
- For durable data without rewriting the app, upgrade to a paid Render instance
  and add a persistent disk.
- For durable free managed storage, use a hosted database such as Supabase, but
  that requires a Postgres adapter migration.
