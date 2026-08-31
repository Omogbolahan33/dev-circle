const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { NO_PASSWORD } = require('../utils/identity');

// ─── Bootstrap accounts ─────────────────────────────────────
// A fresh deploy applies schema and then leaves every table empty, so there is
// nobody to sign in as. This creates the roles, the default circle, the "All
// Members" cohort and a first set of accounts if — and only if — they are
// missing. Nothing that already exists is touched.
//
// The passwords below are the ones a first deploy starts with. They are no
// longer printed anywhere in the UI, and because this is insert-only, changing
// one in the admin screens now sticks across restarts. Change them on the first
// sign-in of a new environment.
//
// Skip entirely with SEED_DEMO_ACCOUNTS=false. Tests skip automatically.

const DEMO_ROLES = [
  {
    name: 'Super Admin',
    description: 'Full access',
    is_system: 1,
    permissions: ['*']
  },
  {
    name: 'Admin',
    description: 'Standard admin',
    is_system: 1,
    permissions: [
      'members.read', 'members.write', 'members.import',
      'cohorts.read', 'cohorts.write',
      'circles.read', 'circles.write',
      'sessions.read', 'sessions.write',
      'surveys.read', 'surveys.write', 'surveys.invite',
      'blasts.send', 'feedback.read', 'feedback.write',
      'gifts.read', 'gifts.write', 'export.read', 'integrations.read'
    ]
  },
  {
    name: 'CDL Rep',
    description: 'Engagement team',
    is_system: 1,
    permissions: [
      'members.read', 'cohorts.read', 'circles.read',
      'sessions.read', 'sessions.write',
      'surveys.read', 'surveys.invite',
      'feedback.read', 'feedback.write', 'gifts.read'
    ]
  },
  {
    name: 'Read Only',
    description: 'View only access',
    is_system: 0,
    permissions: [
      'members.read', 'cohorts.read', 'circles.read',
      'sessions.read', 'surveys.read', 'feedback.read'
    ]
  }
];

const DEMO_ADMINS = [
  {
    email: 'admin@creditdirect.ng',
    name: 'Adaeze Okonkwo',
    password: 'admin123',
    role: 'Super Admin',
    is_global: 1
  },
  {
    email: 'engagement@creditdirect.ng',
    name: 'Tunde Bakare',
    password: 'engagement123',
    role: 'CDL Rep',
    is_global: 0
  }
];

// A participant signs in with their address and the last six digits of the
// number on their record, so an account without a number is one nobody can
// sign in as. These two carry fixed numbers for that reason.
const DEMO_USERS = [
  {
    email: 'adebayo@paystack.dev',
    name: 'Adebayo Martins',
    phone: '+2348030000001',
    company: 'Paystack',
    work_sector: 'Fintech',
    api_status: 'production'
  },
  {
    email: 'emeka@kuda.ng',
    name: 'Emeka Okafor',
    phone: '+2348030000002',
    company: 'Kuda Bank',
    work_sector: 'Banking',
    api_status: 'production'
  }
];

function uuid() {
  return crypto.randomUUID();
}

function queries(database) {
  return {
    async get(sql, ...params) {
      return await database.prepare(sql).get(...params);
    },
    async all(sql, ...params) {
      return await database.prepare(sql).all(...params);
    },
    async run(sql, ...params) {
      return await database.prepare(sql).run(...params);
    }
  };
}

function shouldSeed() {
  if (config.env === 'test') return false;
  return config.seedDemoAccounts !== false;
}

