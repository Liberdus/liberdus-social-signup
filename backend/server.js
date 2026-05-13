const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");

const dotenv = require("dotenv");
const { ethers } = require("ethers");
const { openDatabase, getDatabasePath } = require("./lib/db");
const { createHttpUtils } = require("./lib/http-utils");
const { createSignupStore } = require("./lib/signup-store");
const { createSocialProviders } = require("./lib/social");
const {
  getDistinctExistingSignups,
  getOptionalSummaryValue,
  getProviderLabel,
  hasRequiredSocialAccount,
  signupHasRequiredSocial,
  findSocialConflict,
  mergeSocialAccounts,
  mergeVerification
} = require("./lib/signup-rules");

dotenv.config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const HOST = process.env.SIGNUP_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.SIGNUP_PORT || "8788", 10);
const DEFAULT_ALLOWED_ORIGIN = "http://127.0.0.1:5503";
const DEFAULT_FRONTEND_RETURN_URL = "http://127.0.0.1:5503/frontend/";
const SIGNUP_BROWSER_COOKIE_NAME = "liberdus_signup_browser_session";
const SIGNUP_BROWSER_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_JSON_BODY_BYTES = 64 * 1024;

const {
  HttpError,
  createRandomToken,
  secureEquals,
  getAllowedOrigins,
  getDefaultFrontendReturnUrl,
  getAllowedReturnUrls,
  validateReturnUri,
  shouldUseSecureCookies,
  parseCookies,
  setCookie,
  clearCookie,
  setStandardHeaders,
  requireAllowedOrigin,
  writeJson,
  writeText,
  redirect,
  readJsonRequest,
  handleOptions,
  getPublicErrorMessage,
  handleError
} = createHttpUtils({
  defaultAllowedOrigin: DEFAULT_ALLOWED_ORIGIN,
  defaultFrontendReturnUrl: DEFAULT_FRONTEND_RETURN_URL,
  maxJsonBodyBytes: MAX_JSON_BODY_BYTES
});

const signupBrowserSessions = new Map();
const signupChallenges = new Map();
const adminSessions = new Map();
let socialProviders;

const db = openDatabase();
const signupStore = createSignupStore(db);

function isE2ETestMode() {
  return /^(1|true|yes)$/iu.test(String(process.env.E2E_TEST_MODE || "").trim());
}

function pruneExpiredState() {
  const now = Date.now();
  socialProviders?.pruneExpired(now);
  for (const [key, session] of signupBrowserSessions.entries()) {
    if (session.expiresAtMs <= now) signupBrowserSessions.delete(key);
  }
  for (const [key, challenge] of signupChallenges.entries()) {
    if (challenge.expiresAtMs <= now) signupChallenges.delete(key);
  }
  for (const [key, session] of adminSessions.entries()) {
    if (session.expiresAtMs <= now) adminSessions.delete(key);
  }
}

function createSignupBrowserSession(response) {
  const sessionId = createRandomToken();
  const now = new Date().toISOString();
  const session = {
    sessionId,
    createdAt: now,
    updatedAt: now,
    walletProof: null,
    expiresAtMs: Date.now() + SIGNUP_BROWSER_SESSION_TTL_MS
  };
  signupBrowserSessions.set(sessionId, session);
  setCookie(response, SIGNUP_BROWSER_COOKIE_NAME, sessionId, {
    path: "/api/",
    maxAge: SIGNUP_BROWSER_SESSION_TTL_MS / 1000,
    httpOnly: true,
    sameSite: "Lax",
    secure: shouldUseSecureCookies()
  });
  return session;
}

function getSignupBrowserSession(request, response) {
  pruneExpiredState();
  const sessionId = parseCookies(request)[SIGNUP_BROWSER_COOKIE_NAME];
  const existing = sessionId ? signupBrowserSessions.get(sessionId) : null;
  if (existing) {
    existing.expiresAtMs = Date.now() + SIGNUP_BROWSER_SESSION_TTL_MS;
    existing.updatedAt = new Date().toISOString();
    return existing;
  }
  return createSignupBrowserSession(response);
}

function requireSignupBrowserSession(request) {
  pruneExpiredState();
  const sessionId = parseCookies(request)[SIGNUP_BROWSER_COOKIE_NAME];
  const existing = sessionId ? signupBrowserSessions.get(sessionId) : null;
  if (!existing) {
    throw new HttpError(403, "Signup session expired. Reload the page and try again.");
  }
  existing.expiresAtMs = Date.now() + SIGNUP_BROWSER_SESSION_TTL_MS;
  existing.updatedAt = new Date().toISOString();
  return existing;
}

