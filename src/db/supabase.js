const config = require('../config');
const { logger } = require('../utils/logger');

// ─── Supabase client ────────────────────────────────────────
// Optional — only created when SUPABASE_URL + SUPABASE_ANON_KEY are set.
// Provides Storage (for brand assets) and a convenience wrapper for auth
// if the product later moves to Supabase Auth. The database itself connects
// via DATABASE_URL (pg Pool), not via PostgREST.

let supabase = null;
let supabaseAdmin = null;

function getSupabase() {
  if (supabase) return supabase;
  const { url, anonKey } = config.supabase;
  if (!url || !anonKey) return null;

  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    return supabase;
  } catch (err) {
    logger.warn('Supabase client init failed', { message: err.message });
    return null;
  }
}

function getSupabaseAdmin() {
  if (supabaseAdmin) return supabaseAdmin;
  const { url, serviceRoleKey } = config.supabase;
  if (!url || !serviceRoleKey) return null;

  try {
    const { createClient } = require('@supabase/supabase-js');
    supabaseAdmin = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    return supabaseAdmin;
  } catch (err) {
    logger.warn('Supabase admin client init failed', { message: err.message });
    return null;
  }
}

// ─── Storage helpers ────────────────────────────────────────
// Brand assets (logos, backgrounds, fonts) previously lived on local disk.
// With Supabase they live in a Storage bucket (default `uploads`).

async function uploadToSupabase(fileName, buffer, contentType) {
  const client = getSupabaseAdmin();
  if (!client) throw new Error('Supabase admin client not configured');

  const { data, error } = await client.storage
    .from(config.supabase.storageBucket)
    .upload(fileName, buffer, {
      contentType,
      upsert: false,
      cacheControl: '31536000'
    });

  if (error) throw error;
  // `data.path` is the object key inside the bucket. Callers must keep that
  // key — not the name they sent, and never `fullPath` (which prefixes the
  // bucket) — so a later download asks for the same object the dashboard shows.
  return data;
}

async function downloadFromSupabase(fileName) {
  const client = getSupabaseAdmin() || getSupabase();
  if (!client) throw new Error('Supabase client not configured');

  const { data, error } = await client.storage
    .from(config.supabase.storageBucket)
    .download(fileName);

  if (error) throw error;
  const buffer = Buffer.from(await data.arrayBuffer());
  return buffer;
}

async function getPublicUrl(fileName) {
  const client = getSupabase();
  if (!client) return null;

  const { data } = client.storage.from(config.supabase.storageBucket).getPublicUrl(fileName);
  return data?.publicUrl || null;
}

async function removeFromSupabase(fileName) {
  const client = getSupabaseAdmin();
  if (!client) throw new Error('Supabase admin client not configured');

  const { error } = await client.storage
    .from(config.supabase.storageBucket)
    .remove([fileName]);

  if (error) throw error;
}

function isConfigured() {
  return config.supabase.configured;
}

function isStorageConfigured() {
  return config.supabase.hasServiceRole;
}

module.exports = {
  getSupabase,
  getSupabaseAdmin,
  uploadToSupabase,
  downloadFromSupabase,
  getPublicUrl,
  removeFromSupabase,
  isConfigured,
  isStorageConfigured
};
