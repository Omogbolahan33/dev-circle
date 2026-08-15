const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const config = require('../config');
const { SCHEMA } = require('./schema');
const migrations = require('./migrations');
const { logger } = require('../utils/logger');

// ─── The API sandbox ────────────────────────────────────────
// A second database, identical in shape to the live one and filled with
// invented people, that a request can be routed to by asking for it. It exists
// so the API reference is something a developer can actually *use*: send the
// POST, send the DELETE, send the blast, and find out what comes back without
// having touched a real member or sent a real message.
//
// It is a real database rather than a mock, so behaviour is the behaviour —
// the same validation, the same permission gates, the same 409 when you claim
// a gift twice. Only two things differ, both deliberate: outbound messages are
// never dispatched to a provider, and the whole thing can be thrown away.

const DB_PATH = config.sandbox.dbPath;

let handle = null;

function open() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const database = new Database(DB_PATH);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.exec(SCHEMA);
  migrations.run(database, { log: msg => logger.info(`sandbox ${msg}`) });

  database.exec(`
    CREATE TABLE IF NOT EXISTS sandbox_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  return database;
}

// Fresh databases arrive empty; a sandbox with nothing in it answers every GET
// with an empty list, which teaches a developer nothing.
function db() {
  if (handle && handle.open) return handle;

  handle = open();
  if (!seeded(handle)) seed(handle);
  return handle;
}

function seeded(database) {
  return database.prepare('SELECT COUNT(*) as c FROM users').get().c > 0;
}

function meta(database, key, value) {
  if (value === undefined) {
    const row = database.prepare('SELECT value FROM sandbox_meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }
  database.prepare('INSERT OR REPLACE INTO sandbox_meta (key, value) VALUES (?, ?)').run(key, value);
  return value;
}

// ─── Demo data ──────────────────────────────────────────────
// Small enough to read in one sitting, varied enough that the interesting
// endpoints have something to say: members at both API stages, a cohort with
// live rules, an in-flight survey, a claimable reward, an open complaint.

const uuid = () => crypto.randomUUID();

function seed(database) {
  // Migrating a fresh database already creates the root circle, so the seed
  // adopts it rather than inserting a second one and colliding on the slug.
  const existingRoot = database.prepare('SELECT id FROM circles WHERE is_root = 1').get();
  const rootId = existingRoot ? existingRoot.id : uuid();
  const productionCohortId = uuid();
  const allCohortId = uuid();
  const surveyId = uuid();
  const giftId = uuid();

  // Quiet hours are off for everybody but the last member. A sandbox whose
  // behaviour depends on what time it is teaches the wrong lesson — send a
  // broadcast at eleven at night and every delivery would queue rather than go
  // — while one member keeping a window means the feature is still visible.
  const people = [
    { name: 'Chidi Nwosu', email: 'chidi@paystack.africa', company: 'Paystack', sector: 'Fintech', api: 'production', kyb: 1, streak: 4, state: 'Lagos', gender: 'male', dob: '1994-03-02', products: ['lending', 'payments'] },
    { name: 'Ada Eze', email: 'ada@flutterwave.com', company: 'Flutterwave', sector: 'Fintech', api: 'production', kyb: 1, streak: 7, state: 'Lagos', gender: 'female', dob: '1991-11-19', products: ['payments'] },
    { name: 'Tunde Salami', email: 'tunde@kuda.com', company: 'Kuda', sector: 'Banking', api: 'sandbox', kyb: 0, streak: 1, state: 'Lagos', gender: 'male', dob: '1997-06-30', products: ['lending'] },
    { name: 'Ngozi Okeke', email: 'ngozi@carbon.ng', company: 'Carbon', sector: 'Lending', api: 'sandbox', kyb: 0, streak: 0, state: 'Abuja', gender: 'female', dob: '1989-01-08', products: [] },
    { name: 'Segun Adeyemi', email: 'segun@moniepoint.com', company: 'Moniepoint', sector: 'Fintech', api: 'sandbox', kyb: 1, streak: 2, state: 'Ogun', gender: 'male', dob: '1993-09-14', products: ['collections'] },
    { name: 'Amaka Obi', email: 'amaka@stitch.money', company: 'Stitch', sector: 'Payments', api: 'sandbox', kyb: 0, streak: 0, state: 'Rivers', gender: 'female', dob: '1996-04-25', products: ['payments'], quiet: ['22:00', '08:00'] }
  ];

  database.transaction(() => {
    const SANDBOX_CIRCLE = ['Dev Circle (sandbox)', 'Invented data. Nothing here reaches a real person.'];

    if (existingRoot) {
      database.prepare('UPDATE circles SET name = ?, description = ? WHERE id = ?')
        .run(...SANDBOX_CIRCLE, rootId);
    } else {
      database.prepare(`
        INSERT INTO circles (id, name, slug, description, color, is_root)
        VALUES (?, ?, 'dev-circle', ?, '#107EBC', 1)
      `).run(rootId, ...SANDBOX_CIRCLE);
    }

    database.prepare(`
      INSERT INTO cohorts (id, name, description, type, color, circle_id)
      VALUES (?, 'All Members', 'Everyone in the sandbox', 'system', '#107EBC', ?)
    `).run(allCohortId, rootId);

    database.prepare(`
      INSERT INTO cohorts (id, name, description, type, color, filter_rules, auto_sync, circle_id)
      VALUES (?, 'Production integrators', 'Anyone who has made a live call', 'custom', '#0D9488', ?, 1, ?)
    `).run(
      productionCohortId,
      JSON.stringify({ match: 'all', conditions: [{ field: 'api_status', operator: 'eq', value: 'production' }] }),
      rootId
    );

    const insertUser = database.prepare(`
      INSERT INTO users (id, email, name, phone, phone_normalized, password_hash, company, work_sector,
                         api_status, kyb_completed, engagement_streak, best_streak,
                         preferred_channels, preferred_days, api_products,
                         gender, date_of_birth, location_state,
                         quiet_hours_start, quiet_hours_end, last_active_at)
      VALUES (?, ?, ?, ?, ?, '!', ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, ?, ?, datetime('now', '-2 days'))
    `);
    const joinCohort = database.prepare('INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)');
    const joinCircle = database.prepare('INSERT OR IGNORE INTO circle_members (circle_id, user_id) VALUES (?, ?)');
    const grantConsent = database.prepare(`
      INSERT INTO consent (id, user_id, channel, status, granted_at)
      VALUES (?, ?, ?, 'granted', datetime('now', '-30 days'))
    `);
    const logEvent = database.prepare(`
      INSERT INTO engagement_history (id, user_id, type, reference_id, metadata, source, created_at)
      VALUES (?, ?, ?, ?, '{}', ?, datetime('now', ?))
    `);

    const ids = [];

    people.forEach((person, index) => {
      const id = uuid();
      ids.push(id);

      insertUser.run(
        id, person.email, person.name,
        `080${index}5550${100 + index}`, `+23480${index}5550${100 + index}`,
        person.company, person.sector, person.api, person.kyb,
        person.streak, person.streak,
        JSON.stringify(person.products), person.gender, person.dob, person.state,
        // start === end means no quiet window at all
        ...(person.quiet || ['00:00', '00:00'])
      );

      joinCohort.run(id, allCohortId);
      if (person.api === 'production') joinCohort.run(id, productionCohortId);
      joinCircle.run(rootId, id);

      // Not everybody consents to everything — that is the whole point of the
      // reachability endpoints, so the sandbox has to show it.
      grantConsent.run(uuid(), id, 'email');
      if (index % 2 === 0) grantConsent.run(uuid(), id, 'whatsapp');

      logEvent.run(uuid(), id, 'account_created', null, 'landing_page', `-${60 - index * 3} days`);
      if (person.api === 'production') {
        logEvent.run(uuid(), id, 'first_production_call', null, 'customer_io', `-${20 - index} days`);
      } else {
        logEvent.run(uuid(), id, 'first_sandbox_call', null, 'customer_io', `-${25 - index} days`);
      }
    });

    // An active survey, half answered
    database.prepare(`
      INSERT INTO surveys (id, title, description, questions, status, target_type, target_ids,
                           engagement_mode, time_estimate_min, trigger_event, circle_id, created_at)
      VALUES (?, 'Sandbox onboarding experience', 'Five minutes on how your first integration went.',
              ?, 'active', 'all', '[]', 'email', 5, 'first_sandbox_call', ?, datetime('now', '-14 days'))
    `).run(surveyId, JSON.stringify([
      { id: 'q1_clarity', type: 'rating', text: 'How clear is our API documentation?', required: true },
      { id: 'q2_blocker', type: 'long_text', text: 'What slowed you down most?', required: false },
      { id: 'q3_product', type: 'single_choice', text: 'Which product did you start with?', options: ['Lending', 'Payments', 'Collections'] }
    ]), rootId);

    const insertResponse = database.prepare(`
      INSERT INTO survey_responses (id, survey_id, user_id, answers, completed_at, triggered_by, created_at)
      VALUES (?, ?, ?, ?, ?, 'manual', datetime('now', '-10 days'))
    `);

    insertResponse.run(uuid(), surveyId, ids[0],
      JSON.stringify({ q1_clarity: 4, q2_blocker: 'The callback signature was not documented for the sandbox.', q3_product: 'Lending' }),
      "2026-08-05 10:12:00");
    insertResponse.run(uuid(), surveyId, ids[1],
      JSON.stringify({ q1_clarity: 5, q3_product: 'Payments' }), "2026-08-06 14:40:00");
    insertResponse.run(uuid(), surveyId, ids[2], '{}', null);

    // A reward two of them qualify for
    database.prepare(`
      INSERT INTO gifts (id, name, description, value, currency, target_cohort_ids,
                         stock, min_surveys_completed, min_streak, active, circle_id)
      VALUES (?, '₦10,000 airtime', 'For members who complete a survey', 10000, 'NGN', '[]', 50, 1, 0, 1, ?)
    `).run(giftId, rootId);

    database.prepare('INSERT INTO user_gifts (id, user_id, gift_id) VALUES (?, ?, ?)')
      .run(uuid(), ids[1], giftId);

    // One piece of self-raised feedback and one complaint mirrored from Feex
    database.prepare(`
      INSERT INTO feedback (id, user_id, type, content, category, rating, status, source, created_at)
      VALUES (?, ?, 'self_initiated', 'The sandbox disbursement callback fires twice for a single request.',
              'sandbox', 3, 'open', 'dev_circle', datetime('now', '-3 days'))
    `).run(uuid(), ids[0]);

    database.prepare(`
      INSERT INTO feedback (id, user_id, type, content, category, status, source,
                            external_ticket_id, feex_status, feex_priority, feex_url, created_at)
      VALUES (?, ?, 'feex_complaint', 'Webhook retries are not backing off.', 'api', 'open', 'feex',
              'FEEX-10428', 'in_progress', 'high', 'https://feex.example/tickets/10428', datetime('now', '-5 days'))
    `).run(uuid(), ids[3]);

    // Something in the diary, so the session endpoints are not empty
    database.prepare(`
      INSERT INTO scheduled_sessions (id, title, description, type, circle_id, target_type, target_ids,
                                      scheduled_for, duration_min, location, channels, reminder_offsets, status)
      VALUES (?, 'Lending API office hours', 'Bring your integration questions.', 'workshop', ?, 'all', '[]',
              datetime('now', '+9 days'), 45, 'https://meet.example/xyz-abcd-efg',
              '["in_portal","email"]', '[1440,60]', 'scheduled')
    `).run(uuid(), rootId);

    database.prepare(`
      INSERT INTO message_blasts (id, subject, content, channel, target_type, target_ids,
                                  status, circle_id, created_at)
      VALUES (?, 'Office hours this Thursday', 'Bring your integration questions.', 'email', 'all', '[]',
              'draft', ?, datetime('now', '-1 days'))
    `).run(uuid(), rootId);

    database.prepare(`
      INSERT INTO integration_events (id, source, event_type, payload, processed, created_at)
      VALUES (?, 'customer_io', 'first_sandbox_call', ?, 1, datetime('now', '-2 days'))
    `).run(uuid(), JSON.stringify({ event_type: 'first_sandbox_call', user_id: 'hub_demo' }));

    meta(database, 'seeded_at', new Date().toISOString());
  })();

  logger.info('sandbox seeded with demo data');
}

// ─── Access ─────────────────────────────────────────────────
// Authentication resolves against whichever database the request is on, so the
// caller's session has to exist in the sandbox too. Rather than a second login,
// their live session is mirrored across for as long as it is valid — same
// account, same role, same permissions, different data.

function mirrorAccess(database, { admin, role, session }) {
  database.transaction(() => {
    if (role) {
      // roles.name is unique, and a role deleted and recreated live leaves a
      // stale row here holding the name. The name is cosmetic in the sandbox —
      // permissions are read by id — so the mirror steps around it rather than
      // deleting a row something else may still point at.
      const clash = database.prepare('SELECT id FROM roles WHERE name = ? AND id <> ?').get(role.name, role.id);
      const name = clash ? `${role.name} (${role.id.slice(0, 8)})` : role.name;

      database.prepare(`
        INSERT INTO roles (id, name, description, permissions, is_system)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET permissions = excluded.permissions, name = excluded.name
      `).run(role.id, name, role.description, role.permissions, role.is_system);
    }

    // An account recreated on the same address is a different id here. Nothing
    // references admin_users by foreign key, so the stale mirror and its
    // sessions go rather than blocking the unique address.
    database.prepare(`
      DELETE FROM sessions WHERE subject_id IN (SELECT id FROM admin_users WHERE email = ? AND id <> ?)
    `).run(admin.email, admin.id);
    database.prepare('DELETE FROM admin_users WHERE email = ? AND id <> ?').run(admin.email, admin.id);

    database.prepare(`
      INSERT INTO admin_users (id, email, name, password_hash, role_id, status)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET role_id = excluded.role_id, status = excluded.status
    `).run(admin.id, admin.email, admin.name, admin.password_hash, admin.role_id, admin.status);

    database.prepare(`
      INSERT INTO sessions (token_hash, subject_id, is_admin, issued_via, user_agent, expires_at, scope)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET expires_at = excluded.expires_at
    `).run(
      session.token_hash, session.subject_id, session.is_admin,
      session.issued_via, session.user_agent, session.expires_at, session.scope || 'full'
    );
  })();
}

// ─── Lifecycle ──────────────────────────────────────────────

function reset() {
  if (handle && handle.open) handle.close();
  handle = null;

  // -wal and -shm go with it, or the new database inherits the old pages
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
  }

  const database = db();
  meta(database, 'reset_at', new Date().toISOString());
  return status();
}

const COUNTED = ['users', 'cohorts', 'circles', 'surveys', 'survey_responses', 'gifts', 'feedback', 'scheduled_sessions'];

function status() {
  const database = db();
  const counts = {};
  for (const table of COUNTED) {
    counts[table] = database.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
  }

  return {
    enabled: config.sandbox.enabled,
    header: 'X-Devcircle-Sandbox',
    seeded_at: meta(database, 'seeded_at'),
    reset_at: meta(database, 'reset_at'),
    counts
  };
}

module.exports = { db, reset, status, mirrorAccess, DB_PATH };