function requireWalletAddress(value) {
  if (!ethers.isAddress(value)) throw new HttpError(400, "Wallet address is invalid.");
  return ethers.getAddress(value);
}

function normalizeText(value, maxLength) {
  const text = String(value || "").trim();
  return text.slice(0, maxLength);
}

function buildWalletSignupMessage({ profile, walletAddress, challengeId, issuedAt }) {
  const lines = [
    "Liberdus Social Rewards Signup",
    "",
    "Sign this message to prove wallet ownership for your rewards signup.",
    "This does not authorize a transaction or spend tokens.",
    "",
    `Wallet: ${walletAddress}`,
    `Challenge: ${challengeId}`,
    `Issued At: ${issuedAt}`
  ];
  if (profile?.id && profile?.username) {
    lines.splice(5, 0, `X Account: @${profile.username} (${profile.id})`);
  }
  return lines.join("\n");
}

function getClientIp(request) {
  return String(request.socket?.remoteAddress || "").replace(/^::ffff:/u, "");
}

async function handleSignupChallenge(request, response) {
  const browserSession = getSignupBrowserSession(request, response);
  const xSession = socialProviders.providerById.get("x")?.getSessionFromCookie?.(request) || null;
  const body = await readJsonRequest(request);
  const walletAddress = requireWalletAddress(body.walletAddress);
  const challengeId = createRandomToken(18);
  const issuedAt = new Date().toISOString();
  const message = buildWalletSignupMessage({
    profile: xSession?.profile,
    walletAddress,
    challengeId,
    issuedAt
  });

  signupChallenges.set(challengeId, {
    challengeId,
    browserSessionId: browserSession.sessionId,
    walletAddress,
    walletChainId: Number.isInteger(Number(body.chainId)) ? Number(body.chainId) : null,
    message,
    issuedAt,
    expiresAtMs: Date.now() + CHALLENGE_TTL_MS
  });

  writeJson(response, 200, {
    challengeId,
    message,
    expiresAt: Date.now() + CHALLENGE_TTL_MS
  });
}

function verifyWalletChallengeForBrowserSession(browserSession, body, { consume = true } = {}) {
  const walletAddress = requireWalletAddress(body.walletAddress);
  const challengeId = String(body.challengeId || "").trim();
  const signature = String(body.signature || "").trim();
  const challenge = signupChallenges.get(challengeId);

  if (!challenge || challenge.expiresAtMs <= Date.now()) {
    throw new HttpError(400, "Wallet challenge expired. Start again.");
  }
  if (challenge.browserSessionId !== browserSession.sessionId) {
    throw new HttpError(403, "Wallet challenge does not match this signup session.");
  }
  if (challenge.walletAddress !== walletAddress) {
    throw new HttpError(400, "Wallet challenge does not match the submitted wallet.");
  }
  if (!signature) {
    throw new HttpError(400, "Wallet signature is required.");
  }

  let recoveredAddress;
  try {
    recoveredAddress = ethers.verifyMessage(challenge.message, signature);
  } catch {
    throw new HttpError(400, "Wallet signature is invalid.");
  }
  if (ethers.getAddress(recoveredAddress) !== walletAddress) {
    throw new HttpError(400, "Wallet signature did not match the connected wallet.");
  }

  if (consume) signupChallenges.delete(challengeId);
  const walletProof = {
    walletAddress,
    walletChainId: challenge.walletChainId,
    signedMessage: challenge.message,
    signature,
    challengeId,
    verifiedAt: new Date().toISOString()
  };
  browserSession.walletProof = walletProof;
  browserSession.updatedAt = walletProof.verifiedAt;
  return walletProof;
}

async function handleSignupWalletVerify(request, response) {
  const browserSession = requireSignupBrowserSession(request);
  const body = await readJsonRequest(request);
  const walletProof = verifyWalletChallengeForBrowserSession(browserSession, body);
  const existingSignupRow = signupStore.findByWalletAddress(walletProof.walletAddress);
  if (existingSignupRow?.id) {
    browserSession.authenticatedSignupId = existingSignupRow.id;
    browserSession.authenticatedWalletAddress = walletProof.walletAddress;
    browserSession.updatedAt = new Date().toISOString();
  }
  writeJson(response, 200, {
    wallet: {
      address: walletProof.walletAddress,
      chainId: walletProof.walletChainId,
      verifiedAt: walletProof.verifiedAt
    },
    existingSignup: signupStore.serializeSignup(existingSignupRow)
  });
}

