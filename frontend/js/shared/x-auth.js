import { X_AUTH_SESSION_KEY } from "./constants.js";

const SESSION_EXPIRY_WINDOW_MS = 60_000;
const AUTH_COMPLETE_QUERY_PARAM = "x_auth";
const AUTH_COMPLETE_QUERY_VALUE = "complete";
const AUTH_ERROR_QUERY_PARAM = "x_error";

function getSessionStorage() {
  if (!window.sessionStorage) {
    throw new Error("This browser does not support sessionStorage.");
  }

  return window.sessionStorage;
}

function readSessionJson(key) {
  try {
    const storage = getSessionStorage();
    const rawValue = storage.getItem(key);
    return rawValue ? JSON.parse(rawValue) : null;
  } catch {
    return null;
  }
}

function writeSessionJson(key, value) {
  const storage = getSessionStorage();
  storage.setItem(key, JSON.stringify(value));
}

function removeSessionValue(key) {
  try {
    getSessionStorage().removeItem(key);
  } catch {
    // Ignore storage cleanup failures.
  }
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function describeErrorPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return "Unexpected response from the signup backend.";
  }

  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error.trim();
  }

  if (typeof payload.detail === "string" && payload.detail.trim()) {
    return payload.detail.trim();
  }

  return "Unexpected response from the signup backend.";
}

function cleanupAuthQueryParams() {
  const currentUrl = new URL(window.location.href);
  [AUTH_COMPLETE_QUERY_PARAM, AUTH_ERROR_QUERY_PARAM].forEach((key) => {
    currentUrl.searchParams.delete(key);
  });
  window.history.replaceState({}, document.title, currentUrl.toString());
}

function getNormalizedXAuthConfig(config = {}) {
  const xAuth = config?.xAuth && typeof config.xAuth === "object" ? config.xAuth : {};
  return {
    enabled: xAuth.enabled !== false,
    backendUrl: String(xAuth.backendUrl || "").trim().replace(/\/+$/u, ""),
    redirectUri: String(xAuth.redirectUri || "").trim() || `${window.location.origin}${window.location.pathname.replace(/index\.html$/u, "")}`,
  };
}

function normalizeProfile(payload) {
  const user = payload?.data || payload;
  if (!user?.id || !user?.username) {
    throw new Error("X did not return a valid user profile.");
  }

  return {
    id: String(user.id),
    name: String(user.name || user.username),
    username: String(user.username),
    profileImageUrl: String(user.profile_image_url || user.profileImageUrl || ""),
    verified: Boolean(user.verified),
    verifiedType: String(user.verified_type || user.verifiedType || ""),
  };
}

function normalizeAccount(account) {
  if (!account || typeof account !== "object") {
    return null;
  }

  return {
    id: Number(account.id || 0) || null,
    xUserId: String(account.xUserId || "").trim(),
    username: String(account.username || "").trim(),
    walletAddress: String(account.walletAddress || "").trim(),
    walletSource: String(account.walletSource || "").trim(),
    isFollower: Boolean(account.isFollower),
    needsRecovery: Boolean(account.needsRecovery),
    firstSeenFollowingAt: account.firstSeenFollowingAt || null,
    lastSeenFollowingAt: account.lastSeenFollowingAt || null,
    snapshotsSeenCount: Number(account.snapshotsSeenCount || 0),
  };
}

function normalizeExistingSubmission(submission) {
  if (!submission || typeof submission !== "object") {
    return null;
  }

  return {
    id: String(submission.id || "").trim(),
    xUserId: String(submission.xUserId || "").trim(),
    usernameAtSubmission: String(submission.usernameAtSubmission || "").trim(),
    walletAddress: String(submission.walletAddress || "").trim(),
    wasKnownFollower: Boolean(submission.wasKnownFollower),
    wasRecoveryCandidate: Boolean(submission.wasRecoveryCandidate),
    status: String(submission.status || "").trim(),
    submittedAt: submission.submittedAt || null,
  };
}

function normalizeSignup(signup) {
  if (!signup || typeof signup !== "object") {
    return null;
  }

  return {
    id: String(signup.id || "").trim(),
    xUserId: String(signup.xUserId || "").trim(),
    xUsername: String(signup.xUsername || "").trim(),
    xName: String(signup.xName || "").trim(),
    xProfileImageUrl: String(signup.xProfileImageUrl || "").trim(),
    walletAddress: String(signup.walletAddress || "").trim(),
    walletChainId: Number(signup.walletChainId || 0) || null,
    discordUsername: String(signup.discordUsername || "").trim(),
    telegramUsername: String(signup.telegramUsername || "").trim(),
    linkedinUrl: String(signup.linkedinUrl || "").trim(),
    verification: signup.verification && typeof signup.verification === "object" ? signup.verification : {},
    socialAccounts: Array.isArray(signup.socialAccounts) ? signup.socialAccounts : [],
    status: String(signup.status || "").trim(),
    submittedAt: signup.submittedAt || null,
    updatedAt: signup.updatedAt || null,
  };
}

