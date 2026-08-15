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

module.exports = { useLive, live, active, inSandbox, runWith };
