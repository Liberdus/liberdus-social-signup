const { parseJsonObject } = require("./json-utils");

const REQUIRED_SOCIAL_PROVIDER_IDS = ["x", "telegram", "discord", "linkedin"];
const SNAPSHOT_PROVIDERS = ["discord", "telegram", "linkedin", "github", "youtube"];
const MANUAL_CLAIM_KEY = "followClaim";

function getProviderLabel(provider) {
  return ({
    x: "X",
    discord: "Discord",
    telegram: "Telegram",
    linkedin: "LinkedIn",
    github: "GitHub",
    youtube: "YouTube"
  })[provider] || provider;
}

// A submit can discover the same existing signup through multiple routes, such
// as the loaded wallet session and the current wallet address. Collapse those
// matches before deciding whether accounts point at conflicting signups.
function getDistinctExistingSignups(signups = []) {
  const byId = new Map();
  for (const signup of signups) {
    if (signup?.id) byId.set(signup.id, signup);
  }
  return [...byId.values()];
}

// Only these first-class identity providers satisfy the required social gate.
// Link-only or reward-only providers like GitHub, YouTube, and CMC stay outside
// this rule even though they can still be saved for rewards.
function hasRequiredSocialAccount(accounts = []) {
  return accounts.some((account) => REQUIRED_SOCIAL_PROVIDER_IDS.includes(account.provider) && account.providerUserId);
}

// Loaded signups may arrive as camelCase serialized objects, while direct DB
// rows use snake_case. Accept both so the rule stays independent of call site.
function signupHasRequiredSocial(signup) {
  return Boolean(
    signup?.xUserId
    || signup?.x_user_id
    || (signup?.socialAccounts || []).some((account) => REQUIRED_SOCIAL_PROVIDER_IDS.includes(account.provider) && account.providerUserId)
  );
}

// X existed before the normalized social account table, so conflict checks need
// to look in both the social account rows and the legacy x_user_id column.
function findSocialAccountOwner(signupStore, account) {
  if (!signupStore || !account?.provider || !account?.providerUserId) return null;
  if (account.provider === "x") {
    return signupStore.findBySocialAccount(account.provider, account.providerUserId)
      || signupStore.findByXUserId(account.providerUserId);
  }
  return signupStore.findBySocialAccount(account.provider, account.providerUserId);
}

// Return the first provider account that belongs to another signup. The caller
// turns this into an HTTP 409, but the pure rule remains easy to unit test.
function findSocialConflict(signupStore, accounts = [], targetSignupId = "") {
  for (const account of accounts) {
    const owner = findSocialAccountOwner(signupStore, account);
    if (owner?.id && owner.id !== targetSignupId) {
      return { account, owner, message: `This ${getProviderLabel(account.provider)} account is already linked to another signup.` };
    }
  }
  return null;
}

function getSignupVerification(signup) {
  if (!signup) return {};
  return signup.verification && typeof signup.verification === "object"
    ? signup.verification
    : parseJsonObject(signup.verification_json);
}

// Updating an existing signup should not erase saved provider checks just
// because the browser does not currently have that provider's OAuth session.
// Fresh sessions replace their own provider snapshot; disconnected providers
// keep their last saved verification state.
function mergeVerification(existingSignup, currentVerification, { hasXSession } = {}) {
  if (!existingSignup) return currentVerification;
  const existing = getSignupVerification(existingSignup);
  const mergeManualClaim = (baseProvider = {}, savedProvider = {}, currentProvider = {}) => {
    const claim = currentProvider?.[MANUAL_CLAIM_KEY]?.claimed
      ? currentProvider[MANUAL_CLAIM_KEY]
      : savedProvider?.[MANUAL_CLAIM_KEY]?.claimed
        ? savedProvider[MANUAL_CLAIM_KEY]
        : null;
    if (!claim) return baseProvider;
    return {
      ...baseProvider,
      [MANUAL_CLAIM_KEY]: claim
    };
  };
  const merged = {
    ...existing,
    ...currentVerification,
    x: mergeManualClaim(
      hasXSession ? currentVerification.x : existing.x || currentVerification.x,
      existing.x,
      currentVerification.x
    ),
    coinMarketCap: {
      ...(existing.coinMarketCap || {}),
      ...currentVerification.coinMarketCap,
      opened: Boolean(existing.coinMarketCap?.opened || currentVerification.coinMarketCap?.opened),
      ...(currentVerification.coinMarketCap?.[MANUAL_CLAIM_KEY]?.claimed
        ? { [MANUAL_CLAIM_KEY]: currentVerification.coinMarketCap[MANUAL_CLAIM_KEY] }
        : existing.coinMarketCap?.[MANUAL_CLAIM_KEY]
          ? { [MANUAL_CLAIM_KEY]: existing.coinMarketCap[MANUAL_CLAIM_KEY] }
          : {})
    }
  };

  for (const provider of SNAPSHOT_PROVIDERS) {
    if (!currentVerification[provider]?.connected && existing[provider]) {
      merged[provider] = mergeManualClaim(existing[provider], existing[provider], currentVerification[provider]);
    } else if (currentVerification[provider]?.[MANUAL_CLAIM_KEY]?.claimed) {
      merged[provider] = mergeManualClaim(merged[provider], existing[provider], currentVerification[provider]);
    }
  }

  return merged;
}

// Account replacement is provider-scoped: reconnecting Discord replaces the
// saved Discord account, while saved Telegram/GitHub/etc. remain attached.
function mergeSocialAccounts(existingAccounts = [], currentAccounts = []) {
  const byProvider = new Map();
  for (const account of existingAccounts) {
    if (account?.provider && account?.providerUserId) byProvider.set(account.provider, account);
  }
  for (const account of currentAccounts) {
    if (account?.provider && account?.providerUserId) byProvider.set(account.provider, account);
  }
  return [...byProvider.values()];
}

// Summary columns are legacy/admin conveniences. Prefer fresh connected values,
// but keep the previous summary when a provider was not reconnected.
function getOptionalSummaryValue(value, fallback = "") {
  const normalized = String(value || "").trim();
  return normalized || fallback || undefined;
}

module.exports = {
  REQUIRED_SOCIAL_PROVIDER_IDS,
  parseJsonObject,
  getProviderLabel,
  getDistinctExistingSignups,
  hasRequiredSocialAccount,
  signupHasRequiredSocial,
  findSocialAccountOwner,
  findSocialConflict,
  mergeVerification,
  mergeSocialAccounts,
  getOptionalSummaryValue
};
