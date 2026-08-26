const { AsyncLocalStorage } = require('async_hooks');

// ─── Which database is this request talking to? ─────────────
// Every module in the codebase holds the database as `require('../db')`, bound
// once at load. The API sandbox needs the same code to write somewhere else
// entirely for the length of one request, without any of those modules knowing
// it happened — so the handle they hold is a proxy, and this is what it asks.
//
// AsyncLocalStorage carries the answer across every await in the request, so a
// handler that awaits a provider call mid-transaction still comes back to the
// same database it started on.

const storage = new AsyncLocalStorage();

let liveDb = null;

function useLive(database) {
  liveDb = database;
}

// The live database, always — for the few things that must not follow a
// request into the sandbox: the session behind the sandbox request itself,
// and the background timers that outlive it.
function live() {
  return liveDb;
}

function active() {
  const store = storage.getStore();
  return (store && store.db) || liveDb;
}

function inSandbox() {
  const store = storage.getStore();
  return Boolean(store && store.sandbox);
}

// Run fn — and everything it awaits — against another database.
function runWith(database, fn) {
  return storage.run({ db: database, sandbox: true }, fn);
}

// ─── A transaction in progress ──────────────────────────────
// The same trick, one level down. On Postgres a transaction belongs to one
// connection: BEGIN on a pooled client and then running the statements through
// the pool puts them on *other* connections, outside the transaction that was
// opened for them. Nothing errors — the writes land, the COMMIT commits an
// empty transaction, and a ROLLBACK rolls back nothing.
//
// So the client is carried here for the length of the block, and db.prepare
// asks for it. Every module still holds the same handle and none of them need
// to know a transaction is open — which is the point, because the alternative
// is threading a client argument through every service that might one day be
// called inside one.
//
// Nested blocks keep the outermost client rather than opening a second: a
// transaction inside a transaction is one transaction, and issuing BEGIN twice
// on one connection is a warning and a no-op in Postgres anyway.
function runInTransaction(client, fn) {
  const store = storage.getStore() || {};
  if (store.tx) return fn();
  return storage.run({ ...store, tx: client }, fn);
}

function txClient() {
  return storage.getStore()?.tx || null;
}

module.exports = { useLive, live, active, inSandbox, runWith, runInTransaction, txClient };