async function ensureDemoAccounts(database, { force = false } = {}) {
  if (!force && !shouldSeed()) return { skipped: true, reason: 'disabled' };

  const q = queries(database);
  const created = { roles: 0, admins: 0, users: 0, circles: 0 };

  for (const role of DEMO_ROLES) {
    const existing = await q.get('SELECT id FROM roles WHERE name = ?', role.name);
    if (existing) continue;
    await q.run(
      'INSERT INTO roles (id, name, description, permissions, is_system) VALUES (?, ?, ?, ?, ?)',
      uuid(), role.name, role.description, JSON.stringify(role.permissions), role.is_system
    );
    created.roles++;
  }

  const rolesByName = {};
  for (const row of await q.all('SELECT id, name FROM roles')) {
    rolesByName[row.name] = row.id;
  }

  // Existing rows are left exactly as they are. This used to UPDATE the hash,
  // role, status and is_global on every boot, which meant a password changed in
  // the admin UI was reverted by the next restart, a deactivated account came
  // back active, and a demoted one came back global. The bootstrap's job is to
  // guarantee the account exists on a fresh deploy; who it is after that is the
  // operator's to decide.
  for (const admin of DEMO_ADMINS) {
    const roleId = rolesByName[admin.role];
    if (!roleId) throw new Error(`Role "${admin.role}" is missing`);
    const existing = await q.get('SELECT id FROM admin_users WHERE lower(email) = ?', admin.email);
    if (existing) {
      admin.id = existing.id;
      continue;
    }
    const id = uuid();
    await q.run(
      `INSERT INTO admin_users (id, email, name, password_hash, role_id, status, is_global)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      id, admin.email, admin.name, bcrypt.hashSync(admin.password, 10), roleId, admin.is_global
    );
    admin.id = id;
    created.admins++;
  }

  let circle = await q.get("SELECT * FROM circles WHERE slug = 'dev-circle'");
  if (!circle) {
    circle = await q.get("SELECT * FROM circles WHERE status = 'active' ORDER BY created_at LIMIT 1");
  }
  if (!circle) {
    const id = uuid();
    await q.run(
      `INSERT INTO circles (id, name, slug, description, color)
       VALUES (?, 'Dev Circle', 'dev-circle', 'Developers integrating the Credit Direct APIs', '#107EBC')`,
      id
    );
    circle = await q.get('SELECT * FROM circles WHERE id = ?', id);
    created.circles++;
  }

  for (const admin of DEMO_ADMINS) {
    await q.run(
      `INSERT INTO circle_admins (circle_id, admin_id, role_id) VALUES (?, ?, ?)
       ON CONFLICT (circle_id, admin_id) DO UPDATE SET role_id = excluded.role_id`,
      circle.id, admin.id, rolesByName[admin.role]
    );
  }

  let cohort = await q.get(
    "SELECT id FROM cohorts WHERE name = 'All Members' AND (circle_id = ? OR circle_id IS NULL)",
    circle.id
  );
  if (!cohort) {
    const id = uuid();
    await q.run(
      `INSERT INTO cohorts (id, name, description, type, color, circle_id)
       VALUES (?, 'All Members', 'Every registered user', 'system', '#A0A0B8', ?)`,
      id, circle.id
    );
    cohort = { id };
  }

  for (const user of DEMO_USERS) {
    const existing = await q.get('SELECT id FROM users WHERE lower(email) = ?', user.email);
    let userId;
    if (existing) {
      // Left alone for the same reason as the admins above: the phone number is
      // half of a member's credential, so rewriting it on boot would undo any
      // correction made to the record.
      userId = existing.id;
    } else {
      userId = uuid();
      await q.run(
        `INSERT INTO users (id, email, name, phone, phone_normalized, password_hash,
                            company, work_sector, api_status, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        userId, user.email, user.name, user.phone, user.phone, NO_PASSWORD,
        user.company, user.work_sector, user.api_status
      );
      created.users++;
    }
    await q.run(
      'INSERT INTO user_cohorts (user_id, cohort_id) VALUES (?, ?) ON CONFLICT (user_id, cohort_id) DO NOTHING',
      userId, cohort.id
    );
    await q.run(
      'INSERT INTO circle_members (circle_id, user_id) VALUES (?, ?) ON CONFLICT (circle_id, user_id) DO NOTHING',
      circle.id, userId
    );
  }

  return { skipped: false, created, circleId: circle.id };
}

module.exports = {
  ensureDemoAccounts,
  shouldSeed,
  DEMO_ADMINS,
  DEMO_USERS,
  DEMO_ROLES
};
