const crypto = require("node:crypto");
const { parseJsonObject, stringifyJsonObject } = require("./json-utils");

const SOCIAL_PROVIDER_ORDER = ["x", "discord", "telegram", "linkedin", "github", "youtube"];
const ADMIN_CSV_COLUMNS = [
  "signup_id",
  "submitted_at",
  "updated_at",
  "wallet_address",
  "wallet_chain_id",
  "x_user_id",
  "x_username",
  "x_display_name",
  "x_signed_in",
  "x_verification_badge",
  "x_follow_claimed",
  "discord_user_id",
  "discord_username",
  "discord_display_name",
  "discord_signed_in",
  "discord_server",
  "telegram_user_id",
  "telegram_username",
  "telegram_display_name",
  "telegram_signed_in",
  "telegram_group",
  "linkedin_user_id",
  "linkedin_display_name",
  "linkedin_signed_in",
  "linkedin_follow_claimed",
  "github_user_id",
  "github_username",
  "github_display_name",
  "github_signed_in",
  "github_starred_repo",
  "youtube_channel_id",
  "youtube_username",
  "youtube_display_name",
  "youtube_signed_in",
  "youtube_subscribed",
  "coinmarketcap_follow_claimed",
  "has_account_changes",
  "wallet_changed",
  "social_changed"
];

const MANUAL_CHECK_TYPES = new Set([
  "x_follow_manual",
  "linkedin_follow_manual",
  "coinmarketcap_follow_manual"
]);

const MANUAL_CLAIM_FILTERS = {
  x_follow_manual: { provider: "x", checkType: "x_follow_manual" },
  linkedin_follow_manual: { provider: "linkedin", checkType: "linkedin_follow_manual" },
  coinmarketcap_follow_manual: { provider: "coinMarketCap", checkType: "coinmarketcap_follow_manual" }
};

