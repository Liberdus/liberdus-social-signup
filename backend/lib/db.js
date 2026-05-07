const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const DEFAULT_DB_PATH = path.join("data", "liberdus-social-signup.sqlite");
const CURRENT_SCHEMA_VERSION = 1;

function getRepoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function resolveRepoPath(filePath) {
  return path.resolve(getRepoRoot(), filePath);
}

function getDatabasePath() {
  return resolveRepoPath(process.env.SIGNUP_DB_PATH || DEFAULT_DB_PATH);
}

function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signups (
      id TEXT PRIMARY KEY,
      x_user_id TEXT NOT NULL,
      x_username TEXT NOT NULL,
      x_name TEXT,
      x_profile_image_url TEXT,
      wallet_address TEXT NOT NULL,
      wallet_chain_id INTEGER,
      signed_message TEXT NOT NULL,
      signature TEXT NOT NULL,
      display_name TEXT,
      email TEXT,
      country TEXT,
      interest TEXT,
      discord_username TEXT,
      telegram_username TEXT,
      linkedin_url TEXT,
      notes TEXT,
      verification_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'received',
      user_agent TEXT,
      ip_address TEXT,
      submitted_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_signups_x_user_id
      ON signups(x_user_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_signups_wallet_address
      ON signups(LOWER(wallet_address));

    CREATE INDEX IF NOT EXISTS idx_signups_x_username
      ON signups(LOWER(x_username));

    CREATE INDEX IF NOT EXISTS idx_signups_submitted_at
      ON signups(submitted_at DESC);
  `);
  db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
}

function openDatabase() {
  const databasePath = getDatabasePath();
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  initializeSchema(db);
  return db;
}

module.exports = {
  getDatabasePath,
  openDatabase,
  resolveRepoPath
};

