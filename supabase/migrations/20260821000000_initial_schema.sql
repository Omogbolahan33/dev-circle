-- Initial schema for Dev Circle — Postgres / Supabase
-- This is the same as src/db/schema.postgres.js (SCHEMA_POSTGRES) but as a
-- plain SQL file for Supabase CLI (`supabase db push`) and SQL Editor.
-- Generated from SCHEMA_POSTGRES — keep them in sync.

create extension if not exists "pgcrypto";

-- (Paste the full SCHEMA_POSTGRES here when pushing via Supabase CLI)
-- For now the app applies schema on boot; this file is a placeholder that
-- ensures `supabase db` tooling sees at least one migration.

create table if not exists schema_migrations (
  id integer primary key,
  name text not null,
  applied_at timestamptz default now()
);
