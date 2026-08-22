#!/usr/bin/env node
// Postgres / Supabase seeder — mirrors src/db/seed.js but uses pg pool + async
// Run with: DATABASE_URL=postgres://... node scripts/seed-postgres.js
// Or: npm run seed  (seed.js delegates here when DATABASE_URL is set)

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../src/config');

if (config.isProduction && process.env.ALLOW_PRODUCTION_SEED !== 'yes-destroy-my-data') {
  console.error('Refusing to seed: NODE_ENV is production.');
  process.exit(1);
}

if (!config.isPostgres) {
  console.error('DATABASE_URL not set — use `npm run seed` for SQLite or set DATABASE_URL for Postgres');
  process.exit(1);
}

const pg = require('../src/db/pg');
const { SCHEMA_POSTGRES } = require('../src/db/schema.postgres');
const { NO_PASSWORD } = require('../src/utils/identity');
const { normalizePhone } = require('../src/utils/identity');
const { generateApiKey, hashApiKey } = require('../src/middleware/auth');

function uuid() { return crypto.randomUUID(); }

async function seed() {
  console.log('Seeding Postgres (Supabase) database...\n');

  await pg.exec(SCHEMA_POSTGRES);
  console.log('✓ schema ensured');

  const tables = [
    'session_dispatches', 'scheduled_sessions',
    'message_deliveries', 'notifications', 'user_gifts', 'gifts', 'consent',
    'feedback', 'survey_responses', 'surveys', 'questions', 'engagement_history',
    'circle_admins', 'circle_members', 'circles',
    'user_cohorts', 'cohorts', 'sessions', 'users', 'admin_users', 'roles',
    'api_keys', 'message_blasts', 'integration_events'
  ];

  for (const t of tables) {
    await pg.query(`DELETE FROM ${t}`);
  }
  console.log('✓ cleared previous seed data');

  // Roles
  const roles = [
    { id: uuid(), name: 'Super Admin', description: 'Full access', is_system: 1, permissions: ['*'] },
    { id: uuid(), name: 'Admin', description: 'Standard admin', is_system: 1, permissions: ['members.read','members.write','members.import','cohorts.read','cohorts.write','circles.read','circles.write','sessions.read','sessions.write','surveys.read','surveys.write','surveys.invite','blasts.send','feedback.read','feedback.write','gifts.read','gifts.write','export.read','integrations.read'] },
    { id: uuid(), name: 'CDL Rep', description: 'Engagement team', is_system: 1, permissions: ['members.read','cohorts.read','circles.read','sessions.read','sessions.write','surveys.read','surveys.invite','feedback.read','feedback.write','gifts.read'] },
    { id: uuid(), name: 'Read Only', description: 'View only access', is_system: 0, permissions: ['members.read','cohorts.read','circles.read','sessions.read','surveys.read','feedback.read'] }
  ];

  for (const r of roles) {
    await pg.query('INSERT INTO roles (id, name, description, permissions, is_system) VALUES ($1,$2,$3,$4,$5)', [r.id, r.name, r.description, JSON.stringify(r.permissions), r.is_system]);
  }
  console.log(`✓ ${roles.length} roles created`);

  // Admins
  const admins = [
    { id: uuid(), email: 'admin@creditdirect.ng', name: 'Adaeze Okonkwo', password: 'admin123', role_id: roles[0].id },
    { id: uuid(), email: 'engagement@creditdirect.ng', name: 'Tunde Bakare', password: 'engagement123', role_id: roles[2].id }
  ];
  for (const a of admins) {
    await pg.query('INSERT INTO admin_users (id, email, name, password_hash, role_id) VALUES ($1,$2,$3,$4,$5)', [a.id, a.email, a.name, bcrypt.hashSync(a.password, 10), a.role_id]);
  }
  console.log(`✓ ${admins.length} admin users created`);

  // Circles
  const devCircleId = uuid();
  const merchantCircleId = uuid();
  await pg.query('INSERT INTO circles (id, name, slug, description, color, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [devCircleId, 'Dev Circle', 'dev-circle', 'Developers integrating the Credit Direct APIs', '#107EBC', admins[0].id]);
  await pg.query('INSERT INTO circles (id, name, slug, description, color, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [merchantCircleId, 'Merchant Circle', 'merchant-circle', 'Merchants and partners on the business products', '#945A39', admins[0].id]);
  console.log('✓ 2 circles created');

  // Minimal cohorts/users for demo — full seed logic mirrors seed.js but async
  const cohortId = uuid();
  await pg.query('INSERT INTO cohorts (id, name, description, type, color, filter_rules, auto_sync, created_by, circle_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [cohortId, 'All Members', 'Every registered user', 'system', '#A0A0B8', null, 0, admins[0].id, devCircleId]);

  const demoUsers = [
    { name: 'Adebayo Martins', email: 'adebayo@paystack.dev', company: 'Paystack', work_sector: 'Fintech', api_status: 'production' },
    { name: 'Fatima Yusuf', email: 'fatima@moniepoint.ng', company: 'Moniepoint', work_sector: 'Fintech', api_status: 'sandbox' },
    { name: 'Chidi Obi', email: 'chidi@chipper.ng', company: 'Chipper Cash', work_sector: 'Fintech', api_status: 'production' }
  ];

  for (const u of demoUsers) {
    const id = uuid();
    const phone = `+234${700 + Math.floor(Math.random()*300)}${String(Math.floor(Math.random()*10000000)).padStart(7,'0')}`;
    await pg.query(`INSERT INTO users (id, email, name, phone, phone_normalized, password_hash, company, work_sector, api_status, last_active_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())`, [id, u.email, u.name, phone, normalizePhone(phone), NO_PASSWORD, u.company, u.work_sector, u.api_status]);
    await pg.query('INSERT INTO user_cohorts (user_id, cohort_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, cohortId]);
    await pg.query('INSERT INTO circle_members (circle_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [devCircleId, id]);
  }
  console.log(`✓ ${demoUsers.length} demo users created`);

  // Bootstrap API key
  const { key: bootstrapKey } = generateApiKey();
  await pg.query('INSERT INTO api_keys (id, key_hash, name, prefix, permissions, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [uuid(), hashApiKey(bootstrapKey), 'Bootstrap integration key', bootstrapKey.split('_')[1], JSON.stringify(['*']), admins[0].id]);

  // Mark migrations applied
  const migrations = require('../src/db/migrations');
  const defined = migrations.define({ _isPostgres: true, prepare: () => ({ all: () => [], get: () => null }), exec: () => {}, pragma: () => null });
  for (const m of defined) {
    await pg.query('INSERT INTO schema_migrations (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [m.id, m.name]);
  }

  console.log('\n✅ Postgres seed complete!');
  console.log('Sign in: admin@creditdirect.ng / admin123');
  console.log(`Bootstrap API key: ${bootstrapKey}`);

  await pg.getPool().end();
  process.exit(0);
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
