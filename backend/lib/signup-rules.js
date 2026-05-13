const REQUIRED_SOCIAL_PROVIDER_IDS = ["x", "telegram", "discord", "linkedin"];
const SNAPSHOT_PROVIDERS = ["discord", "telegram", "linkedin", "github", "youtube"];

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

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

function getDistinctExistingSignups(signups = []) {
  const byId = new Map();
  for (const signup of signups) {
    if (signup?.id) byId.set(signup.id, signup);
  }
  return [...byId.values()];
}

function hasRequiredSocialAccount(accounts = []) {
  return accounts.some((account) => REQUIRED_SOCIAL_PROVIDER_IDS.includes(account.provider) && account.providerUserId);
}

function signupHasRequiredSocial(signup) {
  return Boolean(
    signup?.xUserId
    || signup?.x_user_id
    || (signup?.socialAccounts || []).some((account) => REQUIRED_SOCIAL_PROVIDER_IDS.includes(account.provider) && account.providerUserId)
  );
}

function findSocialAccountOwner(signupStore, account) {
  if (!signupStore || !account?.provider || !account?.providerUserId) return null;
  if (account.provider === "x") {
    return signupStore.findBySocialAccount(account.provider, account.providerUserId)
      || signupStore.findByXUserId(account.providerUserId);
  }
  return signupStore.findBySocialAccount(account.provider, account.providerUserId);
}

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

function mergeVerification(existingSignup, currentVerification, { hasXSession } = {}) {
  if (!existingSignup) return currentVerification;
  const existing = getSignupVerification(existingSignup);
  const merged = {
    ...existing,
    ...currentVerification,
    x: hasXSession ? currentVerification.x : existing.x || currentVerification.x,
    coinMarketCap: {
      ...(existing.coinMarketCap || {}),
      ...currentVerification.coinMarketCap,
      opened: Boolean(existing.coinMarketCap?.opened || currentVerification.coinMarketCap?.opened)
    }
  };

  for (const provider of SNAPSHOT_PROVIDERS) {
    if (!currentVerification[provider]?.connected && existing[provider]) {
      merged[provider] = existing[provider];
    }
  }

  return merged;
}

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
