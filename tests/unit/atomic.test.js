const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

before(h.start);
after(h.stop);

// ─── Doing several writes as one ────────────────────────────
// db.atomic() exists because the Postgres adapter made every statement a
// promise, and the transaction wrapper in front of it did not await them: BEGIN
// went to one pooled connection and the writes went to others, so the
// transaction committed nothing and a rollback rolled back nothing.
//
// These run on SQLite, which is what the suite uses — so what they prove is the
// contract the two adapters share: a block commits together, a throw undoes all
// of it, and two blocks never interleave. The Postgres half of the fix is the
// client binding in db/context.js, which has nowhere to be exercised without a
// live Postgres.

const db = h.db;

before(() => {
  db.exec('CREATE TABLE IF NOT EXISTS atomic_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
});

const rows = () => db.prepare('SELECT v FROM atomic_probe ORDER BY id').all().map(r => r.v);
const clear = () => db.prepare('DELETE FROM atomic_probe').run();

test('everything in a block lands together', async () => {
  clear();

  await db.atomic(async () => {
    await db.prepare('INSERT INTO atomic_probe (v) VALUES (?)').run('one');
    await db.prepare('INSERT INTO atomic_probe (v) VALUES (?)').run('two');
  });

  assert.deepEqual(rows(), ['one', 'two']);
});

test('a throw undoes the writes that came before it', async () => {
  clear();

  await assert.rejects(
    db.atomic(async () => {
      await db.prepare('INSERT INTO atomic_probe (v) VALUES (?)').run('kept?');
      throw new Error('changed my mind');
    }),
    /changed my mind/
  );

  assert.deepEqual(rows(), [], 'the insert before the throw must not survive it');
});

test('the block hands back what its body returned', async () => {
  clear();
  const result = await db.atomic(async () => {
    await db.prepare('INSERT INTO atomic_probe (v) VALUES (?)').run('x');
    return 'the answer';
  });
  assert.equal(result, 'the answer');
});

test('one refused block does not poison the next', async () => {
  clear();

  await assert.rejects(db.atomic(async () => { throw new Error('first'); }), /first/);

  // The queue that serialises blocks holds a promise chain. A rejection left
  // unhandled on it would reject every block queued behind it, so the failure
  // is swallowed there and rethrown only to the caller who asked for it.
  await db.atomic(async () => {
    await db.prepare('INSERT INTO atomic_probe (v) VALUES (?)').run('after');
  });

  assert.deepEqual(rows(), ['after']);
});

test('two blocks do not interleave', async () => {
  clear();

  // Each block writes its marker twice with a yield in between. Interleaved,
  // the table would read a, b, a, b; serialised, it reads a, a, b, b.
  const block = letter => db.atomic(async () => {
    await db.prepare('INSERT INTO atomic_probe (v) VALUES (?)').run(letter);
    await new Promise(resolve => setImmediate(resolve));
    await db.prepare('INSERT INTO atomic_probe (v) VALUES (?)').run(letter);
  });

  await Promise.all([block('a'), block('b')]);

  const written = rows();
  assert.equal(written.length, 4);
  assert.deepEqual(
    written,
    written[0] === 'a' ? ['a', 'a', 'b', 'b'] : ['b', 'b', 'a', 'a'],
    'a block must finish before the next one starts'
  );
});

test('a nested block joins the one already open rather than starting a second', async () => {
  clear();

  // Two BEGINs on one connection is an error in SQLite and a warning in
  // Postgres. What a caller means by a transaction inside a transaction is one
  // transaction, so the inner block runs in the outer one — and rolls back
  // with it.
  await assert.rejects(
    db.atomic(async () => {
      await db.prepare('INSERT INTO atomic_probe (v) VALUES (?)').run('outer');
      await db.atomic(async () => {
        await db.prepare('INSERT INTO atomic_probe (v) VALUES (?)').run('inner');
      });
      throw new Error('undo both');
    }),
    /undo both/
  );

  assert.deepEqual(rows(), [], 'the inner write is part of the outer transaction');
});
