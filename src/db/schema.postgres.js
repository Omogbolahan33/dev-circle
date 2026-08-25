// ─── Dev Circle — Postgres Schema (Supabase) ────────────────
// Comprehensive schema for Postgres / Supabase, equivalent to the SQLite
// base schema + all 26 migrations. Applied to an empty Postgres database
// when DATABASE_URL is set. Uses TIMESTAMPTZ, TEXT, JSON-friendly defaults,
// and NOW() instead of datetime('now').
//
// This is the *current* shape — migrations are not replayed on Postgres for
// fresh databases. Existing Postgres databases are brought forward via
// `src/db/migrations.postgres.js` (ALTERs) or by re-running this file with
// CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN IF NOT EXISTS.

const SCHEMA_POSTGRES = `
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";

  -- Users (base + migrations 2,3,10,16, etc.)
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    phone_normalized TEXT,
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
    last_active_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    date_of_birth TEXT,
    gender TEXT,
    location_state TEXT,
    country TEXT DEFAULT 'NG',
    api_products TEXT DEFAULT '[]',
    notification_prefs TEXT DEFAULT '{}',
    quiet_hours_start TEXT DEFAULT '22:00',
    quiet_hours_end TEXT DEFAULT '08:00',
    last_engagement_at TIMESTAMPTZ
  );

  -- Circles (workspaces) — peers, not nested (migration 23)
  CREATE TABLE IF NOT EXISTS circles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    color TEXT DEFAULT '#107EBC',
    status TEXT DEFAULT 'active' CHECK(status IN ('active','archived')),
    created_by TEXT,
    survey_theme TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS circle_members (
    circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'member' CHECK(role IN ('member','lead')),
    added_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (circle_id, user_id)
  );

  -- Roles & admin users must exist before circle_admins can reference them
  CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    permissions TEXT NOT NULL DEFAULT '[]',
    is_system INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role_id TEXT REFERENCES roles(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive')),
    is_global INTEGER DEFAULT 0,
    must_change_password INTEGER DEFAULT 0,
    invited_by TEXT,
    invited_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS circle_admins (
    circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    admin_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    role_id TEXT REFERENCES roles(id),
    added_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (circle_id, admin_id)
  );

  -- Cohorts
  CREATE TABLE IF NOT EXISTS cohorts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT DEFAULT 'custom' CHECK(type IN ('system','custom')),
    color TEXT DEFAULT '#6366F1',
    filter_rules TEXT,
    circle_id TEXT REFERENCES circles(id) ON DELETE SET NULL,
    auto_sync INTEGER DEFAULT 0,
    last_synced_at TIMESTAMPTZ,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS user_cohorts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cohort_id TEXT NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, cohort_id)
  );

  -- Consent
  CREATE TABLE IF NOT EXISTS consent (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK(channel IN ('email','whatsapp','sms','calls','in_portal')),
    status TEXT DEFAULT 'pending' CHECK(status IN ('granted','withdrawn','pending')),
    granted_at TIMESTAMPTZ,
    withdrawn_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  -- Surveys (with anonymous support - migration 25)
  CREATE TABLE IF NOT EXISTS surveys (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    questions TEXT NOT NULL DEFAULT '[]',
    theme TEXT,
    status TEXT DEFAULT 'draft' CHECK(status IN ('draft','active','closed')),
    target_type TEXT DEFAULT 'all' CHECK(target_type IN ('all','cohort','specific','anonymous')),
    target_ids TEXT DEFAULT '[]',
    engagement_mode TEXT DEFAULT 'in_portal' CHECK(engagement_mode IN ('1-on-1','email','whatsapp','in_portal')),
    time_estimate_min INTEGER DEFAULT 5,
    trigger_event TEXT,
    reminder_after_days INTEGER,
    circle_id TEXT REFERENCES circles(id) ON DELETE SET NULL,
    public_token TEXT UNIQUE,
    expires_at TIMESTAMPTZ,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  -- Survey Responses (with anonymous + import support)
  CREATE TABLE IF NOT EXISTS survey_responses (
    id TEXT PRIMARY KEY,
    survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    answers TEXT NOT NULL DEFAULT '{}',
    completed_at TIMESTAMPTZ,
    triggered_by TEXT DEFAULT 'manual' CHECK(triggered_by IN ('manual','system','customer_io','link','import')),
    respondent_kind TEXT DEFAULT 'member',
    anonymous_key_hash TEXT,
    source_system TEXT,
    external_response_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  -- Questions (canonical)
  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    normalized TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    circle_id TEXT REFERENCES circles(id) ON DELETE SET NULL,
    external_source TEXT,
    external_ref TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  -- Engagement History (expanded vocabulary)
  CREATE TABLE IF NOT EXISTS engagement_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN (
      'survey_invited','survey_completed','survey_started','survey_reminded',
      'gift_claimed','gift_delivered','gift_awarded',
      'feedback_submitted','complaint_received','complaint_resolved',
      'account_created','api_key_generated',
      'first_sandbox_call','first_production_call',
      'kyb_completed','product_requested',
      'message_sent','message_read',
      'consent_granted','consent_withdrawn'
    )),
    reference_id TEXT,
    metadata TEXT DEFAULT '{}',
    source TEXT DEFAULT 'system' CHECK(source IN ('system','customer_io','feex','manual','dev_circle','landing_page')),
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  -- Feedback (with all verbatim / Feex / external fields)
  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    type TEXT DEFAULT 'self_initiated' CHECK(type IN ('self_initiated','system_triggered','feex_complaint','survey_response')),
    content TEXT NOT NULL,
    category TEXT,
    rating INTEGER,
    status TEXT DEFAULT 'open' CHECK(status IN ('open','reviewed','resolved')),
    source TEXT DEFAULT 'dev_circle' CHECK(source IN ('dev_circle','feex','customer_io','survey','external_survey')),
    source_system TEXT,
    external_ticket_id TEXT,
    external_response_id TEXT,
    survey_id TEXT REFERENCES surveys(id) ON DELETE SET NULL,
    question_id TEXT,
    canonical_question_id TEXT REFERENCES questions(id) ON DELETE SET NULL,
    prompt TEXT,
    circle_id TEXT REFERENCES circles(id) ON DELETE SET NULL,
    response_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    feex_status TEXT,
    feex_priority TEXT,
    feex_url TEXT,
    feex_updated_at TIMESTAMPTZ
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
    circle_id TEXT REFERENCES circles(id) ON DELETE SET NULL,
    stock INTEGER,
    min_surveys_completed INTEGER DEFAULT 0,
    min_streak INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS user_gifts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gift_id TEXT NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
    claimed_at TIMESTAMPTZ DEFAULT NOW(),
    delivered_at TIMESTAMPTZ
  );

  -- Message Blasts
  CREATE TABLE IF NOT EXISTS message_blasts (
    id TEXT PRIMARY KEY,
    subject TEXT,
    content TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('email','whatsapp','sms','in_portal','all')),
    target_type TEXT NOT NULL CHECK(target_type IN ('all','cohort','specific')),
    target_ids TEXT DEFAULT '[]',
    circle_id TEXT REFERENCES circles(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sending','sent','failed')),
    scheduled_for TIMESTAMPTZ,
    recipient_count INTEGER DEFAULT 0,
    skipped_count INTEGER DEFAULT 0,
    sent_by TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  -- Notifications (in-portal inbox)
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL DEFAULT 'platform_updates',
    title TEXT NOT NULL,
    body TEXT,
    action_url TEXT,
    source_type TEXT,
    source_id TEXT,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS message_deliveries (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL CHECK(source_type IN ('blast','survey_invite','survey_reminder','session_invite','session_reminder','system')),
    source_id TEXT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','simulated','skipped','failed')),
    reason TEXT,
    provider_ref TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  -- Scheduled Sessions
  CREATE TABLE IF NOT EXISTS scheduled_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL DEFAULT 'info' CHECK(type IN ('survey','info','test','1-on-1','workshop')),
    survey_id TEXT REFERENCES surveys(id) ON DELETE SET NULL,
    circle_id TEXT REFERENCES circles(id) ON DELETE SET NULL,
    target_type TEXT NOT NULL DEFAULT 'all' CHECK(target_type IN ('all','cohort','specific','circle')),
    target_ids TEXT DEFAULT '[]',
    scheduled_for TIMESTAMPTZ NOT NULL,
    duration_min INTEGER DEFAULT 30,
    location TEXT,
    channels TEXT DEFAULT '["in_portal","email"]',
    reminder_offsets TEXT DEFAULT '[1440,60]',
    status TEXT DEFAULT 'scheduled' CHECK(status IN ('draft','scheduled','announced','completed','cancelled')),
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS session_dispatches (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES scheduled_sessions(id) ON DELETE CASCADE,
    offset_minutes INTEGER NOT NULL,
    recipient_count INTEGER DEFAULT 0,
    dispatched_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (session_id, offset_minutes)
  );

  -- Sessions (auth)
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    issued_via TEXT DEFAULT 'password',
    user_agent TEXT,
    scope TEXT DEFAULT 'full',
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  -- Login Codes (passwordless)
  CREATE TABLE IF NOT EXISTS login_codes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    identifier TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('email','sms')),
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  -- API Keys
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    prefix TEXT,
    permissions TEXT DEFAULT '[]',
    revoked_at TIMESTAMPTZ,
    created_by TEXT,
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  -- Integration Events
  CREATE TABLE IF NOT EXISTS integration_events (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT,
    processed INTEGER DEFAULT 0,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  -- Schema migrations ledger
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT NOW()
  );

  -- Sandbox meta (used by sandbox.js)
  CREATE TABLE IF NOT EXISTS sandbox_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
  CREATE INDEX IF NOT EXISTS idx_users_api_status ON users(api_status);
  CREATE INDEX IF NOT EXISTS idx_users_phone_normalized ON users(phone_normalized);
  CREATE INDEX IF NOT EXISTS idx_users_sector ON users(work_sector);
  CREATE INDEX IF NOT EXISTS idx_users_state ON users(location_state);
  CREATE INDEX IF NOT EXISTS idx_user_cohorts_user ON user_cohorts(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_cohorts_cohort ON user_cohorts(cohort_id);
  CREATE INDEX IF NOT EXISTS idx_consent_user ON consent(user_id);
  CREATE INDEX IF NOT EXISTS idx_circles_slug ON circles(slug);
  CREATE INDEX IF NOT EXISTS idx_circles_status_created ON circles(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_circle_members_user ON circle_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_circle_admins_admin ON circle_admins(admin_id);
  CREATE INDEX IF NOT EXISTS idx_surveys_trigger ON surveys(trigger_event);
  CREATE INDEX IF NOT EXISTS idx_surveys_public_token ON surveys(public_token) WHERE public_token IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_survey_responses_survey ON survey_responses(survey_id);
  CREATE INDEX IF NOT EXISTS idx_survey_responses_user ON survey_responses(user_id);
  CREATE INDEX IF NOT EXISTS idx_survey_responses_anon ON survey_responses(anonymous_key_hash) WHERE anonymous_key_hash IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_survey_responses_external ON survey_responses(survey_id, external_response_id) WHERE external_response_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_questions_normalized ON questions(normalized, type);
  CREATE INDEX IF NOT EXISTS idx_questions_external ON questions(external_source, external_ref);
  CREATE INDEX IF NOT EXISTS idx_questions_circle ON questions(circle_id);
  CREATE INDEX IF NOT EXISTS idx_engagement_user ON engagement_history(user_id);
  CREATE INDEX IF NOT EXISTS idx_engagement_type ON engagement_history(type);
  CREATE INDEX IF NOT EXISTS idx_engagement_created ON engagement_history(created_at);
  CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id);
  CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
  CREATE INDEX IF NOT EXISTS idx_feedback_source ON feedback(source);
  CREATE INDEX IF NOT EXISTS idx_feedback_ticket ON feedback(external_ticket_id);
  CREATE INDEX IF NOT EXISTS idx_feedback_question ON feedback(canonical_question_id);
  CREATE INDEX IF NOT EXISTS idx_feedback_circle ON feedback(circle_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
  CREATE INDEX IF NOT EXISTS idx_deliveries_source ON message_deliveries(source_type, source_id);
  CREATE INDEX IF NOT EXISTS idx_deliveries_user ON message_deliveries(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_when ON scheduled_sessions(scheduled_for, status);
  CREATE INDEX IF NOT EXISTS idx_sessions_subject ON sessions(subject_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_login_codes_identifier ON login_codes(identifier, created_at);
  CREATE INDEX IF NOT EXISTS idx_login_codes_user ON login_codes(user_id);
  CREATE INDEX IF NOT EXISTS idx_integration_events_processed ON integration_events(processed);
  CREATE INDEX IF NOT EXISTS idx_user_gifts_user ON user_gifts(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_user_gifts_unique ON user_gifts(user_id, gift_id);
  CREATE INDEX IF NOT EXISTS idx_user_gifts_gift ON user_gifts(gift_id);
  CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_survey_responses_user_completed ON survey_responses(user_id, completed_at);
  CREATE INDEX IF NOT EXISTS idx_survey_responses_survey_completed ON survey_responses(survey_id, completed_at);
  CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_feedback_circle_created ON feedback(circle_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_surveys_circle_created ON surveys(circle_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_cohorts_circle ON cohorts(circle_id);
  CREATE INDEX IF NOT EXISTS idx_admin_users_role ON admin_users(role_id);
  CREATE INDEX IF NOT EXISTS idx_gifts_circle ON gifts(circle_id);
  CREATE INDEX IF NOT EXISTS idx_blasts_circle ON message_blasts(circle_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_verbatim ON feedback(user_id, survey_id, question_id) WHERE question_id IS NOT NULL AND survey_id IS NOT NULL AND user_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_verbatim_anon ON feedback(response_id, question_id) WHERE response_id IS NOT NULL AND question_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_external_response ON feedback(source_system, external_response_id) WHERE external_response_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_session_dispatch_once ON session_dispatches(session_id, offset_minutes);
`;

module.exports = { SCHEMA_POSTGRES };
