const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { parseJsonObject, stringifyJsonObject } = require("./json-utils");

const DEFAULT_DB_PATH = path.join("data", "liberdus-social-signup.sqlite");

function getRepoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function resolveRepoPath(filePath) {
  return path.resolve(getRepoRoot(), filePath);
}

function getDatabasePath() {
  return resolveRepoPath(process.env.SIGNUP_DB_PATH || DEFAULT_DB_PATH);
}

function addSocialSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signup_social_accounts (
      id TEXT PRIMARY KEY,
      signup_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      username TEXT,
      display_name TEXT,
      profile_url TEXT,
      avatar_url TEXT,
      connected_at TEXT NOT NULL,
      raw_profile_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (signup_id) REFERENCES signups(id) ON DELETE CASCADE,
      UNIQUE(provider, provider_user_id),
      UNIQUE(signup_id, provider)
    );

    CREATE INDEX IF NOT EXISTS idx_signup_social_accounts_signup_id
      ON signup_social_accounts(signup_id);

    CREATE INDEX IF NOT EXISTS idx_signup_social_accounts_provider_username
      ON signup_social_accounts(provider, LOWER(username));

    CREATE TABLE IF NOT EXISTS signup_social_verifications (
      id TEXT PRIMARY KEY,
      social_account_id TEXT NOT NULL,
      check_type TEXT NOT NULL,
      target_id TEXT,
      status TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      raw_result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (social_account_id) REFERENCES signup_social_accounts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_signup_social_verifications_account_id
      ON signup_social_verifications(social_account_id);

    CREATE INDEX IF NOT EXISTS idx_signup_social_verifications_check_status
      ON signup_social_verifications(check_type, status);
  `);
}

function initializeBaseSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signups (
      id TEXT PRIMARY KEY,
      x_user_id TEXT,
      x_username TEXT,
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
}

function ensureNullableXSignupColumns(db) {
  const columns = db.pragma("table_info(signups)");
  const xUserId = columns.find((column) => column.name === "x_user_id");
  const xUsername = columns.find((column) => column.name === "x_username");
  if (!xUserId?.notnull && !xUsername?.notnull) return;

  const columnNames = [
    "id",
    "x_user_id",
    "x_username",
    "x_name",
    "x_profile_image_url",
    "wallet_address",
    "wallet_chain_id",
    "signed_message",
    "signature",
    "display_name",
    "email",
    "country",
    "interest",
    "discord_username",
    "telegram_username",
    "linkedin_url",
    "notes",
    "verification_json",
    "status",
    "user_agent",
    "ip_address",
    "submitted_at",
    "created_at",
    "updated_at"
  ].join(", ");
  const foreignKeysEnabled = Boolean(db.pragma("foreign_keys", { simple: true }));

  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.exec(`
      BEGIN;

      CREATE TABLE signups_new (
        id TEXT PRIMARY KEY,
        x_user_id TEXT,
        x_username TEXT,
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

      INSERT INTO signups_new (${columnNames})
      SELECT ${columnNames}
      FROM signups;

      DROP TABLE signups;
      ALTER TABLE signups_new RENAME TO signups;

      COMMIT;
    `);
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Ignore rollback failures; the original error is more useful.
    }
    throw error;
  } finally {
    db.pragma("legacy_alter_table = OFF");
    db.pragma(`foreign_keys = ${foreignKeysEnabled ? "ON" : "OFF"}`);
  }
}

function getStatusFromBoolean(value) {
  return value ? "passed" : "failed";
}

function backfillSocialSchema(db) {
  const insertAccount = db.prepare(`
    INSERT OR IGNORE INTO signup_social_accounts (
      id,
      signup_id,
      provider,
      provider_user_id,
      username,
      display_name,
      profile_url,
      avatar_url,
      connected_at,
      raw_profile_json,
      created_at,
      updated_at
    ) VALUES (
      @id,
      @signupId,
      @provider,
      @providerUserId,
      @username,
      @displayName,
      @profileUrl,
      @avatarUrl,
      @connectedAt,
      @rawProfileJson,
      @createdAt,
      @updatedAt
    )
  `);

  const insertVerification = db.prepare(`
    INSERT OR IGNORE INTO signup_social_verifications (
      id,
      social_account_id,
      check_type,
      target_id,
      status,
      checked_at,
      raw_result_json,
      created_at
    ) VALUES (
      @id,
      @socialAccountId,
      @checkType,
      @targetId,
      @status,
      @checkedAt,
      @rawResultJson,
      @createdAt
    )
  `);
  const getAccountById = db.prepare("SELECT id FROM signup_social_accounts WHERE id = ?");
  const getVerificationByAccountCheck = db.prepare(`
    SELECT id
    FROM signup_social_verifications
    WHERE social_account_id = ?
      AND check_type = ?
    LIMIT 1
  `);

  const rows = db.prepare("SELECT * FROM signups").all();
  for (const row of rows) {
    const verification = parseJsonObject(row.verification_json);
    const createdAt = row.created_at || row.submitted_at;
    const updatedAt = row.updated_at || createdAt;

    const accounts = [{
      provider: "x",
      providerUserId: row.x_user_id,
      username: row.x_username,
      displayName: row.x_name || row.x_username,
      profileUrl: row.x_username ? `https://x.com/${row.x_username}` : "",
      avatarUrl: row.x_profile_image_url || "",
      connectedAt: row.submitted_at,
      rawProfile: {
        id: row.x_user_id,
        username: row.x_username,
        name: row.x_name || "",
        profileImageUrl: row.x_profile_image_url || "",
        verified: verification.x?.verified === true
      },
      verifications: [{
        checkType: "x_authenticated",
        targetId: row.x_user_id,
        status: "passed",
        checkedAt: row.submitted_at,
        rawResult: verification.x || {}
      }, {
        checkType: "x_verified",
        targetId: row.x_user_id,
        status: getStatusFromBoolean(verification.x?.verified === true),
        checkedAt: row.submitted_at,
        rawResult: { verified: verification.x?.verified === true }
      }]
    }];

    if (verification.discord?.connected || row.discord_username) {
      accounts.push({
        provider: "discord",
        providerUserId: verification.discord?.userId || row.discord_username,
        username: verification.discord?.username || row.discord_username,
        displayName: verification.discord?.displayName || row.discord_username,
        profileUrl: "",
        avatarUrl: "",
        connectedAt: row.submitted_at,
        rawProfile: verification.discord || {},
        verifications: [{
          checkType: "discord_guild_member",
          targetId: verification.discord?.guildId || "",
          status: verification.discord?.connected ? getStatusFromBoolean(verification.discord?.verified === true) : "unknown",
          checkedAt: verification.discord?.membershipCheckedAt || row.submitted_at,
          rawResult: verification.discord || {}
        }]
      });
    }

    if (verification.telegram?.connected || row.telegram_username) {
      accounts.push({
        provider: "telegram",
        providerUserId: verification.telegram?.userId || row.telegram_username,
        username: verification.telegram?.username || row.telegram_username,
        displayName: verification.telegram?.displayName || row.telegram_username,
        profileUrl: verification.telegram?.username ? `https://t.me/${verification.telegram.username}` : "",
        avatarUrl: "",
        connectedAt: row.submitted_at,
        rawProfile: verification.telegram || {},
        verifications: [{
          checkType: "telegram_group_member",
          targetId: verification.telegram?.chatId || "",
          status: verification.telegram?.connected ? getStatusFromBoolean(verification.telegram?.verified === true) : "unknown",
          checkedAt: verification.telegram?.membershipCheckedAt || row.submitted_at,
          rawResult: verification.telegram || {}
        }]
      });
    }

    if (verification.linkedin?.connected || row.linkedin_url) {
      accounts.push({
        provider: "linkedin",
        providerUserId: verification.linkedin?.userId || row.linkedin_url,
        username: "",
        displayName: verification.linkedin?.name || row.linkedin_url,
        profileUrl: "",
        avatarUrl: verification.linkedin?.picture || "",
        connectedAt: row.submitted_at,
        rawProfile: verification.linkedin || {},
        verifications: [{
          checkType: "linkedin_authenticated",
          targetId: verification.linkedin?.userId || "",
          status: verification.linkedin?.connected ? "passed" : "unknown",
          checkedAt: row.submitted_at,
          rawResult: verification.linkedin || {}
        }]
      });
    }

    if (verification.github?.connected) {
      accounts.push({
        provider: "github",
        providerUserId: verification.github?.userId || verification.github?.username,
        username: verification.github?.username || "",
        displayName: verification.github?.displayName || verification.github?.username || "",
        profileUrl: verification.github?.profileUrl || "",
        avatarUrl: "",
        connectedAt: row.submitted_at,
        rawProfile: verification.github || {},
        verifications: [{
          checkType: "github_repo_starred",
          targetId: verification.github?.targetRepo || "",
          status: verification.github?.repoStarred ? "passed" : "failed",
          checkedAt: verification.github?.repoStarCheckedAt || row.submitted_at,
          rawResult: verification.github || {}
        }]
      });
    }

    if (verification.youtube?.connected) {
      accounts.push({
        provider: "youtube",
        providerUserId: verification.youtube?.channelId || verification.youtube?.userId || verification.youtube?.email,
        username: verification.youtube?.channelHandle ? `@${verification.youtube.channelHandle}` : verification.youtube?.email || "",
        displayName: verification.youtube?.channelTitle || verification.youtube?.displayName || verification.youtube?.email || "",
        profileUrl: verification.youtube?.channelUrl || "",
        avatarUrl: verification.youtube?.picture || "",
        connectedAt: row.submitted_at,
        rawProfile: verification.youtube || {},
        verifications: [{
          checkType: "youtube_channel_subscribed",
          targetId: verification.youtube?.targetChannelId || verification.youtube?.targetChannelHandle || "",
          status: verification.youtube?.subscribed ? "passed" : "failed",
          checkedAt: verification.youtube?.subscriptionCheckedAt || row.submitted_at,
          rawResult: verification.youtube || {}
        }]
      });
    }

    for (const account of accounts) {
      if (!account.providerUserId) continue;
      const accountId = `${row.id}:${account.provider}`;
      insertAccount.run({
        id: accountId,
        signupId: row.id,
        provider: account.provider,
        providerUserId: String(account.providerUserId),
        username: account.username || "",
        displayName: account.displayName || "",
        profileUrl: account.profileUrl || "",
        avatarUrl: account.avatarUrl || "",
        connectedAt: account.connectedAt || createdAt,
        rawProfileJson: stringifyJsonObject(account.rawProfile),
        createdAt,
        updatedAt
      });
      if (!getAccountById.get(accountId)) continue;

      for (const verificationEvent of account.verifications || []) {
        if (getVerificationByAccountCheck.get(accountId, verificationEvent.checkType)) continue;
        insertVerification.run({
          id: `${accountId}:${verificationEvent.checkType}`,
          socialAccountId: accountId,
          checkType: verificationEvent.checkType,
          targetId: verificationEvent.targetId || "",
          status: verificationEvent.status || "unknown",
          checkedAt: verificationEvent.checkedAt || createdAt,
          rawResultJson: stringifyJsonObject(verificationEvent.rawResult),
          createdAt
        });
      }
    }
  }
}

function initializeSchema(db) {
  initializeBaseSchema(db);
  ensureNullableXSignupColumns(db);
  initializeBaseSchema(db);
  addSocialSchema(db);
  backfillSocialSchema(db);
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