function getVerificationStatus(isPassed, isConfigured = true) {
  if (!isConfigured) return "unknown";
  return isPassed ? "passed" : "failed";
}

socialProviders = createSocialProviders({
  HttpError,
  createRandomToken,
  secureEquals,
  parseCookies,
  setCookie,
  clearCookie,
  redirect,
  writeJson,
  readJsonRequest,
  validateReturnUri,
  shouldUseSecureCookies,
  getDefaultFrontendReturnUrl,
  getPublicErrorMessage,
  getVerificationStatus
});

function buildSignupSocialAccounts({ socialSessions = {}, now }) {
  return socialProviders.buildSocialAccounts(socialSessions, now);
}

function assertNoSocialConflicts(accounts, targetSignupId = "") {
  const conflict = findSocialConflict(signupStore, accounts, targetSignupId);
  if (conflict) {
    throw new HttpError(409, conflict.message || `This ${getProviderLabel(conflict.account?.provider)} account is already linked to another signup.`);
  }
}

function buildCurrentVerification({ socialSessions, walletProof, coinMarketCapOpened }) {
  const socialVerification = socialProviders.getVerificationSnapshot(socialSessions);
  return {
    ...socialVerification,
    wallet: {
      signed: true,
      chainId: walletProof.walletChainId
    },
    coinMarketCap: { opened: Boolean(coinMarketCapOpened), verified: false }
  };
}

async function handleSignupComplete(request, response) {
  const socialSessions = socialProviders.getSessionsFromCookies(request);
  const xSession = socialSessions.x;
  const browserSession = requireSignupBrowserSession(request);
  const body = await readJsonRequest(request);

  await socialProviders.refreshSessions(socialSessions);

  const walletProof = verifyWalletChallengeForBrowserSession(browserSession, body);
  if (!walletProof) {
    throw new HttpError(400, "Verify wallet ownership before submitting.");
  }

  const walletAddress = requireWalletAddress(body.walletAddress || walletProof.walletAddress);
  if (walletAddress !== walletProof.walletAddress) {
    throw new HttpError(400, "Submitted wallet does not match the verified wallet.");
  }

  const now = new Date().toISOString();
  const currentVerification = buildCurrentVerification({
    socialSessions,
    walletProof,
    coinMarketCapOpened: body.coinMarketCapOpened
  });
  const currentSocialAccounts = buildSignupSocialAccounts({
    socialSessions,
    now
  });

  const existingByX = xSession?.profile?.id ? signupStore.findByXUserId(xSession.profile.id) : null;
  const existingByWallet = signupStore.findByWalletAddress(walletAddress);
  const authenticatedSignup = browserSession.authenticatedSignupId
    ? signupStore.findById(browserSession.authenticatedSignupId)
    : null;
  const targetMatches = getDistinctExistingSignups([authenticatedSignup, existingByWallet]);
  if (targetMatches.length > 1) {
    throw new HttpError(409, "These accounts are already linked to different signups.");
  }
  const targetSignup = targetMatches[0] || null;
  const targetSignupId = targetSignup?.id || "";

  if (existingByX?.id && existingByX.id !== targetSignupId) {
    throw new HttpError(409, "This X account is already linked to another signup.");
  }

  assertNoSocialConflicts(currentSocialAccounts, targetSignupId);

  const targetSignupSerialized = targetSignup ? signupStore.serializeSignup(targetSignup) : null;
  if (!hasRequiredSocialAccount(currentSocialAccounts) && !signupHasRequiredSocial(targetSignupSerialized)) {
    throw new HttpError(400, "Connect X, Telegram, Discord, or LinkedIn before submitting.");
  }

  const verification = mergeVerification(targetSignup, currentVerification, { hasXSession: Boolean(xSession?.profile?.id) });
  const mergedSocialAccounts = targetSignupSerialized
    ? mergeSocialAccounts(targetSignupSerialized.socialAccounts, currentSocialAccounts)
    : currentSocialAccounts;
  const signupInput = {
    id: targetSignup?.id || crypto.randomUUID(),
    xUserId: xSession?.profile?.id || targetSignup?.x_user_id || undefined,
    xUsername: xSession?.profile?.username || targetSignup?.x_username || undefined,
    xName: xSession?.profile?.name || targetSignup?.x_name || undefined,
    xProfileImageUrl: xSession?.profile?.profileImageUrl || targetSignup?.x_profile_image_url || undefined,
    walletAddress,
    walletChainId: walletProof.walletChainId,
    signedMessage: walletProof.signedMessage,
    signature: walletProof.signature,
    displayName: targetSignup?.display_name || "",
    email: targetSignup?.email || "",
    country: targetSignup?.country || "",
    interest: targetSignup?.interest || "",
    discordUsername: getOptionalSummaryValue(
      socialSessions.discord?.profile?.legacyTag || socialSessions.discord?.profile?.username,
      targetSignup?.discord_username || ""
    ),
    telegramUsername: getOptionalSummaryValue(
      socialSessions.telegram?.profile?.username || socialSessions.telegram?.profile?.displayName,
      targetSignup?.telegram_username || ""
    ),
    linkedinUrl: getOptionalSummaryValue(socialSessions.linkedin?.profile?.displayName, targetSignup?.linkedin_url || ""),
    notes: targetSignup?.notes || "",
    verificationJson: JSON.stringify(verification),
    status: targetSignup?.status || "received",
    userAgent: normalizeText(request.headers["user-agent"], 500),
    ipAddress: normalizeText(getClientIp(request), 80),
    submittedAt: now,
    createdAt: targetSignup?.created_at || now,
    updatedAt: now,
    socialAccounts: mergedSocialAccounts
  };

  try {
    const row = targetSignup ? signupStore.updateSignup(signupInput) : signupStore.saveSignup({
      ...signupInput,
      xUserId: signupInput.xUserId || null,
      xUsername: signupInput.xUsername || "",
      xName: signupInput.xName || "",
      xProfileImageUrl: signupInput.xProfileImageUrl || "",
      discordUsername: signupInput.discordUsername || "",
      telegramUsername: signupInput.telegramUsername || "",
      linkedinUrl: signupInput.linkedinUrl || ""
    });
    if (row?.id) {
      browserSession.authenticatedSignupId = row.id;
      browserSession.authenticatedWalletAddress = walletAddress;
      browserSession.updatedAt = now;
    }
    writeJson(response, 200, { signup: row, created: !targetSignup, updated: Boolean(targetSignup) });
  } catch (error) {
    if (String(error?.code || "") === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new HttpError(409, "This wallet or connected social account has already been used for a signup.");
    }
    throw error;
  }
}

