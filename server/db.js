'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new DatabaseSync(path.join(config.dataDir, 'flyleaf.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

const migrations = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'guest')),
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER
  );

  CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    user_agent  TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE libraries (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL CHECK (kind IN ('books', 'manga', 'comics')),
    created_at  INTEGER NOT NULL,
    last_scan_at INTEGER
  );

  CREATE TABLE books (
    id            INTEGER PRIMARY KEY,
    library_id    INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    path          TEXT NOT NULL UNIQUE,
    rel_path      TEXT NOT NULL,
    format        TEXT NOT NULL,
    title         TEXT NOT NULL,
    author        TEXT,
    series        TEXT,
    series_index  REAL,
    description   TEXT,
    page_count    INTEGER,
    size          INTEGER,
    mtime         INTEGER,
    cover         TEXT,
    cover_custom  INTEGER NOT NULL DEFAULT 0,
    meta_locked   INTEGER NOT NULL DEFAULT 0,
    added_at      INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    missing       INTEGER NOT NULL DEFAULT 0,
    needs_meta    INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX books_library ON books(library_id);
  CREATE INDEX books_series ON books(library_id, series);

  CREATE TABLE progress (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    position    TEXT,
    page        INTEGER,
    percent     REAL NOT NULL DEFAULT 0,
    finished    INTEGER NOT NULL DEFAULT 0,
    settings    TEXT,
    started_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id)
  );
  CREATE INDEX progress_recent ON progress(user_id, updated_at DESC);

  CREATE TABLE reading_log (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id  INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    day      TEXT NOT NULL,
    seconds  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, book_id, day)
  );
  CREATE INDEX reading_log_day ON reading_log(user_id, day);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  `,
];

const version = db.prepare('PRAGMA user_version').get().user_version;
for (let i = version; i < migrations.length; i++) {
  db.exec('BEGIN');
  try {
    db.exec(migrations[i]);
    db.exec(`PRAGMA user_version = ${i + 1}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Run fn inside a transaction. */
function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const stmtCache = new Map();
/** Cached prepared statement. */
function q(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

module.exports = { db, q, tx };
