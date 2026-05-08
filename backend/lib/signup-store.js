const crypto = require("node:crypto");

const CSV_COLUMNS = [
  "submitted_at",
  "x_username",
  "x_user_id",
  "wallet_address",
  "email",
  "display_name",
  "country",
  "interest",
  "discord_username",
  "telegram_username",
  "linkedin_url",
  "status"
];

const SOCIAL_PROVIDER_ORDER = ["x", "discord", "telegram", "linkedin", "github"];

function parseJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function toJson(value) {
  return JSON.stringify(value || {});
}

function serializeSocialVerification(row) {
  if (!row) return null;
  return {
    id: row.id,
    socialAccountId: row.social_account_id,
    checkType: row.check_type,
    targetId: row.target_id || "",
    status: row.status,
    checkedAt: row.checked_at,
    rawResult: parseJson(row.raw_result_json),
    createdAt: row.created_at
  };
}

function serializeSocialAccount(row, verifications = []) {
  if (!row) return null;
  return {
    id: row.id,
    signupId: row.signup_id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    username: row.username || "",
    displayName: row.display_name || "",
    profileUrl: row.profile_url || "",
    avatarUrl: row.avatar_url || "",
    connectedAt: row.connected_at,
    rawProfile: parseJson(row.raw_profile_json),
    verifications,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializeSignup(row, { socialAccounts = [] } = {}) {
  if (!row) return null;

  const verification = parseJson(row.verification_json);

  return {
    id: row.id,
    xUserId: row.x_user_id,
    xUsername: row.x_username,
    xName: row.x_name || "",
    xProfileImageUrl: row.x_profile_image_url || "",
    walletAddress: row.wallet_address,
    walletChainId: row.wallet_chain_id,
    displayName: row.display_name || "",
    email: row.email || "",
    country: row.country || "",
    interest: row.interest || "",
    discordUsername: row.discord_username || "",
    telegramUsername: row.telegram_username || "",
    linkedinUrl: row.linkedin_url || "",
    notes: row.notes || "",
    verification,
    socialAccounts,
    status: row.status,
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeLimit(value) {
  const limit = Number.parseInt(value || "50", 10);
  if (!Number.isInteger(limit)) return 50;
  return Math.max(1, Math.min(limit, 250));
}

function normalizeOffset(value) {
  const offset = Number.parseInt(value || "0", 10);
  if (!Number.isInteger(offset)) return 0;
  return Math.max(0, offset);
}

function escapeCsvValue(value) {
  const text = String(value ?? "");
  if (!/[",\n\r]/u.test(text)) return text;
  return `"${text.replace(/"/gu, '""')}"`;
}

function normalizeSocialStatus(value) {
  const status = String(value || "unknown").trim().toLowerCase();
  return ["passed", "failed", "unknown"].includes(status) ? status : "unknown";
}

function normalizeProviderOrder(provider) {
  const index = SOCIAL_PROVIDER_ORDER.indexOf(provider);
  return index === -1 ? SOCIAL_PROVIDER_ORDER.length : index;
}

function createSignupStore(db) {
  const insertSignup = db.prepare(`
    INSERT INTO signups (
      id,
      x_user_id,
      x_username,
      x_name,
      x_profile_image_url,
      wallet_address,
      wallet_chain_id,
      signed_message,
      signature,
      display_name,
      email,
      country,
      interest,
      discord_username,
      telegram_username,
      linkedin_url,
      notes,
      verification_json,
      status,
      user_agent,
      ip_address,
      submitted_at,
      created_at,
      updated_at
    ) VALUES (
      @id,
      @xUserId,
      @xUsername,
      @xName,
      @xProfileImageUrl,
      @walletAddress,
      @walletChainId,
      @signedMessage,
      @signature,
      @displayName,
      @email,
      @country,
      @interest,
      @discordUsername,
      @telegramUsername,
      @linkedinUrl,
      @notes,
      @verificationJson,
      @status,
      @userAgent,
      @ipAddress,
      @submittedAt,
      @createdAt,
      @updatedAt
    )
  `);

  const insertSocialAccount = db.prepare(`
    INSERT INTO signup_social_accounts (
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

  const insertSocialVerification = db.prepare(`
    INSERT INTO signup_social_verifications (
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

  const getById = db.prepare("SELECT * FROM signups WHERE id = ?");
  const getByXUserId = db.prepare("SELECT * FROM signups WHERE x_user_id = ?");
  const getByWalletAddress = db.prepare("SELECT * FROM signups WHERE LOWER(wallet_address) = LOWER(?)");
  const getSocialAccountsBySignupId = db.prepare("SELECT * FROM signup_social_accounts WHERE signup_id = ?");
  const getSocialVerificationsByAccountId = db.prepare(`
    SELECT *
    FROM signup_social_verifications
    WHERE social_account_id = ?
    ORDER BY checked_at DESC, created_at DESC
  `);
  const countAll = db.prepare("SELECT COUNT(*) AS count FROM signups");
  const countSocialAccounts = db.prepare("SELECT COUNT(*) AS count FROM signup_social_accounts");
  const countSocialVerifications = db.prepare("SELECT COUNT(*) AS count FROM signup_social_verifications");

  function getSerializedSignup(row) {
    if (!row) return null;
    const socialAccounts = getSocialAccountsBySignupId.all(row.id)
      .sort((left, right) => {
        const order = normalizeProviderOrder(left.provider) - normalizeProviderOrder(right.provider);
        return order || left.provider.localeCompare(right.provider);
      })
      .map((account) => serializeSocialAccount(account, getSocialVerificationsByAccountId.all(account.id).map(serializeSocialVerification)));
    return serializeSignup(row, { socialAccounts });
  }

  function saveSocialAccounts(signupId, accounts = []) {
    for (const account of accounts) {
      const provider = String(account.provider || "").trim().toLowerCase();
      const providerUserId = String(account.providerUserId || "").trim();
      if (!provider || !providerUserId) continue;

      const now = account.connectedAt || account.createdAt || new Date().toISOString();
      const accountId = account.id || `${signupId}:${provider}`;
      insertSocialAccount.run({
        id: accountId,
        signupId,
        provider,
        providerUserId,
        username: String(account.username || "").trim(),
        displayName: String(account.displayName || "").trim(),
        profileUrl: String(account.profileUrl || "").trim(),
        avatarUrl: String(account.avatarUrl || "").trim(),
        connectedAt: account.connectedAt || now,
        rawProfileJson: toJson(account.rawProfile),
        createdAt: account.createdAt || now,
        updatedAt: account.updatedAt || now
      });

      for (const verification of account.verifications || []) {
        const checkType = String(verification.checkType || "").trim();
        if (!checkType) continue;
        insertSocialVerification.run({
          id: verification.id || crypto.randomUUID(),
          socialAccountId: accountId,
          checkType,
          targetId: String(verification.targetId || "").trim(),
          status: normalizeSocialStatus(verification.status),
          checkedAt: verification.checkedAt || now,
          rawResultJson: toJson(verification.rawResult),
          createdAt: verification.createdAt || now
        });
      }
    }
  }

  const saveSignupTransaction = db.transaction((input) => {
    const { socialAccounts = [], ...signupInput } = input;
    insertSignup.run(signupInput);
    saveSocialAccounts(input.id, socialAccounts);
    return getById.get(input.id);
  });

  function saveSignup(input) {
    return getSerializedSignup(saveSignupTransaction(input));
  }

  function findByXUserId(xUserId) {
    const value = String(xUserId || "").trim();
    return value ? getByXUserId.get(value) || null : null;
  }

  function findByWalletAddress(walletAddress) {
    const value = String(walletAddress || "").trim();
    return value ? getByWalletAddress.get(value) || null : null;
  }

  function listSignups({ search = "", limit = 50, offset = 0 } = {}) {
    const normalizedLimit = normalizeLimit(limit);
    const normalizedOffset = normalizeOffset(offset);
    const term = String(search || "").trim().toLowerCase();

    if (term) {
      const likeTerm = `%${term}%`;
      const rows = db.prepare(`
        SELECT *
        FROM signups
        WHERE LOWER(x_username) LIKE @term
           OR LOWER(x_user_id) LIKE @term
           OR LOWER(wallet_address) LIKE @term
           OR LOWER(email) LIKE @term
           OR LOWER(display_name) LIKE @term
           OR LOWER(discord_username) LIKE @term
           OR LOWER(telegram_username) LIKE @term
           OR LOWER(linkedin_url) LIKE @term
           OR EXISTS (
                SELECT 1
                FROM signup_social_accounts account
                WHERE account.signup_id = signups.id
                  AND (
                    LOWER(account.username) LIKE @term
                    OR LOWER(account.display_name) LIKE @term
                    OR LOWER(account.provider_user_id) LIKE @term
                  )
             )
        ORDER BY submitted_at DESC, updated_at DESC
        LIMIT @limit OFFSET @offset
      `).all({ term: likeTerm, limit: normalizedLimit, offset: normalizedOffset });
      const total = db.prepare(`
        SELECT COUNT(*) AS count
        FROM signups
        WHERE LOWER(x_username) LIKE @term
           OR LOWER(x_user_id) LIKE @term
           OR LOWER(wallet_address) LIKE @term
           OR LOWER(email) LIKE @term
           OR LOWER(display_name) LIKE @term
           OR LOWER(discord_username) LIKE @term
           OR LOWER(telegram_username) LIKE @term
           OR LOWER(linkedin_url) LIKE @term
           OR EXISTS (
                SELECT 1
                FROM signup_social_accounts account
                WHERE account.signup_id = signups.id
                  AND (
                    LOWER(account.username) LIKE @term
                    OR LOWER(account.display_name) LIKE @term
                    OR LOWER(account.provider_user_id) LIKE @term
                  )
             )
      `).get({ term: likeTerm }).count;
      return { rows, total, limit: normalizedLimit, offset: normalizedOffset };
    }

    const rows = db.prepare(`
      SELECT *
      FROM signups
      ORDER BY submitted_at DESC, updated_at DESC
      LIMIT @limit OFFSET @offset
    `).all({ limit: normalizedLimit, offset: normalizedOffset });
    return { rows, total: countAll.get().count, limit: normalizedLimit, offset: normalizedOffset };
  }

  function getStats() {
    return {
      signupCount: countAll.get().count,
      socialAccountCount: countSocialAccounts.get().count,
      socialVerificationCount: countSocialVerifications.get().count,
      latestSignupAt: db.prepare("SELECT MAX(submitted_at) AS value FROM signups").get().value || null
    };
  }

  function exportCsv() {
    const rows = db.prepare("SELECT * FROM signups ORDER BY submitted_at DESC").all();
    const lines = [CSV_COLUMNS.join(",")];
    for (const row of rows) {
      lines.push(CSV_COLUMNS.map((column) => escapeCsvValue(row[column])).join(","));
    }
    return `${lines.join("\n")}\n`;
  }

  return {
    saveSignup,
    findByXUserId,
    findByWalletAddress,
    listSignups,
    getStats,
    exportCsv,
    serializeSignup: getSerializedSignup
  };
}

module.exports = {
  createSignupStore,
  serializeSignup
};
