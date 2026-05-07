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

function serializeSignup(row) {
  if (!row) return null;

  let verification = {};
  try {
    verification = JSON.parse(row.verification_json || "{}");
  } catch {
    verification = {};
  }

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

  const getById = db.prepare("SELECT * FROM signups WHERE id = ?");
  const getByXUserId = db.prepare("SELECT * FROM signups WHERE x_user_id = ?");
  const getByWalletAddress = db.prepare("SELECT * FROM signups WHERE LOWER(wallet_address) = LOWER(?)");
  const countAll = db.prepare("SELECT COUNT(*) AS count FROM signups");

  function saveSignup(input) {
    insertSignup.run(input);
    return getById.get(input.id);
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
    serializeSignup
  };
}

module.exports = {
  createSignupStore,
  serializeSignup
};
