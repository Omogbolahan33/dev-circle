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

test('bootstrap creates the advertised demo logins', async () => {
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

test('bootstrap is idempotent and keeps published passwords working', async () => {
  const db = freshDb();
  await ensureDemoAccounts(db, { force: true });
  const again = await ensureDemoAccounts(db, { force: true });

  assert.equal(again.created.admins, 0);
  assert.equal(again.created.users, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM admin_users').get().c, DEMO_ADMINS.length);

  const admin = db.prepare("SELECT password_hash FROM admin_users WHERE email = 'admin@creditdirect.ng'").get();
  assert.ok(bcrypt.compareSync('admin123', admin.password_hash));
});
