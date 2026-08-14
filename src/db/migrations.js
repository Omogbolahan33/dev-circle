const crypto = require('crypto');

// ─── Migrations ─────────────────────────────────────────────
// The base schema in db.js is created once on an empty database. Everything
// that came after ships here as a numbered, run-once migration, so an existing
// database is brought forward rather than needing to be rebuilt.
//
// Rules: a migration that has shipped is never edited — add a new one instead.
// Each runs inside a transaction, so a failure leaves nothing half-applied.

function makeHelpers(db) {
  return {
    // ALTER TABLE ADD COLUMN has no IF NOT EXISTS, so check first
    addColumn(table, column, definition) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      if (cols.some(c => c.name === column)) return;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };
}

function define(db) {
  const { addColumn } = makeHelpers(db);

  const migrations = [
    {
      id: 1,
      name: 'persistent_sessions',
      up() {
        db.exec(`
          CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            subject_id TEXT NOT NULL,
            is_admin INTEGER NOT NULL DEFAULT 0,
            issued_via TEXT DEFAULT 'password',
            user_agent TEXT,
            expires_at TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_sessions_subject ON sessions(subject_id);
          CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
        `);
      }
    },
    {
      id: 2,
      name: 'demography_and_products',
      up() {
        addColumn('users', 'date_of_birth', 'TEXT');
        addColumn('users', 'gender', 'TEXT');
        addColumn('users', 'location_state', 'TEXT');
        addColumn('users', 'country', "TEXT DEFAULT 'NG'");
        // API product families the developer integrates against, e.g. ["lending","payments"]
        addColumn('users', 'api_products', "TEXT DEFAULT '[]'");
        db.exec('CREATE INDEX IF NOT EXISTS idx_users_sector ON users(work_sector)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_users_state ON users(location_state)');
      }
    },
    {
      id: 3,
      name: 'notification_preferences',
      up() {
        addColumn('users', 'notification_prefs', "TEXT DEFAULT '{}'");
        addColumn('users', 'quiet_hours_start', "TEXT DEFAULT '22:00'");
        addColumn('users', 'quiet_hours_end', "TEXT DEFAULT '08:00'");
      }
    },
    {
      id: 4,
      name: 'notifications_and_deliveries',
      up() {
        db.exec(`
          -- In-portal inbox
          CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            category TEXT NOT NULL DEFAULT 'platform_updates',
            title TEXT NOT NULL,
            body TEXT,
            action_url TEXT,
            source_type TEXT,
            source_id TEXT,
            read_at TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
  
          -- One row per recipient per channel, for every outbound attempt
          CREATE TABLE IF NOT EXISTS message_deliveries (
            id TEXT PRIMARY KEY,
            source_type TEXT NOT NULL CHECK(source_type IN ('blast','survey_invite','survey_reminder','system')),
            source_id TEXT,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            channel TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued'
              CHECK(status IN ('queued','sent','simulated','skipped','failed')),
            reason TEXT,
            provider_ref TEXT,
            sent_at TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_deliveries_source ON message_deliveries(source_type, source_id);
          CREATE INDEX IF NOT EXISTS idx_deliveries_user ON message_deliveries(user_id);
        `);
      }
    },
    {
      id: 5,
      name: 'widen_engagement_types',
      up() {
        // SQLite cannot alter a CHECK constraint in place, so rebuild the table
        // with the expanded vocabulary and copy the existing history across.
        // No table references engagement_history, so the drop-and-rename is safe
        // with foreign keys left on.
        db.exec(`
          CREATE TABLE engagement_history_new (
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
            created_at TEXT DEFAULT (datetime('now'))
          );
  
          INSERT INTO engagement_history_new (id, user_id, type, reference_id, metadata, source, created_at)
            SELECT id, user_id, type, reference_id, metadata, source, created_at FROM engagement_history;
  
          DROP TABLE engagement_history;
          ALTER TABLE engagement_history_new RENAME TO engagement_history;
  
          CREATE INDEX IF NOT EXISTS idx_engagement_user ON engagement_history(user_id);
          CREATE INDEX IF NOT EXISTS idx_engagement_type ON engagement_history(type);
          CREATE INDEX IF NOT EXISTS idx_engagement_created ON engagement_history(created_at);
        `);
      }
    },
    {
      id: 6,
      name: 'cohort_auto_sync',
      up() {
        addColumn('cohorts', 'auto_sync', 'INTEGER DEFAULT 0');
        addColumn('cohorts', 'last_synced_at', 'TEXT');
      }
    },
    {
      id: 7,
      name: 'gift_eligibility',
      up() {
        addColumn('gifts', 'stock', 'INTEGER');
        addColumn('gifts', 'min_surveys_completed', 'INTEGER DEFAULT 0');
        addColumn('gifts', 'min_streak', 'INTEGER DEFAULT 0');
        addColumn('gifts', 'active', 'INTEGER DEFAULT 1');
        db.exec('CREATE INDEX IF NOT EXISTS idx_user_gifts_user ON user_gifts(user_id)');
        // A gift can only be claimed once per member
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_gifts_unique ON user_gifts(user_id, gift_id)');
      }
    },
    {
      id: 8,
      name: 'api_key_management',
      up() {
        addColumn('api_keys', 'prefix', 'TEXT');
        addColumn('api_keys', 'revoked_at', 'TEXT');
        addColumn('api_keys', 'created_by', 'TEXT');
      }
    },
    {
      id: 9,
      name: 'blast_scheduling',
      up() {
        addColumn('message_blasts', 'scheduled_for', 'TEXT');
        addColumn('message_blasts', 'recipient_count', 'INTEGER DEFAULT 0');
        addColumn('message_blasts', 'skipped_count', 'INTEGER DEFAULT 0');
      }
    },
    {
      id: 10,
      name: 'streak_tracking',
      up() {
        addColumn('users', 'last_engagement_at', 'TEXT');
      }
    },
    {
      id: 11,
      name: 'survey_triggers',
      up() {
        // Replaces the hardcoded event→survey map with a per-survey trigger,
        // so operators can wire a survey to a Developer Hub event themselves.
        addColumn('surveys', 'trigger_event', 'TEXT');
        addColumn('surveys', 'reminder_after_days', 'INTEGER');
        db.exec('CREATE INDEX IF NOT EXISTS idx_surveys_trigger ON surveys(trigger_event)');
      }
    },
    {
      id: 12,
      name: 'circles',
      up() {
        // "Be able to create other Circles/group similar to the dev circle as
        // sub circles." A circle is a whole engagement space with its own
        // members, cohorts, surveys and messaging — not a segment within one.
        db.exec(`
          CREATE TABLE IF NOT EXISTS circles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT UNIQUE NOT NULL,
            description TEXT,
            color TEXT DEFAULT '#107EBC',
            parent_id TEXT REFERENCES circles(id) ON DELETE CASCADE,
            is_root INTEGER DEFAULT 0,
            status TEXT DEFAULT 'active' CHECK(status IN ('active','archived')),
            created_by TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          );
  
          CREATE TABLE IF NOT EXISTS circle_members (
            circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role TEXT DEFAULT 'member' CHECK(role IN ('member','lead')),
            added_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (circle_id, user_id)
          );
          CREATE INDEX IF NOT EXISTS idx_circle_members_user ON circle_members(user_id);
        `);
  
        // Work scoped to a circle. NULL means the root circle, which keeps
        // every existing cohort, survey, blast, and gift working untouched.
        addColumn('cohorts', 'circle_id', 'TEXT');
        addColumn('surveys', 'circle_id', 'TEXT');
        addColumn('message_blasts', 'circle_id', 'TEXT');
        addColumn('gifts', 'circle_id', 'TEXT');
  
        // The original Dev Circle becomes the root, holding everyone already here
        const rootId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO circles (id, name, slug, description, color, is_root)
          VALUES (?, 'Dev Circle', 'dev-circle', 'The Credit Direct developer community', '#107EBC', 1)
        `).run(rootId);
  
        db.prepare(`
          INSERT OR IGNORE INTO circle_members (circle_id, user_id)
          SELECT ?, id FROM users
        `).run(rootId);
  
        for (const table of ['cohorts', 'surveys', 'message_blasts', 'gifts']) {
          db.prepare(`UPDATE ${table} SET circle_id = ? WHERE circle_id IS NULL`).run(rootId);
        }
      }
    },
    {
      id: 13,
      name: 'scheduled_sessions',
      up() {
        // "Receive communications for upcoming scheduled info/Test" and
        // "Send engagement communications and reminders" — a session is a dated
        // engagement with automated lead-up reminders.
        db.exec(`
          CREATE TABLE IF NOT EXISTS scheduled_sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT,
            type TEXT NOT NULL DEFAULT 'info'
              CHECK(type IN ('survey','info','test','1-on-1','workshop')),
            survey_id TEXT REFERENCES surveys(id) ON DELETE SET NULL,
            circle_id TEXT,
            target_type TEXT NOT NULL DEFAULT 'all' CHECK(target_type IN ('all','cohort','specific','circle')),
            target_ids TEXT DEFAULT '[]',
            scheduled_for TEXT NOT NULL,
            duration_min INTEGER DEFAULT 30,
            location TEXT,
            channels TEXT DEFAULT '["in_portal","email"]',
            -- Minutes before the session at which to send each reminder
            reminder_offsets TEXT DEFAULT '[1440,60]',
            status TEXT DEFAULT 'scheduled'
              CHECK(status IN ('draft','scheduled','announced','completed','cancelled')),
            created_by TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_sessions_when ON scheduled_sessions(scheduled_for, status);
  
          -- One row per reminder actually dispatched, so a restart or an extra
          -- scheduler tick cannot double-send.
          CREATE TABLE IF NOT EXISTS session_dispatches (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES scheduled_sessions(id) ON DELETE CASCADE,
            offset_minutes INTEGER NOT NULL,
            recipient_count INTEGER DEFAULT 0,
            dispatched_at TEXT DEFAULT (datetime('now'))
          );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_session_dispatch_once
            ON session_dispatches(session_id, offset_minutes);
        `);
      }
    },
    {
      id: 14,
      name: 'widen_delivery_sources',
      up() {
        // Sessions and Feex pushes need their own delivery source types.
        db.exec(`
          CREATE TABLE message_deliveries_new (
            id TEXT PRIMARY KEY,
            source_type TEXT NOT NULL CHECK(source_type IN (
              'blast','survey_invite','survey_reminder',
              'session_invite','session_reminder','system'
            )),
            source_id TEXT,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            channel TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued'
              CHECK(status IN ('queued','sent','simulated','skipped','failed')),
            reason TEXT,
            provider_ref TEXT,
            sent_at TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          );
  
          INSERT INTO message_deliveries_new
            SELECT id, source_type, source_id, user_id, channel, status, reason,
                   provider_ref, sent_at, created_at
            FROM message_deliveries;
  
          DROP TABLE message_deliveries;
          ALTER TABLE message_deliveries_new RENAME TO message_deliveries;
  
          CREATE INDEX IF NOT EXISTS idx_deliveries_source ON message_deliveries(source_type, source_id);
          CREATE INDEX IF NOT EXISTS idx_deliveries_user ON message_deliveries(user_id);
        `);
      }
    },
    {
      id: 15,
      name: 'feex_ticket_mirror',
      up() {
        // Feex owns its tickets end to end. Dev Circle mirrors their state
        // purely for engagement visibility — it never writes back and never
        // resolves anything.
        addColumn('feedback', 'feex_status', 'TEXT');
        addColumn('feedback', 'feex_priority', 'TEXT');
        addColumn('feedback', 'feex_url', 'TEXT');
        addColumn('feedback', 'feex_updated_at', 'TEXT');
        db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_ticket ON feedback(external_ticket_id)');
      }
    },
    {
      id: 16,
      name: 'passwordless_participant_login',
      up() {
        // One sign-in field for everyone. Participants prove who they are with
        // a one-time code sent to the email or phone they registered with, so
        // they never hold a password; staff keep theirs.
        db.exec(`
          CREATE TABLE IF NOT EXISTS login_codes (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            -- The normalised email or E.164 phone the code was sent to, so a
            -- code issued to one channel cannot be redeemed from another
            identifier TEXT NOT NULL,
            channel TEXT NOT NULL CHECK(channel IN ('email','sms')),
            -- Only the hash is stored: a database leak must not hand over live
            -- sign-in codes, exactly as with session tokens
            code_hash TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            expires_at TEXT NOT NULL,
            consumed_at TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_login_codes_identifier ON login_codes(identifier, created_at);
          CREATE INDEX IF NOT EXISTS idx_login_codes_user ON login_codes(user_id);
        `);

        // Members write their number however they habitually do — 0803…,
        // +234803…, with spaces. Matching a sign-in against that needs one
        // canonical form, kept beside the number the member actually typed.
        addColumn('users', 'phone_normalized', 'TEXT');
        db.exec('CREATE INDEX IF NOT EXISTS idx_users_phone_normalized ON users(phone_normalized)');

        const { normalizePhone } = require('../utils/identity');
        const update = db.prepare('UPDATE users SET phone_normalized = ? WHERE id = ?');
        for (const row of db.prepare('SELECT id, phone FROM users WHERE phone IS NOT NULL').all()) {
          update.run(normalizePhone(row.phone), row.id);
        }
      }
    }
  ];
  return migrations;
}

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function applied(db) {
  ensureTable(db);
  return db.prepare('SELECT id, name, applied_at FROM schema_migrations ORDER BY id').all();
}

// What has run, what has not, and whether anything has gone out of order
function status(db) {
  const all = define(db);
  const done = new Map(applied(db).map(r => [r.id, r]));

  return {
    applied: all.filter(m => done.has(m.id)).map(m => ({ ...done.get(m.id), name: m.name })),
    pending: all.filter(m => !done.has(m.id)).map(m => ({ id: m.id, name: m.name })),
    // A row with no matching definition means the database is ahead of the code
    unknown: [...done.values()].filter(r => !all.some(m => m.id === r.id))
  };
}

function run(db, { log = () => {} } = {}) {
  ensureTable(db);

  const all = define(db);
  const done = new Set(applied(db).map(r => r.id));
  const ran = [];

  for (const migration of all) {
    if (done.has(migration.id)) continue;

    // Each migration is atomic: either it lands with its ledger row, or neither
    db.transaction(() => {
      migration.up();
      db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)')
        .run(migration.id, migration.name);
    })();

    ran.push(migration);
    log(`migration ${migration.id}: ${migration.name}`);
  }

  return ran;
}

module.exports = { run, status, applied, define };
