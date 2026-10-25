'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });

const DB_PATH = path.join(config.dataDir, 'flyleaf.db');
const db = new DatabaseSync(DB_PATH);

const PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`;
db.exec(PRAGMAS);

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
  // v2: series model, collections, annotations, reading profiles, API keys, devices, fonts.
  `
  ALTER TABLE users ADD COLUMN email TEXT;
  ALTER TABLE users ADD COLUMN prefs TEXT;
  ALTER TABLE users ADD COLUMN max_age_rating INTEGER;
  ALTER TABLE users ADD COLUMN age_include_unknown INTEGER NOT NULL DEFAULT 1;

  ALTER TABLE libraries ADD COLUMN mode TEXT NOT NULL DEFAULT 'komga';
  ALTER TABLE libraries ADD COLUMN auto_metadata INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE libraries ADD COLUMN cover_policy TEXT NOT NULL DEFAULT 'missing';
  ALTER TABLE libraries ADD COLUMN sources TEXT;

  CREATE TABLE series (
    id               INTEGER PRIMARY KEY,
    library_id       INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    key              TEXT NOT NULL,
    name             TEXT NOT NULL,
    localized_name   TEXT,
    sort_name        TEXT,
    summary          TEXT,
    status           TEXT,
    publisher        TEXT,
    year             INTEGER,
    age_rating       INTEGER,
    language         TEXT,
    genres           TEXT NOT NULL DEFAULT '[]',
    tags             TEXT NOT NULL DEFAULT '[]',
    people           TEXT NOT NULL DEFAULT '[]',
    links            TEXT NOT NULL DEFAULT '[]',
    provider_ids     TEXT NOT NULL DEFAULT '{}',
    locked           TEXT NOT NULL DEFAULT '[]',
    cover            TEXT,
    metadata_source  TEXT,
    metadata_at      INTEGER,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    UNIQUE (library_id, key)
  );

  CREATE TABLE series_relations (
    series_id   INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    related_id  INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    PRIMARY KEY (series_id, related_id)
  );

  ALTER TABLE books ADD COLUMN series_id INTEGER REFERENCES series(id) ON DELETE SET NULL;
  ALTER TABLE books ADD COLUMN volume REAL;
  ALTER TABLE books ADD COLUMN chapter REAL;
  ALTER TABLE books ADD COLUMN special INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE books ADD COLUMN embedded TEXT;
  CREATE INDEX books_series_id ON books(series_id);

  CREATE TABLE user_series (
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    series_id     INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    want_to_read  INTEGER NOT NULL DEFAULT 0,
    want_added_at INTEGER,
    status        TEXT,
    blur          INTEGER NOT NULL DEFAULT 0,
    user_tags     TEXT NOT NULL DEFAULT '[]',
    reader_settings TEXT,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (user_id, series_id)
  );

  CREATE TABLE collections (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    summary     TEXT,
    promoted    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE collection_items (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    series_id     INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    added_at      INTEGER NOT NULL,
    PRIMARY KEY (collection_id, series_id)
  );

  CREATE TABLE annotations (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('highlight', 'bookmark')),
    locator     TEXT NOT NULL,
    page        INTEGER,
    percent     REAL,
    text        TEXT,
    note        TEXT,
    color       TEXT,
    chapter     TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX annotations_book ON annotations(user_id, book_id);

  CREATE TABLE reading_profiles (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    settings    TEXT NOT NULL DEFAULT '{}',
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE profile_bindings (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target      TEXT NOT NULL CHECK (target IN ('library', 'series')),
    target_id   INTEGER NOT NULL,
    profile_id  INTEGER NOT NULL REFERENCES reading_profiles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, target, target_id)
  );

  CREATE TABLE api_keys (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    key          TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE devices (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    platform    TEXT NOT NULL DEFAULT 'other',
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE fonts (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    file        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  -- Regroup everything into series on the next scan. Ebook libraries default to
  -- metadata/filename grouping; comics and manga to folder-per-series.
  UPDATE libraries SET mode = 'kavita' WHERE kind = 'books';
  UPDATE books SET needs_meta = 1;
  `,

  // v3: per-user library access & permissions, API key scopes, webhooks, plugins & downloads.
  `
  ALTER TABLE users ADD COLUMN library_ids TEXT;   -- JSON array; NULL = every library
  ALTER TABLE users ADD COLUMN permissions TEXT;   -- JSON object, see auth.PERMISSION_DEFAULTS
  ALTER TABLE api_keys ADD COLUMN scope TEXT NOT NULL DEFAULT 'read'; -- read | full

  CREATE TABLE webhooks (
    id          INTEGER PRIMARY KEY,
    url         TEXT NOT NULL,
    secret      TEXT NOT NULL,
    events      TEXT NOT NULL,                     -- JSON array, ["*"] for everything
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    last_status INTEGER,
    last_error  TEXT,
    last_at     INTEGER
  );

  CREATE TABLE plugin_repos (
    id          INTEGER PRIMARY KEY,
    url         TEXT NOT NULL UNIQUE,
    name        TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE plugins (
    id           TEXT PRIMARY KEY,                 -- from the plugin's manifest
    name         TEXT NOT NULL,
    version      TEXT NOT NULL,
    source       TEXT NOT NULL,                    -- Lua code
    origin       TEXT,                             -- URL it was installed from (for updates)
    enabled      INTEGER NOT NULL DEFAULT 1,
    settings     TEXT NOT NULL DEFAULT '{}',
    installed_at INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );

  CREATE TABLE downloads (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    plugin_id   TEXT NOT NULL,
    library_id  INTEGER REFERENCES libraries(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    item        TEXT NOT NULL,                     -- JSON: what the plugin returned
    status      TEXT NOT NULL DEFAULT 'queued',    -- queued | downloading | done | failed
    received    INTEGER NOT NULL DEFAULT 0,
    total       INTEGER,
    file        TEXT,
    error       TEXT,
    created_at  INTEGER NOT NULL,
    finished_at INTEGER
  );
  `,

  // v4: personal folders and per-user libraries.
  `
  ALTER TABLE users ADD COLUMN home_dir TEXT;   -- the admin-assigned personal folder, or NULL
  ALTER TABLE libraries ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE; -- NULL = shared
  CREATE INDEX libraries_owner ON libraries(owner_id);
  `,

  // v5: profile pictures and per-user backgrounds.
  `
  ALTER TABLE users ADD COLUMN avatar TEXT;      -- file name in data/avatars
  ALTER TABLE users ADD COLUMN background TEXT;  -- file name in data/backgrounds
  `,

  // v6: reading goals, when books were finished, ratings & reviews, push notifications.
  `
  ALTER TABLE progress ADD COLUMN finished_at INTEGER;
  UPDATE progress SET finished_at = updated_at WHERE finished = 1;
  -- Every way of finishing a book (reader, Mark as read, OPDS) goes through these.
  CREATE TRIGGER progress_finished_insert AFTER INSERT ON progress WHEN NEW.finished = 1 AND NEW.finished_at IS NULL
  BEGIN
    UPDATE progress SET finished_at = NEW.updated_at WHERE user_id = NEW.user_id AND book_id = NEW.book_id;
  END;
  CREATE TRIGGER progress_finished_update AFTER UPDATE OF finished ON progress WHEN NEW.finished = 1 AND OLD.finished = 0
  BEGIN
    UPDATE progress SET finished_at = NEW.updated_at WHERE user_id = NEW.user_id AND book_id = NEW.book_id;
  END;
  CREATE INDEX progress_finished ON progress(user_id, finished_at);

  CREATE TABLE reading_goals (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    year     INTEGER NOT NULL,
    books    INTEGER NOT NULL,
    PRIMARY KEY (user_id, year)
  );

  CREATE TABLE series_reviews (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    series_id   INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    rating      INTEGER CHECK (rating BETWEEN 1 AND 10),   -- half stars: 1 = ½★ … 10 = 5★
    body        TEXT,
    spoiler     INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, series_id)
  );
  CREATE INDEX series_reviews_series ON series_reviews(series_id, updated_at DESC);

  -- Files people uploaded, so the admin can review what each user added.
  CREATE TABLE uploads (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    library_id  INTEGER REFERENCES libraries(id) ON DELETE CASCADE,
    file        TEXT NOT NULL,                     -- absolute path
    size        INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX uploads_user ON uploads(user_id);
  CREATE INDEX uploads_file ON uploads(file);

  CREATE TABLE push_subscriptions (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    user_agent  TEXT,
    created_at  INTEGER NOT NULL,
    last_error  TEXT
  );
  `,
];

function migrate() {
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
}
migrate();

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

/**
 * Close the database, run `swap(dbPath)` (which may replace the file on disk), then open it
 * again and bring it up to date. Used to restore a backup without restarting.
 */
function reopen(swap) {
  db.close();
  stmtCache.clear();
  try {
    swap(DB_PATH);
  } finally {
    db.open();
    db.exec(PRAGMAS);
    migrate();
  }
}

module.exports = { db, q, tx, reopen, DB_PATH, SCHEMA_VERSION: migrations.length };
