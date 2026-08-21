# Deployment

This app is prepared for Render using the database it was built around:
SQLite via `better-sqlite3`.

## Architecture

- Render runs one Node web service from `render.yaml`.
- A Render persistent disk is mounted at `/var/data`.
- The live SQLite database is stored at `/var/data/devcircle.db`.
- The API sandbox database is stored at `/var/data/devcircle-sandbox.db`.
- Uploaded survey and brand assets are stored at `/var/data/uploads`.

This avoids a database adapter rewrite and keeps data across deploys and
restarts. Keep the service at one instance while using SQLite on a single
persistent disk.

## Render Setup

1. Push this repo to GitHub, GitLab, or Bitbucket.
2. In Render, choose **New > Blueprint** and connect the repo.
3. Use the root `render.yaml` file.
4. Fill the prompted `sync: false` values:
   - `APP_URL`: start with `https://<service>.onrender.com`, then replace with
     your custom domain when DNS is ready.
   - `CORS_ORIGINS`: the same origin as `APP_URL`; add more trusted origins as
     comma-separated values only when needed.
   - `CUSTOMERIO_SITE_ID` and `CUSTOMERIO_API_KEY` if real outbound messaging
     should be enabled.
   - `WHATSAPP_API_TOKEN` and `SMS_API_KEY` only if those direct providers are
     used.
5. Deploy the Blueprint.
6. Confirm the health endpoint:
   `https://<service>.onrender.com/api/health`.

Render will run:

```sh
npm ci
npm start
```

The database schema and pending migrations are applied during app startup.
Do not run `npm run migrate` as a Render pre-deploy command for this setup:
Render persistent disks are only available at runtime, not during build or
pre-deploy commands.

## Production Environment

The important production database paths are already set in `render.yaml`:

```sh
DEVCIRCLE_DB_PATH=/var/data/devcircle.db
DEVCIRCLE_SANDBOX_DB_PATH=/var/data/devcircle-sandbox.db
DEVCIRCLE_UPLOAD_DIR=/var/data/uploads
```

`NODE_ENV=production` is also set. In production, the server refuses to start
without required secrets, so keep `DEV_HUB_SSO_SECRET` and
`BOOTSTRAP_API_KEY` generated or manually supplied in Render.

## Operations

- Use the Render shell to inspect or back up `/var/data/devcircle.db`.
- Do not remove or resize the disk downward after production data exists.
- Do not scale this service above one instance while it uses SQLite.
- If you later move to Postgres, plan it as a separate adapter and data
  migration project.
