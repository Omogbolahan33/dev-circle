const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const config = require('../config');
const context = require('./context');
const { SCHEMA } = require('./schema');

const DB_PATH = config.dbPath;

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const live = new Database(DB_PATH);

// Enable WAL mode for better concurrent reads
live.pragma('journal_mode = WAL');
live.pragma('foreign_keys = ON');

live.exec(SCHEMA);

// Apply any migrations this database has not seen yet
const { logger } = require('../utils/logger');
require('./migrations').run(live, { log: msg => logger.info(msg) });

context.useLive(live);

// ─── The handle everything else holds ───────────────────────
// Exported as a proxy rather than the connection itself. Ordinarily it forwards
// straight to the live database and costs a property lookup; inside a sandboxed
// request it forwards to the throwaway one instead. Twenty-odd modules hold
// this object and none of them need to know which is which.
//
// The one rule this places on the rest of the codebase: prepare statements when
// you use them, not at module load. A statement prepared at load belongs to
// whichever database existed then, and would write there forever.
module.exports = new Proxy(live, {
  get(target, property) {
    const database = context.active() || target;
    const value = database[property];
    return typeof value === 'function' ? value.bind(database) : value;
  }
});
