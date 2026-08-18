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
    },
    {
      id: 17,
      name: 'staff_invites_and_forced_password_change',
      up() {
        // A staff account starts life with a password somebody else chose and
        // sent by email. It is a handover credential, not theirs, so it buys
        // exactly one thing: the chance to set a real one.
        addColumn('admin_users', 'must_change_password', 'INTEGER DEFAULT 0');
        addColumn('admin_users', 'invited_by', 'TEXT');
        addColumn('admin_users', 'invited_at', 'TEXT');

        // Signing in with a temporary password issues a session that can do
        // nothing but replace it. Without this the block would live only in
        // the browser, and typing /admin/dashboard.html would walk around it.
        addColumn('sessions', 'scope', "TEXT DEFAULT 'full'");
      }
    },
    {
      id: 18,
      name: 'api_reference_permission',
      up() {
        // 'docs.read' gates the API reference. It is new, so no role holds it
        // yet — and Super Admin is the role that is meant to. A role holding
        // '*' already has it by definition; this fills in a Super Admin whose
        // permissions were written out in full instead.
        const roles = db.prepare("SELECT id, permissions FROM roles WHERE name = 'Super Admin'").all();

        for (const role of roles) {
          let permissions;
          try { permissions = JSON.parse(role.permissions || '[]'); } catch { permissions = []; }
          if (!Array.isArray(permissions)) continue;
          if (permissions.includes('*') || permissions.includes('docs.read')) continue;

          db.prepare('UPDATE roles SET permissions = ? WHERE id = ?')
            .run(JSON.stringify([...permissions, 'docs.read']), role.id);
        }
      }
    },
    {
      id: 19,
      name: 'credentials_and_sandbox_permissions',
      up() {
        // Managing credentials used to ride on 'integrations.write', which also
        // meant the event log. Splitting them gives the new Credentials screen
        // its own gate — so this hands the new permissions to Super Admin, and
        // to anyone who could already manage keys, who would otherwise wake up
        // locked out of a job they were doing yesterday.
        const grants = [
          { to: role => role.name === 'Super Admin', keys: ['credentials.read', 'credentials.write', 'sandbox.use'] },
          { to: role => role.permissions.includes('integrations.write'), keys: ['credentials.read', 'credentials.write'] }
        ];

        const roles = db.prepare('SELECT id, name, permissions FROM roles').all().map(role => {
          let permissions;
          try { permissions = JSON.parse(role.permissions || '[]'); } catch { permissions = []; }
          return { ...role, permissions: Array.isArray(permissions) ? permissions : [] };
        });

        const update = db.prepare('UPDATE roles SET permissions = ? WHERE id = ?');

        for (const role of roles) {
          // A wildcard role already holds every permission, present and future
          if (role.permissions.includes('*')) continue;

          const wanted = grants.filter(g => g.to(role)).flatMap(g => g.keys);
          const missing = [...new Set(wanted)].filter(key => !role.permissions.includes(key));
          if (!missing.length) continue;

          update.run(JSON.stringify([...role.permissions, ...missing]), role.id);
        }
      }
    },
    {
      id: 20,
      name: 'survey_verbatims_as_feedback',
      up() {
        // What a developer writes in a survey's free-text box is feedback in
        // every sense except where it was stored: inside survey_responses.answers
        // as JSON keyed by question id, reachable only by opening that one
        // survey. It was the largest source of what developers tell us and the
        // only one you could not search, so "everything this developer has said"
        // meant reading three places.
        //
        // This widens feedback to hold them, and backfills the ones already
        // collected. Nothing is interpreted or grouped — they are simply filed
        // where the rest of the feedback lives, keyed to the member and stamped
        // with where they came from.

        db.exec(`
          CREATE TABLE feedback_new (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type TEXT DEFAULT 'self_initiated' CHECK(type IN (
              'self_initiated','system_triggered','feex_complaint','survey_response'
            )),
            content TEXT NOT NULL,
            category TEXT,
            rating INTEGER,
            status TEXT DEFAULT 'open' CHECK(status IN ('open','reviewed','resolved')),
            source TEXT DEFAULT 'dev_circle' CHECK(source IN (
              'dev_circle','feex','customer_io','survey'
            )),
            external_ticket_id TEXT,
            survey_id TEXT REFERENCES surveys(id),
            -- Which question drew this out, and what it asked. Without the
            -- prompt a verbatim like "about a week" means nothing on its own.
            question_id TEXT,
            prompt TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            resolved_at TEXT,
            feex_status TEXT,
            feex_priority TEXT,
            feex_url TEXT,
            feex_updated_at TEXT
          );

          INSERT INTO feedback_new (
            id, user_id, type, content, category, rating, status, source,
            external_ticket_id, survey_id, created_at, resolved_at,
            feex_status, feex_priority, feex_url, feex_updated_at
          )
          SELECT id, user_id, type, content, category, rating, status, source,
                 external_ticket_id, survey_id, created_at, resolved_at,
                 feex_status, feex_priority, feex_url, feex_updated_at
          FROM feedback;

          DROP TABLE feedback;
          ALTER TABLE feedback_new RENAME TO feedback;

          CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id);
          CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
          CREATE INDEX IF NOT EXISTS idx_feedback_source ON feedback(source);
          CREATE INDEX IF NOT EXISTS idx_feedback_ticket ON feedback(external_ticket_id);

          -- One row per member per question. Makes the backfill re-runnable and
          -- stops a resubmitted response filing the same sentence twice.
          CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_verbatim
            ON feedback(user_id, survey_id, question_id)
            WHERE question_id IS NOT NULL;
        `);

        // ─── Backfill ───────────────────────────────────────
        // Deliberately self-contained rather than calling the service that does
        // this at runtime: a migration has to keep behaving the way it did the
        // day it ran, and service code is free to change.

        const responses = db.prepare(`
          SELECT sr.id, sr.user_id, sr.survey_id, sr.answers, sr.completed_at,
                 s.questions, s.title
          FROM survey_responses sr
          JOIN surveys s ON s.id = sr.survey_id
          WHERE sr.completed_at IS NOT NULL
        `).all();

        const insert = db.prepare(`
          INSERT OR IGNORE INTO feedback (
            id, user_id, type, content, category, status, source,
            survey_id, question_id, prompt, created_at
          ) VALUES (?, ?, 'survey_response', ?, ?, 'open', 'survey', ?, ?, ?, ?)
        `);

        let filed = 0;

        for (const response of responses) {
          let answers, questions;
          try {
            answers = JSON.parse(response.answers || '{}');
            questions = JSON.parse(response.questions || '[]');
          } catch { continue; }

          for (const question of questions) {
            // Only free text is a verbatim. A rating or a picked option is a
            // measurement — it belongs in the survey's own results, and filing
            // it here would bury the sentences under the numbers.
            if (question.type !== 'text') continue;

            const answer = answers[question.id];
            if (typeof answer !== 'string' || !answer.trim()) continue;

            insert.run(
              crypto.randomUUID(), response.user_id, answer.trim(),
              response.title || null, response.survey_id, question.id,
              question.text || null, response.completed_at
            );
            filed++;
          }
        }

        if (filed) console.log(`  backfilled ${filed} survey verbatim(s) into feedback`);
      }
    },
    {
      id: 21,
      name: 'canonical_questions',
      up() {
        // A question was only ever an entry inside one survey's JSON, keyed
        // "q3". Ask the same thing in next quarter's survey and it became a
        // different "q3" with no relation to the first, so answers fragmented
        // instead of accumulating.
        //
        // This makes a question a thing in its own right that surveys point
        // at. Questions are not a fixed library: every discovery initiative
        // writes whatever it needs, and a question asked once is a perfectly
        // normal question. What the identity buys is that reusing one is
        // possible at all.
        db.exec(`
          CREATE TABLE IF NOT EXISTS questions (
            id TEXT PRIMARY KEY,
            text TEXT NOT NULL,
            -- Text with case, spacing and trailing punctuation flattened.
            -- Used to offer "you have asked this before" — never to decide it.
            normalized TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'text',
            created_by TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          );

          -- Deliberately not unique. Two initiatives may ask the same words
          -- about different things, and merging them silently would be
          -- unrecoverable: you cannot tell afterwards which answer came from
          -- which intent. Separate piles can be joined later; a merged pile
          -- cannot be taken apart.
          CREATE INDEX IF NOT EXISTS idx_questions_normalized
            ON questions(normalized, type);
        `);

        // Which question a filed answer belongs to. The existing question_id
        // stays: it points at the slot inside that one survey, which is how an
        // answer is traced back to the response it came from.
        addColumn('feedback', 'canonical_question_id', 'TEXT REFERENCES questions(id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_question ON feedback(canonical_question_id)');

        const normalize = text => String(text)
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .replace(/[?.!,;:\s]+$/, '')
          .trim();

        const addQuestion = db.prepare(
          'INSERT INTO questions (id, text, normalized, type) VALUES (?, ?, ?, ?)'
        );
        const updateSurvey = db.prepare('UPDATE surveys SET questions = ? WHERE id = ?');
        const stampFeedback = db.prepare(`
          UPDATE feedback SET canonical_question_id = ?
          WHERE survey_id = ? AND question_id = ?
        `);

        let created = 0;
        let linked = 0;

        for (const survey of db.prepare('SELECT id, questions FROM surveys').all()) {
          let questions;
          try { questions = JSON.parse(survey.questions || '[]'); } catch { continue; }
          if (!Array.isArray(questions)) continue;

          const rewritten = questions.map(question => {
            if (!question.text) return question;

            const normalized = normalize(question.text);
            if (!normalized) return question;

            // One question per survey question, faithfully. Folding two
            // surveys together here would be guessing that they meant the
            // same thing, and nobody asked for that.
            const id = crypto.randomUUID();
            addQuestion.run(id, question.text, normalized, question.type || 'text');
            created++;

            linked += stampFeedback.run(id, survey.id, question.id).changes;

            return { ...question, question_id: id };
          });

          updateSurvey.run(JSON.stringify(rewritten), survey.id);
        }

        if (created) {
          console.log(`  ${created} question(s) lifted out of surveys, ${linked} answer(s) linked`);
        }
      }
    },
    {
      id: 22,
      name: 'external_survey_responses',
      up() {
        // Surveys do not only run here. A discovery round may go out through
        // Customer.io, Google Forms, Microsoft Forms or anything else the team
        // already uses — and those answers are the same evidence. They have to
        // land against the developer who wrote them, under the question they
        // answered, next to everything else that developer has said.
        //
        // Two things follow. The vendor is recorded separately from the kind
        // of source, so a new tool never needs another migration. And a
        // question can belong to an external form, which is what stops two
        // unrelated forms that both asked "Any other feedback?" from being
        // read as one body of evidence.

        // Which system it came out of: 'google_forms', 'customer_io', …
        addColumn('feedback', 'source_system', 'TEXT');
        // The vendor's own id for the submission, so re-delivery is not a duplicate
        addColumn('feedback', 'external_response_id', 'TEXT');

        addColumn('questions', 'external_source', 'TEXT');
        addColumn('questions', 'external_ref', 'TEXT');

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_questions_external
            ON questions(external_source, external_ref);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_external_response
            ON feedback(source_system, external_response_id)
            WHERE external_response_id IS NOT NULL;
        `);

        // 'survey' meant "a survey run in Dev Circle". External answers are
        // the same kind of thing arriving another way, so they share the
        // source and are told apart by source_system.
        db.exec(`
          CREATE TABLE feedback_new (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type TEXT DEFAULT 'self_initiated' CHECK(type IN (
              'self_initiated','system_triggered','feex_complaint','survey_response'
            )),
            content TEXT NOT NULL,
            category TEXT,
            rating INTEGER,
            status TEXT DEFAULT 'open' CHECK(status IN ('open','reviewed','resolved')),
            source TEXT DEFAULT 'dev_circle' CHECK(source IN (
              'dev_circle','feex','customer_io','survey','external_survey'
            )),
            source_system TEXT,
            external_ticket_id TEXT,
            external_response_id TEXT,
            survey_id TEXT REFERENCES surveys(id),
            question_id TEXT,
            canonical_question_id TEXT REFERENCES questions(id),
            prompt TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            resolved_at TEXT,
            feex_status TEXT,
            feex_priority TEXT,
            feex_url TEXT,
            feex_updated_at TEXT
          );

          INSERT INTO feedback_new SELECT
            id, user_id, type, content, category, rating, status, source,
            source_system, external_ticket_id, external_response_id,
            survey_id, question_id, canonical_question_id, prompt,
            created_at, resolved_at, feex_status, feex_priority, feex_url, feex_updated_at
          FROM feedback;

          DROP TABLE feedback;
          ALTER TABLE feedback_new RENAME TO feedback;

          CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id);
          CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
          CREATE INDEX IF NOT EXISTS idx_feedback_source ON feedback(source);
          CREATE INDEX IF NOT EXISTS idx_feedback_ticket ON feedback(external_ticket_id);
          CREATE INDEX IF NOT EXISTS idx_feedback_question ON feedback(canonical_question_id);

          CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_verbatim
            ON feedback(user_id, survey_id, question_id)
            WHERE question_id IS NOT NULL AND survey_id IS NOT NULL;

          CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_external_response
            ON feedback(source_system, external_response_id)
            WHERE external_response_id IS NOT NULL;
        `);

        // Answers collected here keep saying so
        db.prepare("UPDATE feedback SET source_system = 'dev_circle' WHERE source = 'survey'").run();
      }
    },
    {
      id: 23,
      name: 'circles_are_workspaces',
      up() {
        // A circle is a workspace, and Dev Circle is one instance of it — not a
        // container the others live inside. This was built the other way up: a
        // root circle with everything nested beneath it, and membership of a
        // child constrained to its parent. That is segmentation, which is what
        // a cohort already is, and it made "Circles" read as a feature within
        // Dev Circle rather than as the thing Dev Circle is.
        //
        // Circles become peers. Each owns its members, cohorts, surveys,
        // sessions, questions and feedback, and nothing crosses between them.

        // The circles that were really segments become cohorts, keeping their
        // members. They were describing a slice of Dev Circle, not a separate
        // space, and the word was the only thing wrong with them.
        const nested = db.prepare('SELECT * FROM circles WHERE COALESCE(is_root, 0) = 0').all();
        const root = db.prepare('SELECT * FROM circles WHERE is_root = 1').get();

        if (root) {
          const makeCohort = db.prepare(`
            INSERT INTO cohorts (id, name, description, type, color, circle_id, created_by)
            VALUES (?, ?, ?, 'custom', ?, ?, ?)
          `);
          const moveMember = db.prepare(
            'INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)'
          );

          for (const circle of nested) {
            const cohortId = crypto.randomUUID();
            makeCohort.run(
              cohortId, circle.name, circle.description, circle.color, root.id, circle.created_by
            );

            for (const m of db.prepare('SELECT user_id FROM circle_members WHERE circle_id = ?').all(circle.id)) {
              moveMember.run(m.user_id, cohortId);
            }

            // Their work belongs to the workspace they were carved out of
            for (const table of ['cohorts', 'surveys', 'gifts', 'message_blasts', 'scheduled_sessions']) {
              db.prepare(`UPDATE ${table} SET circle_id = ? WHERE circle_id = ?`).run(root.id, circle.id);
            }
            db.prepare('DELETE FROM circle_members WHERE circle_id = ?').run(circle.id);
            db.prepare('DELETE FROM circles WHERE id = ?').run(circle.id);
          }
        }

        // Peers, not a tree
        db.exec(`
          CREATE TABLE circles_new (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT UNIQUE NOT NULL,
            description TEXT,
            color TEXT DEFAULT '#107EBC',
            status TEXT DEFAULT 'active' CHECK(status IN ('active','archived')),
            created_by TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          );

          INSERT INTO circles_new (id, name, slug, description, color, status, created_by, created_at)
            SELECT id, name, slug, description, color, status, created_by, created_at FROM circles;

          DROP TABLE circles;
          ALTER TABLE circles_new RENAME TO circles;
        `);

        // Which circle a thing was said in. Without it, a developer who belongs
        // to two workspaces would have what they said in one show up in the other.
        addColumn('feedback', 'circle_id', 'TEXT');
        addColumn('questions', 'circle_id', 'TEXT');
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_feedback_circle ON feedback(circle_id);
          CREATE INDEX IF NOT EXISTS idx_questions_circle ON questions(circle_id);
        `);

        const first = db.prepare('SELECT id FROM circles ORDER BY created_at LIMIT 1').get();
        if (first) {
          db.prepare('UPDATE feedback SET circle_id = ? WHERE circle_id IS NULL').run(first.id);
          db.prepare('UPDATE questions SET circle_id = ? WHERE circle_id IS NULL').run(first.id);
        }

        // Staff are granted a role *within* a circle. A rep for one workspace
        // has no business in another, and until now every admin could see
        // everything by construction.
        db.exec(`
          CREATE TABLE IF NOT EXISTS circle_admins (
            circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
            admin_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
            role_id TEXT REFERENCES roles(id),
            added_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (circle_id, admin_id)
          );
          CREATE INDEX IF NOT EXISTS idx_circle_admins_admin ON circle_admins(admin_id);
        `);

        // A tier above the circles: Credit Direct staff who create them and
        // move between. Without one, nobody could set up the second workspace.
        addColumn('admin_users', 'is_global', 'INTEGER DEFAULT 0');

        if (first) {
          // Everyone who could already administer keeps working, in the circle
          // that existed when they were granted it
          const grant = db.prepare(
            'INSERT OR IGNORE INTO circle_admins (circle_id, admin_id, role_id) VALUES (?, ?, ?)'
          );
          for (const admin of db.prepare('SELECT id, role_id FROM admin_users').all()) {
            grant.run(first.id, admin.id, admin.role_id);
          }

          // Whoever holds the wildcard role becomes the global tier, so the
          // ability to create a circle does not disappear with this migration
          db.prepare(`
            UPDATE admin_users SET is_global = 1
            WHERE role_id IN (SELECT id FROM roles WHERE permissions LIKE '%"*"%')
          `).run();
        }
      }
    },
    {
      id: 24,
      name: 'survey_questions_and_themes',
      up() {
        // A survey could ask three things: a 1–5 rating, one option out of a
        // list, or a paragraph. Everything else a discovery round actually
        // needs — a grid, a ranking, a date, a number, "pick up to three",
        // NPS — had to be faked as a choice question and then untangled by
        // hand afterwards.
        //
        // Worse, none of it was checked. A question could be stored with no
        // options at all, and an answer of "banana" to a 1–5 rating was
        // written to the database exactly as sent, because nothing on either
        // side of the wire had an opinion about what an answer was.
        //
        // Question types, branching, compulsory answers and option limits now
        // live in one definition that the builder, the member's page and this
        // server all read (public/assets/js/survey-schema.js). This migration
        // brings existing surveys into that shape.

        // How the survey looks to the member: accent, wordmark, opening and
        // closing, layout. Nullable — a survey without one follows its circle,
        // and a circle without one follows the product.
        addColumn('surveys', 'theme', 'TEXT');
        addColumn('circles', 'survey_theme', 'TEXT');

        const surveys = db.prepare('SELECT id, questions FROM surveys').all();
        const update = db.prepare('UPDATE surveys SET questions = ? WHERE id = ?');
        let rewritten = 0;

        for (const survey of surveys) {
          let questions;
          try { questions = JSON.parse(survey.questions || '[]'); } catch { continue; }
          if (!Array.isArray(questions) || !questions.length) continue;

          const next = questions.map(question => {
            const { optional, ...rest } = question;

            // "Answering is optional" was offered on text questions only, and
            // was never enforced anywhere — so it is the one place an author
            // said anything about compulsion, and the only place we can honour
            // it. Every other question becomes optional rather than required:
            // a live survey must not start rejecting members who are partway
            // through it because this shipped.
            const required = question.type === 'text' ? optional !== true : false;

            return { ...rest, required };
          });

          update.run(JSON.stringify(next), survey.id);
          rewritten++;
        }

        if (rewritten) console.log(`  ${rewritten} survey(s) carried into the new question schema`);
      }
    },
    {
      id: 25,
      name: 'anonymous_respondents',
      up() {
        // Every survey so far could only be answered by someone with an
        // account, because a response was keyed to a member and there was no
        // other kind of respondent. That rules out the discovery you most want
        // to do: asking developers who bounced off the sandbox before they
        // registered, or handing a link to a room at a meetup.
        //
        // So a survey can now be addressed to whoever holds its link. Three
        // tables have to admit a respondent who is not a member — and each of
        // them says "not a member" as NULL rather than as a placeholder user
        // row, because a fake member would be counted as a member by every
        // query that has ever been written against these tables.

        // Rebuilding a table means dropping it, and these are tables other
        // tables point at — so with foreign keys on, the drop fails the moment
        // there is real data to protect. Deferring moves that check to the
        // commit, by which point the table exists again under its own name
        // with every row in it. PRAGMA foreign_keys cannot be changed inside a
        // transaction, and each migration runs in one, so this is the form
        // that works here.
        db.pragma('defer_foreign_keys = ON');

        // Each rebuild starts from the table's own definition rather than from
        // one written out here. These tables have been added to by six earlier
        // migrations; a hand-copied column list would silently drop whatever
        // it forgot, and the loss would not show up until someone went looking
        // for data that had quietly stopped being written.
        function rebuild(table, edit) {
          const original = db.prepare(
            'SELECT sql FROM sqlite_master WHERE type = ? AND name = ?'
          ).get('table', table).sql;

          const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name).join(', ');
          const ddl = edit(original.replace(
            new RegExp(`CREATE TABLE\\s+"?${table}"?`, 'i'),
            `CREATE TABLE ${table}_new`
          ));

          db.exec(`
            ${ddl};
            INSERT INTO ${table}_new (${columns}) SELECT ${columns} FROM ${table};
            DROP TABLE ${table};
            ALTER TABLE ${table}_new RENAME TO ${table};
          `);
        }

        // ── surveys: a new audience, and the link that reaches it
        // target_type is a CHECK constraint, so admitting a value means
        // rebuilding the table.
        // The guards below fail loudly if a table is not shaped the way this
        // migration expects, rather than rebuilding it into something subtly
        // different. Finding the change already made is not a failure.
        rebuild('surveys', ddl => {
          if (/target_type[^)]*anonymous/i.test(ddl)) return ddl;
          const widened = ddl.replace(
            /CHECK\s*\(\s*target_type\s+IN\s*\([^)]*\)\s*\)/i,
            "CHECK(target_type IN ('all','cohort','specific','anonymous'))"
          );
          if (widened === ddl) throw new Error('surveys.target_type constraint not found');
          return widened;
        });

        // The link itself. Unguessable, because it is the only thing standing
        // between the survey and the open internet.
        addColumn('surveys', 'public_token', 'TEXT');
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_surveys_public_token
            ON surveys(public_token) WHERE public_token IS NOT NULL;
        `);

        // ── survey_responses: a response with no member behind it.
        // Nullable rather than pointed at a placeholder user: "how many
        // members answered" must not quietly start counting people who are
        // not members.
        rebuild('survey_responses', ddl => {
          const relaxed = /user_id\s+TEXT\s+NOT\s+NULL/i.test(ddl)
            ? ddl.replace(/user_id\s+TEXT\s+NOT\s+NULL\s+REFERENCES/i, 'user_id TEXT REFERENCES')
            : ddl;
          if (relaxed === ddl && /user_id\s+TEXT\s+NOT\s+NULL/i.test(ddl)) {
            throw new Error('survey_responses.user_id constraint not found');
          }
          return relaxed.replace(
            /triggered_by\s+TEXT\s+DEFAULT\s+'manual'\s+CHECK\s*\(\s*triggered_by\s+IN\s*\([^)]*\)\s*\)/i,
            "triggered_by TEXT DEFAULT 'manual' CHECK(triggered_by IN ('manual','system','customer_io','link'))"
          );
        });

        addColumn('survey_responses', 'respondent_kind', "TEXT DEFAULT 'member'");
        // Hashed, like every other bearer secret here. It lets one anonymous
        // respondent return to their own half-finished response and nobody
        // else's.
        addColumn('survey_responses', 'anonymous_key_hash', 'TEXT');
        db.prepare("UPDATE survey_responses SET respondent_kind = 'member' WHERE respondent_kind IS NULL").run();

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_survey_responses_survey ON survey_responses(survey_id);
          CREATE INDEX IF NOT EXISTS idx_survey_responses_user ON survey_responses(user_id);
          CREATE INDEX IF NOT EXISTS idx_survey_responses_anon
            ON survey_responses(anonymous_key_hash) WHERE anonymous_key_hash IS NOT NULL;
        `);

        // ── feedback: what an anonymous respondent wrote is still evidence.
        // Filed the way a member's words are, minus the member. Dropping it
        // instead would mean the answers from the audience you most need to
        // hear from are the ones that vanish.
        rebuild('feedback', ddl => {
          if (!/user_id\s+TEXT\s+NOT\s+NULL/i.test(ddl)) return ddl;
          const relaxed = ddl.replace(/user_id\s+TEXT\s+NOT\s+NULL\s+REFERENCES/i, 'user_id TEXT REFERENCES');
          if (relaxed === ddl) throw new Error('feedback.user_id constraint not found');
          return relaxed;
        });

        // Which response it came out of, so an anonymous answer can still be
        // traced back to the submission that carried it
        addColumn('feedback', 'response_id', 'TEXT');

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id);
          CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
          CREATE INDEX IF NOT EXISTS idx_feedback_question ON feedback(canonical_question_id);
          CREATE INDEX IF NOT EXISTS idx_feedback_circle ON feedback(circle_id);

          -- One answer per question per member per survey, as before
          CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_verbatim
            ON feedback(user_id, survey_id, question_id)
            WHERE question_id IS NOT NULL AND survey_id IS NOT NULL AND user_id IS NOT NULL;
          -- The same guard for someone with no account, keyed to the
          -- submission instead: a re-delivered response is not a second opinion.
          CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_verbatim_anon
            ON feedback(response_id, question_id)
            WHERE response_id IS NOT NULL AND question_id IS NOT NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_external_response
            ON feedback(source_system, external_response_id)
            WHERE external_response_id IS NOT NULL;
        `);
      }
    },
    {
      id: 26,
      name: 'imported_survey_responses',
      up() {
        // A survey does not always run here. A discovery round goes out on
        // paper at a meetup, through Google Forms, or inside a partner's own
        // tool, and comes back as a spreadsheet — and those answers are the
        // same evidence as the ones typed into this platform. Until now the
        // only way in was one verbatim at a time over the integrations API,
        // which files what somebody wrote but produces no response: the
        // ratings are lost, the summary screen stays empty, and the survey
        // reads as though nobody answered it.
        //
        // So a response can now arrive as an import. Three things have to be
        // recordable about one: that it was imported rather than submitted,
        // where it came from, and which submission it was over there.

        db.pragma('defer_foreign_keys = ON');

        // Starting from the table's own definition rather than a copy written
        // out here — the same reasoning as migration 25, and now with one more
        // migration's worth of columns that a hand-written list would drop.
        function rebuild(table, edit) {
          const original = db.prepare(
            'SELECT sql FROM sqlite_master WHERE type = ? AND name = ?'
          ).get('table', table).sql;

          const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name).join(', ');
          const ddl = edit(original.replace(
            new RegExp(`CREATE TABLE\\s+"?${table}"?`, 'i'),
            `CREATE TABLE ${table}_new`
          ));

          db.exec(`
            ${ddl};
            INSERT INTO ${table}_new (${columns}) SELECT ${columns} FROM ${table};
            DROP TABLE ${table};
            ALTER TABLE ${table}_new RENAME TO ${table};
          `);
        }

        // triggered_by is a CHECK constraint, so admitting a value means
        // rebuilding the table. Finding the change already made is not a
        // failure; finding the constraint absent is.
        rebuild('survey_responses', ddl => {
          if (/triggered_by[^)]*import/i.test(ddl)) return ddl;
          const widened = ddl.replace(
            /triggered_by\s+TEXT\s+DEFAULT\s+'manual'\s+CHECK\s*\(\s*triggered_by\s+IN\s*\([^)]*\)\s*\)/i,
            "triggered_by TEXT DEFAULT 'manual' CHECK(triggered_by IN ('manual','system','customer_io','link','import'))"
          );
          if (widened === ddl) throw new Error('survey_responses.triggered_by constraint not found');
          return widened;
        });

        // Which tool it was collected in: 'google_forms', 'paper', … Recorded
        // separately from the fact of the import, so a new tool never needs
        // another migration — the same split migration 22 made for feedback.
        addColumn('survey_responses', 'source_system', 'TEXT');
        // The other system's own id for the submission. What makes importing
        // the same export twice land nothing the second time, which matters
        // more here than anywhere else: an operator who is not sure whether
        // the first run went through will run it again.
        addColumn('survey_responses', 'external_response_id', 'TEXT');

        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_survey_responses_external
            ON survey_responses(survey_id, external_response_id)
            WHERE external_response_id IS NOT NULL;
        `);
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

  // SQLite cannot drop a NOT NULL or widen a CHECK in place, so those changes
  // are made by building the table again and renaming it into position. That
  // means dropping a table other tables point at, which foreign key
  // enforcement refuses outright — and deferring the check does not help,
  // because a dropped parent counts as a violation that reappearing under the
  // same name never clears. Turning enforcement off for the duration is the
  // procedure SQLite documents for exactly this.
  //
  // It is only safe because of the check afterwards: every migration is
  // followed by a full integrity scan, so a rebuild that stranded a row fails
  // here rather than months later at whatever query first noticed.
  const enforcing = db.pragma('foreign_keys', { simple: true });
  if (enforcing) db.pragma('foreign_keys = OFF');

  try {
  for (const migration of all) {
    if (done.has(migration.id)) continue;

    // Each migration is atomic: either it lands with its ledger row, or neither
    db.transaction(() => {
      migration.up();
      db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)')
        .run(migration.id, migration.name);
    })();

    const stranded = db.pragma('foreign_key_check');
    if (stranded.length) {
      throw new Error(
        `migration ${migration.id} (${migration.name}) left ${stranded.length} row(s) ` +
        `pointing at nothing: ${JSON.stringify(stranded.slice(0, 3))}`
      );
    }

    ran.push(migration);
    log(`migration ${migration.id}: ${migration.name}`);
  }
  } finally {
    // Restored whatever happened above, so a failed migration cannot leave the
    // connection running without referential integrity
    if (enforcing) db.pragma('foreign_keys = ON');
  }

  return ran;
}

module.exports = { run, status, applied, define };