function serializeSocialVerification(row) {
  if (!row) return null;
  return {
    id: row.id,
    socialAccountId: row.social_account_id,
    checkType: row.check_type,
    targetId: row.target_id || "",
    status: row.status,
    checkedAt: row.checked_at,
    rawResult: parseJsonObject(row.raw_result_json),
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
    rawProfile: parseJsonObject(row.raw_profile_json),
    verifications,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializeAccountReplacement(row) {
  if (!row) return null;
  return {
    id: row.id,
    signupId: row.signup_id,
    accountType: row.account_type,
    provider: row.provider || "",
    oldProviderUserId: row.old_provider_user_id || "",
    newProviderUserId: row.new_provider_user_id || "",
    oldLabel: row.old_label || "",
    newLabel: row.new_label || "",
    authorizedWalletAddress: row.authorized_wallet_address || "",
    authorizedProvider: row.authorized_provider || "",
    authorizedProviderUserId: row.authorized_provider_user_id || "",
    ipAddress: row.ip_address || "",
    userAgent: row.user_agent || "",
    createdAt: row.created_at,
    rawContext: parseJsonObject(row.raw_context_json)
  };
}

function serializeSignup(row, { socialAccounts = [], replacementHistory = [] } = {}) {
  if (!row) return null;

  const verification = parseJsonObject(row.verification_json);

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
    replacementHistory,
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
  const rawText = String(value ?? "");
  const text = /^[=+\-@\t\r\n]/u.test(rawText) ? `'${rawText}` : rawText;
  if (!/[",\n\r]/u.test(text)) return text;
  return `"${text.replace(/"/gu, '""')}"`;
}

function normalizeSocialStatus(value) {
  const status = String(value || "unknown").trim().toLowerCase();
  return ["passed", "failed", "unknown", "claimed"].includes(status) ? status : "unknown";
}

function normalizeProviderOrder(provider) {
  const index = SOCIAL_PROVIDER_ORDER.indexOf(provider);
  return index === -1 ? SOCIAL_PROVIDER_ORDER.length : index;
}

function normalizeFilterValue(value) {
  return String(value || "").trim();
}

function normalizeFilterStatus(value) {
  const status = normalizeFilterValue(value).toLowerCase();
  return ["passed", "failed", "unknown", "claimed"].includes(status) ? status : "";
}

function normalizeDateBoundary(value, endOfDay = false) {
  const text = normalizeFilterValue(value);
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    return `${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
  }
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? "" : new Date(timestamp).toISOString();
}

function getSocialAccount(signup, provider) {
  const normalizedProvider = normalizeFilterValue(provider).toLowerCase();
  if (!normalizedProvider) return null;
  const account = (signup.socialAccounts || []).find((candidate) => candidate.provider === normalizedProvider);
  if (account) return account;
  if (normalizedProvider === "x" && signup.xUserId) {
    return {
      provider: "x",
      providerUserId: signup.xUserId,
      username: signup.xUsername || "",
      displayName: signup.xName || signup.xUsername || "",
      profileUrl: signup.xUsername ? `https://x.com/${signup.xUsername}` : "",
      verifications: []
    };
  }
  return null;
}

function getVerification(account, checkType) {
  if (!account || !checkType) return null;
  return (account.verifications || []).find((verification) => verification.checkType === checkType) || null;
}

function getCoinMarketCapClaim(signup) {
  const coinMarketCap = signup.verification?.coinMarketCap;
  if (!coinMarketCap?.followClaim?.claimed && !coinMarketCap?.opened) return null;
  return {
    checkType: "coinmarketcap_follow_manual",
    status: "claimed",
    checkedAt: coinMarketCap.followClaim?.claimedAt || signup.updatedAt || signup.submittedAt,
    rawResult: coinMarketCap.followClaim || {
      claimed: true,
      opened: true,
      source: "coinmarketcap_opened"
    }
  };
}

function getAllVerifications(signup) {
  const accountVerifications = (signup.socialAccounts || []).flatMap((account) => account.verifications || []);
  const coinMarketCapClaim = getCoinMarketCapClaim(signup);
  return coinMarketCapClaim ? [...accountVerifications, coinMarketCapClaim] : accountVerifications;
}

function getCheckStatus(signup, provider, checkType) {
  const account = getSocialAccount(signup, provider);
  const verification = getVerification(account, checkType);
  return verification?.status || "";
}

function getSignedInValue(signup, provider) {
  return getSocialAccount(signup, provider)?.providerUserId ? "yes" : "no";
}

function getMappedCheckValue(signup, provider, checkType, labels) {
  const status = getCheckStatus(signup, provider, checkType);
  if (status === "passed") return labels.passed;
  if (status === "failed") return labels.failed;
  if (status === "unknown") return "could_not_verify";
  return "missing";
}

function getManualClaim(signup, checkType) {
  if (checkType === "coinmarketcap_follow_manual") return getCoinMarketCapClaim(signup);
  const definition = MANUAL_CLAIM_FILTERS[checkType];
  if (!definition) return null;
  return getVerification(getSocialAccount(signup, definition.provider), definition.checkType);
}

function hasProvider(signup, provider) {
  const normalizedProvider = normalizeFilterValue(provider).toLowerCase();
  if (!normalizedProvider) return true;
  if (normalizedProvider === "coinmarketcap") return Boolean(getCoinMarketCapClaim(signup));
  return Boolean(getSocialAccount(signup, normalizedProvider)?.providerUserId);
}

function hasChangedAccount(signup, changedFilter) {
  const value = normalizeFilterValue(changedFilter).toLowerCase();
  if (!value) return true;
  const replacements = signup.replacementHistory || [];
  if (value === "any") return replacements.length > 0;
  if (value === "wallet") return replacements.some((replacement) => replacement.accountType === "wallet");
  if (value === "social") return replacements.some((replacement) => replacement.accountType === "social");
  return true;
}

function matchesCheckFilter(signup, checkType, checkStatus) {
  const normalizedCheckType = normalizeFilterValue(checkType);
  const normalizedStatus = normalizeFilterStatus(checkStatus);
  if (!normalizedCheckType && !normalizedStatus) return true;

  const verifications = normalizedCheckType
    ? getAllVerifications(signup).filter((verification) => verification.checkType === normalizedCheckType)
    : getAllVerifications(signup);

  if (!verifications.length) return false;
  if (!normalizedStatus) return true;
  return verifications.some((verification) => verification.status === normalizedStatus);
}

function matchesManualClaimFilter(signup, manualClaim) {
  const value = normalizeFilterValue(manualClaim);
  if (!value) return true;
  if (value === "any") {
    return [...MANUAL_CHECK_TYPES].some((checkType) => {
      const claim = getManualClaim(signup, checkType);
      return claim?.status === "claimed" || claim?.status === "passed";
    });
  }
  const claim = getManualClaim(signup, value);
  return claim?.status === "claimed" || claim?.status === "passed";
}

function matchesDateFilter(signup, submittedFrom, submittedTo) {
  const submittedAt = signup.submittedAt || "";
  if (submittedFrom && submittedAt < submittedFrom) return false;
  if (submittedTo && submittedAt > submittedTo) return false;
  return true;
}

function matchesAdminFilters(signup, filters = {}) {
  if (!hasProvider(signup, filters.provider)) return false;
  if (!matchesCheckFilter(signup, filters.checkType, filters.checkStatus)) return false;
  if (!matchesManualClaimFilter(signup, filters.manualClaim)) return false;
  if (!hasChangedAccount(signup, filters.changed)) return false;
  if (filters.status && signup.status !== filters.status) return false;
  return matchesDateFilter(
    signup,
    normalizeDateBoundary(filters.submittedFrom),
    normalizeDateBoundary(filters.submittedTo, true)
  );
}

function getAccountField(signup, provider, field) {
  const account = getSocialAccount(signup, provider);
  return account ? account[field] || "" : "";
}

function getManualClaimValue(signup, checkType) {
  const claim = getManualClaim(signup, checkType);
  return claim?.status === "claimed" || claim?.status === "passed" ? "claimed" : "missing";
}

function buildAdminCsvRow(signup) {
  const replacements = signup.replacementHistory || [];
  const hasWalletChanges = replacements.some((replacement) => replacement.accountType === "wallet");
  const hasSocialChanges = replacements.some((replacement) => replacement.accountType === "social");
  return {
    signup_id: signup.id,
    submitted_at: signup.submittedAt,
    updated_at: signup.updatedAt,
    wallet_address: signup.walletAddress,
    wallet_chain_id: signup.walletChainId,
    x_user_id: getAccountField(signup, "x", "providerUserId"),
    x_username: getAccountField(signup, "x", "username"),
    x_display_name: getAccountField(signup, "x", "displayName"),
    x_signed_in: getSignedInValue(signup, "x"),
    x_verification_badge: getMappedCheckValue(signup, "x", "x_verified", {
      passed: "verified",
      failed: "not_verified"
    }),
    x_follow_claimed: getManualClaimValue(signup, "x_follow_manual"),
    discord_user_id: getAccountField(signup, "discord", "providerUserId"),
    discord_username: getAccountField(signup, "discord", "username"),
    discord_display_name: getAccountField(signup, "discord", "displayName"),
    discord_signed_in: getSignedInValue(signup, "discord"),
    discord_server: getMappedCheckValue(signup, "discord", "discord_guild_member", {
      passed: "joined",
      failed: "not_joined"
    }),
    telegram_user_id: getAccountField(signup, "telegram", "providerUserId"),
    telegram_username: getAccountField(signup, "telegram", "username"),
    telegram_display_name: getAccountField(signup, "telegram", "displayName"),
    telegram_signed_in: getSignedInValue(signup, "telegram"),
    telegram_group: getMappedCheckValue(signup, "telegram", "telegram_group_member", {
      passed: "joined",
      failed: "not_joined"
    }),
    linkedin_user_id: getAccountField(signup, "linkedin", "providerUserId"),
    linkedin_display_name: getAccountField(signup, "linkedin", "displayName"),
    linkedin_signed_in: getSignedInValue(signup, "linkedin"),
    linkedin_follow_claimed: getManualClaimValue(signup, "linkedin_follow_manual"),
    github_user_id: getAccountField(signup, "github", "providerUserId"),
    github_username: getAccountField(signup, "github", "username"),
    github_display_name: getAccountField(signup, "github", "displayName"),
    github_signed_in: getSignedInValue(signup, "github"),
    github_starred_repo: getMappedCheckValue(signup, "github", "github_repo_starred", {
      passed: "starred",
      failed: "not_starred"
    }),
    youtube_channel_id: getAccountField(signup, "youtube", "providerUserId"),
    youtube_username: getAccountField(signup, "youtube", "username"),
    youtube_display_name: getAccountField(signup, "youtube", "displayName"),
    youtube_signed_in: getSignedInValue(signup, "youtube"),
    youtube_subscribed: getMappedCheckValue(signup, "youtube", "youtube_channel_subscribed", {
      passed: "subscribed",
      failed: "not_subscribed"
    }),
    coinmarketcap_follow_claimed: getManualClaimValue(signup, "coinmarketcap_follow_manual"),
    has_account_changes: replacements.length ? "yes" : "no",
    wallet_changed: hasWalletChanges ? "yes" : "no",
    social_changed: hasSocialChanges ? "yes" : "no"
  };
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

  const updateSignupStatement = db.prepare(`
    UPDATE signups
    SET
      x_user_id = @xUserId,
      x_username = @xUsername,
      x_name = @xName,
      x_profile_image_url = @xProfileImageUrl,
      wallet_address = @walletAddress,
      wallet_chain_id = @walletChainId,
      signed_message = @signedMessage,
      signature = @signature,
      display_name = @displayName,
      email = @email,
      country = @country,
      interest = @interest,
      discord_username = @discordUsername,
      telegram_username = @telegramUsername,
      linkedin_url = @linkedinUrl,
      notes = @notes,
      verification_json = @verificationJson,
      status = @status,
      user_agent = @userAgent,
      ip_address = @ipAddress,
      submitted_at = @submittedAt,
      updated_at = @updatedAt
    WHERE id = @id
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

  const insertAccountReplacement = db.prepare(`
    INSERT INTO signup_account_replacements (
      id,
      signup_id,
      account_type,
      provider,
      old_provider_user_id,
      new_provider_user_id,
      old_label,
      new_label,
      authorized_wallet_address,
      authorized_provider,
      authorized_provider_user_id,
      ip_address,
      user_agent,
      created_at,
      raw_context_json
    ) VALUES (
      @id,
      @signupId,
      @accountType,
      @provider,
      @oldProviderUserId,
      @newProviderUserId,
      @oldLabel,
      @newLabel,
      @authorizedWalletAddress,
      @authorizedProvider,
      @authorizedProviderUserId,
      @ipAddress,
      @userAgent,
      @createdAt,
      @rawContextJson
    )
  `);

  const getById = db.prepare("SELECT * FROM signups WHERE id = ?");
  const getByXUserId = db.prepare("SELECT * FROM signups WHERE x_user_id = ?");
  const getByWalletAddress = db.prepare("SELECT * FROM signups WHERE LOWER(wallet_address) = LOWER(?)");
  const getBySocialAccount = db.prepare(`
    SELECT signups.*
    FROM signup_social_accounts account
    JOIN signups ON signups.id = account.signup_id
    WHERE account.provider = ?
      AND account.provider_user_id = ?
  `);
  const getSocialAccountsBySignupId = db.prepare("SELECT * FROM signup_social_accounts WHERE signup_id = ?");
  const getSocialVerificationsByAccountId = db.prepare(`
    SELECT *
    FROM signup_social_verifications
    WHERE social_account_id = ?
    ORDER BY checked_at DESC, created_at DESC
  `);
  const getAccountReplacementsBySignupId = db.prepare(`
    SELECT *
    FROM signup_account_replacements
    WHERE signup_id = ?
    ORDER BY created_at DESC
  `);
  const countAll = db.prepare("SELECT COUNT(*) AS count FROM signups");
  const countSocialAccounts = db.prepare("SELECT COUNT(*) AS count FROM signup_social_accounts");
  const countSocialVerifications = db.prepare("SELECT COUNT(*) AS count FROM signup_social_verifications");
  const countAccountReplacements = db.prepare("SELECT COUNT(*) AS count FROM signup_account_replacements");
  const deleteSocialVerificationsBySignupId = db.prepare(`
    DELETE FROM signup_social_verifications
    WHERE social_account_id IN (
      SELECT id
      FROM signup_social_accounts
      WHERE signup_id = ?
    )
  `);
  const deleteSocialAccountsBySignupId = db.prepare("DELETE FROM signup_social_accounts WHERE signup_id = ?");

  function getSerializedSignup(row) {
    if (!row) return null;
    const socialAccounts = getSocialAccountsBySignupId.all(row.id)
      .sort((left, right) => {
        const order = normalizeProviderOrder(left.provider) - normalizeProviderOrder(right.provider);
        return order || left.provider.localeCompare(right.provider);
      })
      .map((account) => serializeSocialAccount(account, getSocialVerificationsByAccountId.all(account.id).map(serializeSocialVerification)));
    const replacementHistory = getAccountReplacementsBySignupId.all(row.id).map(serializeAccountReplacement);
    return serializeSignup(row, { socialAccounts, replacementHistory });
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
        rawProfileJson: stringifyJsonObject(account.rawProfile),
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
          rawResultJson: stringifyJsonObject(verification.rawResult),
          createdAt: verification.createdAt || now
        });
      }
    }
  }

  function saveAccountReplacements(signupId, replacements = []) {
    for (const replacement of replacements) {
      const accountType = String(replacement.accountType || "").trim().toLowerCase();
      if (!accountType) continue;
      const now = replacement.createdAt || new Date().toISOString();
      insertAccountReplacement.run({
        id: replacement.id || crypto.randomUUID(),
        signupId,
        accountType,
        provider: String(replacement.provider || "").trim().toLowerCase(),
        oldProviderUserId: String(replacement.oldProviderUserId || "").trim(),
        newProviderUserId: String(replacement.newProviderUserId || "").trim(),
        oldLabel: String(replacement.oldLabel || "").trim(),
        newLabel: String(replacement.newLabel || "").trim(),
        authorizedWalletAddress: String(replacement.authorizedWalletAddress || "").trim(),
        authorizedProvider: String(replacement.authorizedProvider || "").trim().toLowerCase(),
        authorizedProviderUserId: String(replacement.authorizedProviderUserId || "").trim(),
        ipAddress: String(replacement.ipAddress || "").trim(),
        userAgent: String(replacement.userAgent || "").trim(),
        createdAt: now,
        rawContextJson: stringifyJsonObject(replacement.rawContext)
      });
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

  const updateSignupTransaction = db.transaction((input) => {
    const { socialAccounts = [], accountReplacements = [], ...signupInput } = input;
    updateSignupStatement.run({
      ...signupInput,
      xUserId: signupInput.xUserId || null,
      xUsername: signupInput.xUsername || "",
      xName: signupInput.xName || "",
      xProfileImageUrl: signupInput.xProfileImageUrl || "",
      displayName: signupInput.displayName || "",
      email: signupInput.email || "",
      country: signupInput.country || "",
      interest: signupInput.interest || "",
      discordUsername: signupInput.discordUsername || "",
      telegramUsername: signupInput.telegramUsername || "",
      linkedinUrl: signupInput.linkedinUrl || "",
      notes: signupInput.notes || ""
    });
    deleteSocialVerificationsBySignupId.run(input.id);
    deleteSocialAccountsBySignupId.run(input.id);
    saveSocialAccounts(input.id, socialAccounts);
    saveAccountReplacements(input.id, accountReplacements);
    return getById.get(input.id);
  });

  function updateSignup(input) {
    return getSerializedSignup(updateSignupTransaction(input));
  }

  function findById(id) {
    const value = String(id || "").trim();
    return value ? getById.get(value) || null : null;
  }

  function findByXUserId(xUserId) {
    const value = String(xUserId || "").trim();
    return value ? getByXUserId.get(value) || null : null;
  }

  function findByWalletAddress(walletAddress) {
    const value = String(walletAddress || "").trim();
    return value ? getByWalletAddress.get(value) || null : null;
  }

  function findBySocialAccount(provider, providerUserId) {
    const normalizedProvider = String(provider || "").trim().toLowerCase();
    const normalizedProviderUserId = String(providerUserId || "").trim();
    if (!normalizedProvider || !normalizedProviderUserId) return null;
    return getBySocialAccount.get(normalizedProvider, normalizedProviderUserId) || null;
  }

  function getSearchedSignupRows(search = "") {
    const term = String(search || "").trim().toLowerCase();

    if (!term) {
      return db.prepare(`
        SELECT *
        FROM signups
        ORDER BY submitted_at DESC, updated_at DESC
      `).all();
    }

    const likeTerm = `%${term}%`;
    return db.prepare(`
      SELECT *
      FROM signups
      WHERE LOWER(id) LIKE @term
         OR LOWER(x_username) LIKE @term
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
                  LOWER(account.provider) LIKE @term
                  OR LOWER(account.username) LIKE @term
                  OR LOWER(account.display_name) LIKE @term
                  OR LOWER(account.provider_user_id) LIKE @term
                  OR LOWER(account.profile_url) LIKE @term
                )
           )
      ORDER BY submitted_at DESC, updated_at DESC
    `).all({ term: likeTerm });
  }

  function getFilteredSerializedSignups(filters = {}) {
    return getSearchedSignupRows(filters.search)
      .map(getSerializedSignup)
      .filter((signup) => matchesAdminFilters(signup, filters));
  }

  function listSignups(filters = {}) {
    const normalizedLimit = normalizeLimit(filters.limit);
    const normalizedOffset = normalizeOffset(filters.offset);
    const signups = getFilteredSerializedSignups(filters);
    return {
      signups: signups.slice(normalizedOffset, normalizedOffset + normalizedLimit),
      total: signups.length,
      limit: normalizedLimit,
      offset: normalizedOffset
    };
  }

  function getStats() {
    return {
      signupCount: countAll.get().count,
      socialAccountCount: countSocialAccounts.get().count,
      socialVerificationCount: countSocialVerifications.get().count,
      accountReplacementCount: countAccountReplacements.get().count,
      latestSignupAt: db.prepare("SELECT MAX(submitted_at) AS value FROM signups").get().value || null
    };
  }

  function exportCsv(filters = {}) {
    const signups = getFilteredSerializedSignups(filters);
    const lines = [ADMIN_CSV_COLUMNS.join(",")];
    for (const signup of signups) {
      const row = buildAdminCsvRow(signup);
      lines.push(ADMIN_CSV_COLUMNS.map((column) => escapeCsvValue(row[column])).join(","));
    }
    return `${lines.join("\n")}\n`;
  }

  return {
    saveSignup,
    updateSignup,
    findById,
    findByXUserId,
    findByWalletAddress,
    findBySocialAccount,
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
