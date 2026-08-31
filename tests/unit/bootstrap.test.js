const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const { SCHEMA } = require('../../src/db/schema');
const migrations = require('../../src/db/migrations');
const { ensureDemoAccounts, DEMO_ADMINS, DEMO_USERS } = require('../../src/db/bootstrap');

function freshDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devcircle-boot-')), 'test.db');
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrations.run(db);
  return db;
}

test('bootstrap creates the first-run accounts on an empty database', async () => {
  const db = freshDb();
  const result = await ensureDemoAccounts(db, { force: true });

  assert.equal(result.skipped, false);
  assert.ok(result.created.admins >= 2);
  assert.ok(result.created.users >= 2);

  const admin = db.prepare("SELECT * FROM admin_users WHERE email = 'admin@creditdirect.ng'").get();
  assert.ok(admin);
  assert.equal(admin.status, 'active');
  assert.ok(admin.is_global);
  assert.ok(bcrypt.compareSync('admin123', admin.password_hash));

  const rep = db.prepare("SELECT * FROM admin_users WHERE email = 'engagement@creditdirect.ng'").get();
  assert.ok(rep);
  assert.ok(bcrypt.compareSync('engagement123', rep.password_hash));

  const grant = db.prepare(
    'SELECT 1 AS ok FROM circle_admins WHERE admin_id = ?'
  ).get(admin.id);
  assert.ok(grant, 'super admin must be granted on the default circle');

  for (const user of DEMO_USERS) {
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(user.email);
    assert.ok(row, user.email);
    assert.equal(row.status, 'active');
  }
});

test('bootstrap is idempotent', async () => {
  const db = freshDb();
  await ensureDemoAccounts(db, { force: true });
  const again = await ensureDemoAccounts(db, { force: true });

  assert.equal(again.created.admins, 0);
  assert.equal(again.created.users, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM admin_users').get().c, DEMO_ADMINS.length);
});

// The bootstrap used to UPDATE the hash, role, status and is_global of every
// account it knew about on each boot. In production that silently undid the
// operator: a password changed in the admin screens was back to the shipped one
// after the next restart, a deactivated account was active again, and a demoted
// one was global again. Existence is bootstrapped; state is not.
test('bootstrap never rewrites an account that already exists', async () => {
  const db = freshDb();
  await ensureDemoAccounts(db, { force: true });

  const readOnly = db.prepare("SELECT id FROM roles WHERE name = 'Read Only'").get();
  const chosen = bcrypt.hashSync('a-password-the-operator-chose', 10);
  db.prepare(
    "UPDATE admin_users SET password_hash = ?, status = 'inactive', is_global = 0, role_id = ? WHERE email = 'admin@creditdirect.ng'"
  ).run(chosen, readOnly.id);

  db.prepare("UPDATE users SET phone = '+2348039999999', status = 'inactive' WHERE email = ?")
    .run(DEMO_USERS[0].email);

  await ensureDemoAccounts(db, { force: true });

  const admin = db.prepare("SELECT * FROM admin_users WHERE email = 'admin@creditdirect.ng'").get();
  assert.ok(bcrypt.compareSync('a-password-the-operator-chose', admin.password_hash),
    'a password changed by the operator must survive a restart');
  assert.equal(admin.status, 'inactive', 'a deactivated admin must stay deactivated');
  assert.equal(admin.is_global, 0, 'a demoted admin must not be re-promoted');
  assert.equal(admin.role_id, readOnly.id, 'a role change must not be reverted');

  const member = db.prepare('SELECT * FROM users WHERE email = ?').get(DEMO_USERS[0].email);
  assert.equal(member.phone, '+2348039999999', 'a corrected phone number must survive a restart');
  assert.equal(member.status, 'inactive');
});