function buildSession(result, profile, previousSession = null) {
  const previousLinkResult = previousSession?.profile?.id === profile.id ? previousSession.linkResult || null : null;
  const previousAccount = previousSession?.profile?.id === profile.id ? previousSession.account || null : null;
  const previousExistingSubmission = previousSession?.profile?.id === profile.id
    ? previousSession.existingSubmission || null
    : null;
  const previousExistingSignup = previousSession?.profile?.id === profile.id
    ? previousSession.existingSignup || null
    : null;
  const hasAccountField = Object.prototype.hasOwnProperty.call(result || {}, "account");
  const hasExistingSubmissionField = Object.prototype.hasOwnProperty.call(result || {}, "existingSubmission");
  const hasExistingSignupField = Object.prototype.hasOwnProperty.call(result || {}, "existingSignup");
  return {
    expiresAt: result?.expiresAt || null,
    csrfToken: String(result?.csrfToken || ""),
    profile,
    authenticatedAt: result?.authenticatedAt || new Date().toISOString(),
    account: hasAccountField ? normalizeAccount(result.account) : previousAccount,
    existingSubmission: hasExistingSubmissionField
      ? normalizeExistingSubmission(result.existingSubmission)
      : previousExistingSubmission,
    existingSignup: hasExistingSignupField
      ? normalizeSignup(result.existingSignup)
      : previousExistingSignup,
    linkResult: previousLinkResult,
  };
}

async function fetchBackendSession(backendUrl, { required = false } = {}) {
  const response = await fetch(`${backendUrl}/api/x/session`, {
    credentials: "include",
    cache: "no-store",
  });

  const payload = await parseJsonResponse(response);
  if (response.status === 401) {
    if (required) {
      throw new Error(`X sign-in failed: ${describeErrorPayload(payload)}`);
    }
    return null;
  }

  if (!response.ok) {
    throw new Error(`X sign-in failed: ${describeErrorPayload(payload)}`);
  }

  if (!payload?.profile?.username || !payload?.csrfToken) {
    throw new Error("X sign-in failed: missing authenticated X profile.");
  }

  return payload;
}

export function getXSession() {
  const session = readSessionJson(X_AUTH_SESSION_KEY);
  if (!session?.profile?.username || !session?.csrfToken) {
    return null;
  }

  return session;
}

export function clearXSession() {
  removeSessionValue(X_AUTH_SESSION_KEY);
}

export function saveXSession(session) {
  if (!session) {
    clearXSession();
    return;
  }

  writeSessionJson(X_AUTH_SESSION_KEY, session);
}

export function isXSessionExpired(session = getXSession()) {
  if (!session?.expiresAt) {
    return false;
  }

  return Date.now() >= (Number(session.expiresAt) - SESSION_EXPIRY_WINDOW_MS);
}

export function isXAuthConfigured(config = {}) {
  const xAuth = getNormalizedXAuthConfig(config);
  return xAuth.enabled && Boolean(xAuth.backendUrl);
}

export async function startXLogin(config = {}) {
  const xAuth = getNormalizedXAuthConfig(config);
  if (!xAuth.enabled || !xAuth.backendUrl) {
    throw new Error("X sign-in is not configured.");
  }

  const startUrl = new URL(`${xAuth.backendUrl}/api/x/start`);
  startUrl.searchParams.set("return_uri", xAuth.redirectUri);
  window.location.assign(startUrl.toString());
}

export async function logoutXSession(config = {}, session = getXSession()) {
  const xAuth = getNormalizedXAuthConfig(config);
  const csrfToken = String(session?.csrfToken || "").trim();

  if (xAuth.enabled && xAuth.backendUrl && csrfToken) {
    await fetch(`${xAuth.backendUrl}/api/x/logout`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: "{}",
    }).catch(() => null);
  }

  clearXSession();
}

export async function completeXLoginIfPresent(config = {}) {
  const params = new URLSearchParams(window.location.search);
  const hasCompletionSignal = params.get(AUTH_COMPLETE_QUERY_PARAM) === AUTH_COMPLETE_QUERY_VALUE;
  const authError = params.get(AUTH_ERROR_QUERY_PARAM);
  const handled = hasCompletionSignal || Boolean(authError);
  const previousSession = getXSession();

  try {
    if (authError) {
      throw new Error(authError);
    }

    const xAuth = getNormalizedXAuthConfig(config);
    if (!xAuth.enabled || !xAuth.backendUrl) {
      return {
        handled,
        session: previousSession,
      };
    }

    if (!hasCompletionSignal && !previousSession) {
      return {
        handled,
        session: null,
      };
    }

    const authResult = await fetchBackendSession(xAuth.backendUrl, { required: hasCompletionSignal });
    if (!authResult) {
      clearXSession();
      return {
        handled,
        session: null,
      };
    }

    const profile = normalizeProfile(authResult.profile);
    const session = buildSession(authResult, profile, previousSession);
    saveXSession(session);

    return {
      handled,
      session,
    };
  } finally {
    if (handled) {
      cleanupAuthQueryParams();
    }
  }
}