function getAdminCredentials() {
  return {
    username: String(process.env.ADMIN_USERNAME || "admin"),
    password: String(process.env.ADMIN_PASSWORD || "")
  };
}

function getRequiredAdminSession(request) {
  pruneExpiredState();
  const token = String(request.headers["x-admin-token"] || "").trim();
  const session = token ? adminSessions.get(token) : null;
  if (!session) throw new HttpError(401, "Admin login is required.");
  return session;
}

async function handleAdminLogin(request, response) {
  const credentials = getAdminCredentials();
  if (!credentials.password) {
    throw new HttpError(500, "ADMIN_PASSWORD is not configured.", { expose: false });
  }
  const body = await readJsonRequest(request);
  if (!secureEquals(body.username, credentials.username) || !secureEquals(body.password, credentials.password)) {
    throw new HttpError(401, "Admin username or password is incorrect.");
  }
  const token = createRandomToken();
  adminSessions.set(token, {
    token,
    createdAt: new Date().toISOString(),
    expiresAtMs: Date.now() + ADMIN_SESSION_TTL_MS
  });
  writeJson(response, 200, {
    adminToken: token,
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS
  });
}

async function handleAdminLogout(request, response) {
  const token = String(request.headers["x-admin-token"] || "").trim();
  if (token) adminSessions.delete(token);
  writeJson(response, 200, { ok: true });
}

function handleAdminSignupList(request, response, requestUrl) {
  getRequiredAdminSession(request);
  const result = signupStore.listSignups({
    search: requestUrl.searchParams.get("search") || "",
    limit: requestUrl.searchParams.get("limit") || "50",
    offset: requestUrl.searchParams.get("offset") || "0"
  });
  writeJson(response, 200, {
    summary: signupStore.getStats(),
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    signups: result.rows.map((row) => signupStore.serializeSignup(row))
  });
}

