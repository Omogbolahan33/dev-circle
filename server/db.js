const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const config = require('./config');

const DB_PATH = config.dbPath;

// Ensure data directory exists
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ────────────────────────────────────────────────
db.exec(`
  -- Users
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    password_hash TEXT NOT NULL,
    company TEXT,
    work_sector TEXT,
    dev_hub_user_id TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive','suspended')),
    api_status TEXT DEFAULT 'sandbox' CHECK(api_status IN ('sandbox','production')),
    kyb_completed INTEGER DEFAULT 0,
    preferred_channels TEXT DEFAULT '[]',
    preferred_days TEXT DEFAULT '[]',
    preferred_time_start TEXT DEFAULT '10:00',
    preferred_time_end TEXT DEFAULT '14:00',
    engagement_streak INTEGER DEFAULT 0,
    best_streak INTEGER DEFAULT 0,
    last_active_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Cohorts
  CREATE TABLE IF NOT EXISTS cohorts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT DEFAULT 'custom' CHECK(type IN ('system','custom')),
    color TEXT DEFAULT '#6366F1',
    filter_rules TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- User-Cohort junction
  CREATE TABLE IF NOT EXISTS user_cohorts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cohort_id TEXT NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
    added_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, cohort_id)
  );

  -- Consent
  CREATE TABLE IF NOT EXISTS consent (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK(channel IN ('email','whatsapp','sms','calls','in_portal')),
    status TEXT DEFAULT 'pending' CHECK(status IN ('granted','withdrawn','pending')),
    granted_at TEXT,
    withdrawn_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Surveys
  CREATE TABLE IF NOT EXISTS surveys (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    questions TEXT NOT NULL DEFAULT '[]',
    status TEXT DEFAULT 'draft' CHECK(status IN ('draft','active','closed')),
    target_type TEXT DEFAULT 'all' CHECK(target_type IN ('all','cohort','specific')),
    target_ids TEXT DEFAULT '[]',
    engagement_mode TEXT DEFAULT 'in_portal' CHECK(engagement_mode IN ('1-on-1','email','whatsapp','in_portal')),
    time_estimate_min INTEGER DEFAULT 5,
    expires_at TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Survey Responses
  CREATE TABLE IF NOT EXISTS survey_responses (
    id TEXT PRIMARY KEY,
    survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    answers TEXT NOT NULL DEFAULT '{}',
    completed_at TEXT,
    triggered_by TEXT DEFAULT 'manual' CHECK(triggered_by IN ('manual','system','customer_io')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Engagement History
  CREATE TABLE IF NOT EXISTS engagement_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN (
      'survey_invited','survey_completed','survey_started',
      'gift_claimed','gift_delivered',
      'feedback_submitted','complaint_received',
      'account_created','api_key_generated',
      'first_sandbox_call','first_production_call',
      'kyb_completed','product_requested'
    )),
    reference_id TEXT,
    metadata TEXT DEFAULT '{}',
    source TEXT DEFAULT 'system' CHECK(source IN ('system','customer_io','feex','manual','dev_circle','landing_page')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Feedback
  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT DEFAULT 'self_initiated' CHECK(type IN ('self_initiated','system_triggered','feex_complaint')),
    content TEXT NOT NULL,
    category TEXT,
    rating INTEGER,
    status TEXT DEFAULT 'open' CHECK(status IN ('open','reviewed','resolved')),
    source TEXT DEFAULT 'dev_circle' CHECK(source IN ('dev_circle','feex','customer_io')),
    external_ticket_id TEXT,
    survey_id TEXT REFERENCES surveys(id),
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  -- Gifts
  CREATE TABLE IF NOT EXISTS gifts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    value REAL,
    currency TEXT DEFAULT 'NGN',
    status TEXT DEFAULT 'available' CHECK(status IN ('available','claimed','delivered')),
    target_cohort_ids TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- User Gifts
  CREATE TABLE IF NOT EXISTS user_gifts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gift_id TEXT NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
    claimed_at TEXT DEFAULT (datetime('now')),
    delivered_at TEXT
  );

  -- Message Blasts
  CREATE TABLE IF NOT EXISTS message_blasts (
    id TEXT PRIMARY KEY,
    subject TEXT,
    content TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('email','whatsapp','sms','in_portal','all')),
    target_type TEXT NOT NULL CHECK(target_type IN ('all','cohort','specific')),
    target_ids TEXT DEFAULT '[]',
    status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sending','sent','failed')),
    sent_by TEXT,
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Roles & Permissions
  CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    permissions TEXT NOT NULL DEFAULT '[]',
    is_system INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Admin Users
  CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role_id TEXT REFERENCES roles(id),
    status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- API Keys (for system integration)
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    permissions TEXT DEFAULT '[]',
    last_used_at TEXT,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Integration Events Log
  CREATE TABLE IF NOT EXISTS integration_events (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT,
    processed INTEGER DEFAULT 0,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
  CREATE INDEX IF NOT EXISTS idx_users_api_status ON users(api_status);
  CREATE INDEX IF NOT EXISTS idx_user_cohorts_user ON user_cohorts(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_cohorts_cohort ON user_cohorts(cohort_id);
  CREATE INDEX IF NOT EXISTS idx_consent_user ON consent(user_id);
  CREATE INDEX IF NOT EXISTS idx_survey_responses_survey ON survey_responses(survey_id);
  CREATE INDEX IF NOT EXISTS idx_survey_responses_user ON survey_responses(user_id);
  CREATE INDEX IF NOT EXISTS idx_engagement_user ON engagement_history(user_id);
  CREATE INDEX IF NOT EXISTS idx_engagement_type ON engagement_history(type);
  CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id);
  CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
  CREATE INDEX IF NOT EXISTS idx_integration_events_processed ON integration_events(processed);
`);

// Apply any migrations this database has not seen yet
const { logger } = require('./utils/logger');
require('./migrations').run(db, { log: msg => logger.info(msg) });

module.exports = db;