function handleAdminSignupExport(request, response) {
  getRequiredAdminSession(request);
  writeText(response, 200, signupStore.exportCsv(), "text/csv; charset=utf-8", {
    "Content-Disposition": `attachment; filename="liberdus-social-signups.csv"`
  });
}

async function handleTestDiscordSession(request, response) {
  if (!isE2ETestMode()) throw new HttpError(404, "Not found.");
  requireAllowedOrigin(request, response);
  const body = await readJsonRequest(request);
  const provider = socialProviders.providerById.get("discord");
  if (!provider?.createTestSession) {
    throw new HttpError(500, "Discord test session helper is unavailable.", { expose: false });
  }
  writeJson(response, 200, provider.createTestSession(response, body));
}

const server = http.createServer(async (request, response) => {
  setStandardHeaders(response);

  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const pathname = requestUrl.pathname;

    pruneExpiredState();

    if (request.method === "OPTIONS") {
      handleOptions(request, response);
      return;
    }

    if (request.method === "GET" && pathname === "/health") {
      pruneExpiredState();
      writeJson(response, 200, {
        ok: true,
        dbPath: getDatabasePath(),
        stats: signupStore.getStats(),
        allowedOrigins: getAllowedOrigins(),
        allowedReturnUrls: getAllowedReturnUrls(),
        ...socialProviders.getHealth()
      });
      return;
    }

    if (request.method === "GET" && pathname === "/api/public/config") {
      requireAllowedOrigin(request, response);
      writeJson(response, 200, socialProviders.getPublicConfig());
      return;
    }

    if (request.method === "POST" && pathname === "/api/test/session/discord") {
      await handleTestDiscordSession(request, response);
      return;
    }

    const socialRoute = socialProviders.getRoute(request.method, pathname);
    if (socialRoute) {
      if (socialRoute.requireOrigin) requireAllowedOrigin(request, response);
      await socialRoute.handler(request, response, requestUrl);
      return;
    }

    if (request.method === "POST" && pathname === "/api/signup/challenge") {
      requireAllowedOrigin(request, response);
      await handleSignupChallenge(request, response);
      return;
    }

    if (request.method === "POST" && pathname === "/api/signup/wallet/verify") {
      requireAllowedOrigin(request, response);
      await handleSignupWalletVerify(request, response);
      return;
    }

    if (request.method === "POST" && pathname === "/api/signup/complete") {
      requireAllowedOrigin(request, response);
      await handleSignupComplete(request, response);
      return;
    }

    if (request.method === "POST" && pathname === "/api/admin/login") {
      requireAllowedOrigin(request, response);
      await handleAdminLogin(request, response);
      return;
    }

    if (request.method === "POST" && pathname === "/api/admin/logout") {
      requireAllowedOrigin(request, response);
      await handleAdminLogout(request, response);
      return;
    }

    if (request.method === "GET" && pathname === "/api/admin/signups") {
      requireAllowedOrigin(request, response);
      handleAdminSignupList(request, response, requestUrl);
      return;
    }

    if (request.method === "GET" && pathname === "/api/admin/signups/export") {
      requireAllowedOrigin(request, response);
      handleAdminSignupExport(request, response);
      return;
    }

    writeJson(response, 404, { error: "Not found." });
  } catch (error) {
    handleError(response, error);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Liberdus signup server listening at http://${HOST}:${PORT}`);
  console.log(`SQLite path: ${getDatabasePath()}`);
  console.log(`Allowed origins: ${getAllowedOrigins().join(", ")}`);
  console.log(`Allowed return URLs: ${getAllowedReturnUrls().join(", ")}`);
  const socialHealth = socialProviders.getHealth();
  console.log(`X API configured: ${socialHealth.xApiConfigured ? "yes" : "no"}`);
  console.log(`X callback configured: ${socialHealth.xCallbackConfigured ? "yes" : "no"}`);
  console.log(`Telegram bot configured: ${socialHealth.telegramBotConfigured ? "yes" : "no"}`);
  console.log(`LinkedIn API configured: ${socialHealth.linkedinApiConfigured ? "yes" : "no"}`);
  console.log(`GitHub API configured: ${socialHealth.githubApiConfigured ? "yes" : "no"}`);
  console.log(`Secure cookies: ${shouldUseSecureCookies() ? "yes" : "no"}`);
  console.log(`Signup count: ${signupStore.getStats().signupCount}`);
});
