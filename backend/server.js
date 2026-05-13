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
const REQUEST_TOKEN_URL = "https://api.x.com/oauth/request_token";
const AUTHORIZE_URL = "https://api.x.com/oauth/authorize";
const ACCESS_TOKEN_URL = "https://api.x.com/oauth/access_token";
const VERIFY_CREDENTIALS_URL = "https://api.x.com/1.1/account/verify_credentials.json";
const AUTH_SESSION_COOKIE_NAME = "liberdus_signup_x_session";
const AUTH_INIT_COOKIE_NAME = "liberdus_signup_x_oauth_init";
const SIGNUP_BROWSER_COOKIE_NAME = "liberdus_signup_browser_session";
const AUTH_COMPLETE_QUERY_PARAM = "x_auth";
const AUTH_COMPLETE_QUERY_VALUE = "complete";
const AUTH_COMPLETION_TOKEN_QUERY_PARAM = "x_completion";
const AUTH_ERROR_QUERY_PARAM = "x_error";
const AUTH_SESSION_TTL_MS = 30 * 60 * 1000;
const AUTH_COMPLETION_TOKEN_TTL_MS = 5 * 60 * 1000;
const SIGNUP_BROWSER_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const REQUEST_TOKEN_TTL_MS = 10 * 60 * 1000;
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

const authSessions = new Map();
const authCompletions = new Map();
const signupBrowserSessions = new Map();
const requestTokens = new Map();
const signupChallenges = new Map();
const adminSessions = new Map();
let socialProviders;

const db = openDatabase();
const signupStore = createSignupStore(db);

function getApiKey() {
  return String(process.env.X_API_KEY || process.env.X_CONSUMER_KEY || process.env.X_APP_KEY || "").trim();
}

function getApiSecret() {
  return String(process.env.X_API_SECRET || process.env.X_API_SECRET_KEY || process.env.X_CONSUMER_SECRET || "").trim();
}

function getCallbackUrl() {
  return String(process.env.X_OAUTH1_CALLBACK_URL || "").trim();
}

function isE2ETestMode() {
  return /^(1|true|yes)$/iu.test(String(process.env.E2E_TEST_MODE || "").trim());
}

function percentEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function parseFormEncoded(text) {
  return Object.fromEntries(new URLSearchParams(text).entries());
}

function buildNormalizedParameterString(params) {
  return [...params]
    .map(([key, value]) => [percentEncode(key), percentEncode(value)])
    .sort((left, right) => left[0] === right[0] ? left[1].localeCompare(right[1]) : left[0].localeCompare(right[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function buildSignature({ method, url, params, consumerSecret, tokenSecret = "" }) {
  const normalizedUrl = new URL(url);
  normalizedUrl.search = "";
  normalizedUrl.hash = "";
  const baseString = [
    method.toUpperCase(),
    percentEncode(normalizedUrl.toString()),
    percentEncode(buildNormalizedParameterString(params))
  ].join("&");
  return crypto.createHmac("sha1", `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`).update(baseString).digest("base64");
}

function createOAuthHeader(params) {
  return `OAuth ${[...params.entries()]
    .filter(([key]) => key.startsWith("oauth_"))
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(", ")}`;
}

function buildOAuthParams(overrides = {}) {
  return new Map(Object.entries({
    oauth_consumer_key: getApiKey(),
    oauth_nonce: createRandomToken(16),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: "1.0",
    ...overrides
  }));
}

async function oauthRequest({ method, url, oauthOverrides = {}, requestParams = new Map(), tokenSecret = "" }) {
  const apiKey = getApiKey();
  const apiSecret = getApiSecret();
  if (!apiKey || !apiSecret) {
    throw new HttpError(500, "Missing X API key or API secret in .env.", { expose: false });
  }

  const oauthParams = buildOAuthParams(oauthOverrides);
  const signatureParams = new Map([...oauthParams.entries(), ...requestParams.entries()]);
  oauthParams.set("oauth_signature", buildSignature({
    method,
    url,
    params: signatureParams,
    consumerSecret: apiSecret,
    tokenSecret
  }));

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: createOAuthHeader(oauthParams),
      "Content-Length": "0"
    }
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(`[X OAuth ${method} ${url}] HTTP ${response.status}: ${text}`);
    throw new HttpError(502, "X rejected the authentication request.", { expose: false });
  }
  return parseFormEncoded(text);
}

async function verifyCredentials(accessToken, accessTokenSecret) {
  const oauthParams = buildOAuthParams({
    oauth_consumer_key: getApiKey(),
    oauth_token: accessToken
  });
  oauthParams.set("oauth_signature", buildSignature({
    method: "GET",
    url: VERIFY_CREDENTIALS_URL,
    params: oauthParams,
    consumerSecret: getApiSecret(),
    tokenSecret: accessTokenSecret
  }));

  const response = await fetch(VERIFY_CREDENTIALS_URL, {
    method: "GET",
    headers: { Authorization: createOAuthHeader(oauthParams) }
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(`[X verify credentials] HTTP ${response.status}: ${text}`);
    throw new HttpError(502, "X user identity lookup failed.", { expose: false });
  }
  return JSON.parse(text);
}

function pruneExpiredState() {
  const now = Date.now();
  socialProviders?.pruneExpired(now);
  for (const [key, session] of authSessions.entries()) {
    if (session.expiresAtMs <= now) authSessions.delete(key);
  }
  for (const [key, completion] of authCompletions.entries()) {
    if (completion.expiresAtMs <= now) authCompletions.delete(key);
  }
  for (const [key, session] of signupBrowserSessions.entries()) {
    if (session.expiresAtMs <= now) signupBrowserSessions.delete(key);
  }
  for (const [key, pending] of requestTokens.entries()) {
    if (pending.expiresAtMs <= now) requestTokens.delete(key);
  }
  for (const [key, challenge] of signupChallenges.entries()) {
    if (challenge.expiresAtMs <= now) signupChallenges.delete(key);
  }
  for (const [key, session] of adminSessions.entries()) {
    if (session.expiresAtMs <= now) adminSessions.delete(key);
  }
}

function normalizeXProfile(rawProfile) {
  return {
    id: String(rawProfile.id_str || rawProfile.id || "").trim(),
    username: String(rawProfile.screen_name || rawProfile.username || "").trim(),
    name: String(rawProfile.name || rawProfile.screen_name || "").trim(),
    profileImageUrl: String(rawProfile.profile_image_url_https || rawProfile.profile_image_url || "").trim(),
    verified: Boolean(rawProfile.verified)
  };
}

function serializeSession(session) {
  return {
    profile: session.profile,
    csrfToken: session.csrfToken,
    authenticatedAt: session.authenticatedAt,
    expiresAt: session.expiresAtMs
  };
}

function getRequiredSessionFromCookie(request) {
  pruneExpiredState();
  const sessionId = parseCookies(request)[AUTH_SESSION_COOKIE_NAME];
  const session = sessionId ? authSessions.get(sessionId) : null;
  if (!session) throw new HttpError(401, "Sign in with X first.");
  return session;
}

function getOptionalSessionFromCookie(request) {
  pruneExpiredState();
  const sessionId = parseCookies(request)[AUTH_SESSION_COOKIE_NAME];
  return sessionId ? authSessions.get(sessionId) || null : null;
}

function setXSessionCookie(response, sessionId) {
  setCookie(response, AUTH_SESSION_COOKIE_NAME, sessionId, {
    path: "/api/",
    maxAge: AUTH_SESSION_TTL_MS / 1000,
    httpOnly: true,
    sameSite: "Lax",
    secure: shouldUseSecureCookies()
  });
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

function requireCsrf(request, session) {
  const csrfToken = String(request.headers["x-csrf-token"] || "").trim();
  if (!csrfToken || !secureEquals(csrfToken, session.csrfToken)) {
    throw new HttpError(403, "CSRF token is invalid.");
  }
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

async function handleStart(request, response, requestUrl) {
  const returnUri = validateReturnUri(requestUrl.searchParams.get("return_uri"));
  const callbackUrl = getCallbackUrl();
  if (!callbackUrl) throw new HttpError(500, "Missing X OAuth callback URL in .env.", { expose: false });

  const result = await oauthRequest({
    method: "POST",
    url: REQUEST_TOKEN_URL,
    oauthOverrides: { oauth_callback: callbackUrl },
    requestParams: new Map([["oauth_callback", callbackUrl]])
  });
  if (!result.oauth_token || !result.oauth_token_secret) {
    throw new HttpError(502, "X did not return a request token.", { expose: false });
  }

  requestTokens.set(result.oauth_token, {
    tokenSecret: result.oauth_token_secret,
    returnUri,
    expiresAtMs: Date.now() + REQUEST_TOKEN_TTL_MS
  });
  setCookie(response, AUTH_INIT_COOKIE_NAME, result.oauth_token, {
    path: "/api/x/",
    maxAge: REQUEST_TOKEN_TTL_MS / 1000,
    httpOnly: true,
    sameSite: "Lax",
    secure: shouldUseSecureCookies()
  });

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set("oauth_token", result.oauth_token);
  redirect(response, authorizeUrl.toString());
}

async function handleCallback(request, response, requestUrl) {
  const oauthToken = String(requestUrl.searchParams.get("oauth_token") || "").trim();
  const oauthVerifier = String(requestUrl.searchParams.get("oauth_verifier") || "").trim();
  const denied = String(requestUrl.searchParams.get("denied") || "").trim();
  const callbackToken = oauthToken || denied;
  const pending = callbackToken ? requestTokens.get(callbackToken) : null;
  const fallbackReturnUri = getDefaultFrontendReturnUrl();
  const returnUri = pending?.returnUri || fallbackReturnUri;
  const initCookieToken = String(parseCookies(request)[AUTH_INIT_COOKIE_NAME] || "").trim();
  const hasValidInitCookie = Boolean(callbackToken && initCookieToken && secureEquals(initCookieToken, callbackToken));

  clearCookie(response, AUTH_INIT_COOKIE_NAME, { path: "/api/x/", sameSite: "Lax", secure: shouldUseSecureCookies() });

  if (denied && hasValidInitCookie) {
    requestTokens.delete(denied);
    const url = new URL(returnUri);
    url.searchParams.set(AUTH_ERROR_QUERY_PARAM, "X sign-in was cancelled.");
    redirect(response, url.toString());
    return;
  }
  if (!oauthToken || !oauthVerifier || !pending || !hasValidInitCookie) {
    const url = new URL(returnUri);
    url.searchParams.set(AUTH_ERROR_QUERY_PARAM, "X sign-in expired. Try again.");
    redirect(response, url.toString());
    return;
  }

  const access = await oauthRequest({
    method: "POST",
    url: ACCESS_TOKEN_URL,
    oauthOverrides: {
      oauth_token: oauthToken,
      oauth_verifier: oauthVerifier
    },
    requestParams: new Map([["oauth_verifier", oauthVerifier]]),
    tokenSecret: pending.tokenSecret
  });
  const rawProfile = await verifyCredentials(access.oauth_token, access.oauth_token_secret);
  const profile = normalizeXProfile(rawProfile);
  if (!profile.id || !profile.username) {
    throw new HttpError(502, "X did not return a usable profile.", { expose: false });
  }

  const sessionId = createRandomToken();
  const now = new Date().toISOString();
  authSessions.set(sessionId, {
    sessionId,
    csrfToken: createRandomToken(24),
    profile,
    authenticatedAt: now,
    expiresAtMs: Date.now() + AUTH_SESSION_TTL_MS
  });
  requestTokens.delete(oauthToken);
  setXSessionCookie(response, sessionId);
  const completionToken = createRandomToken(18);
  authCompletions.set(completionToken, {
    sessionId,
    expiresAtMs: Date.now() + AUTH_COMPLETION_TOKEN_TTL_MS
  });

  const url = new URL(returnUri);
  url.searchParams.set(AUTH_COMPLETE_QUERY_PARAM, AUTH_COMPLETE_QUERY_VALUE);
  url.searchParams.set(AUTH_COMPLETION_TOKEN_QUERY_PARAM, completionToken);
  redirect(response, url.toString());
}

async function handleSessionLookup(request, response, requestUrl) {
  const completionToken = String(requestUrl.searchParams.get(AUTH_COMPLETION_TOKEN_QUERY_PARAM) || "").trim();
  const completion = completionToken ? authCompletions.get(completionToken) : null;
  const session = completion?.sessionId
    ? authSessions.get(completion.sessionId) || null
    : getRequiredSessionFromCookie(request);
  if (completionToken) authCompletions.delete(completionToken);
  if (!session) throw new HttpError(401, "Sign in with X first.");
  setXSessionCookie(response, session.sessionId);
  writeJson(response, 200, serializeSession(session));
}

async function handleLogout(request, response) {
  try {
    const session = getRequiredSessionFromCookie(request);
    requireCsrf(request, session);
    authSessions.delete(session.sessionId);
  } catch (error) {
    if (!(error instanceof HttpError) || error.statusCode !== 401) throw error;
  }
  clearCookie(response, AUTH_SESSION_COOKIE_NAME, {
    path: "/api/",
    sameSite: "Lax",
    secure: shouldUseSecureCookies()
  });
  writeJson(response, 200, { ok: true });
}

async function handleSignupChallenge(request, response) {
  const browserSession = getSignupBrowserSession(request, response);
  const xSession = getOptionalSessionFromCookie(request);
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

function buildSignupSocialAccounts({ session, socialSessions = {}, verification, now }) {
  const accounts = [];

  if (session?.profile?.id) {
    accounts.push({
      provider: "x",
      providerUserId: session.profile.id,
      username: session.profile.username,
      displayName: session.profile.name || session.profile.username,
      profileUrl: session.profile.username ? `https://x.com/${session.profile.username}` : "",
      avatarUrl: session.profile.profileImageUrl || "",
      connectedAt: session.authenticatedAt || now,
      rawProfile: session.profile,
      verifications: [{
        checkType: "x_authenticated",
        targetId: session.profile.id,
        status: "passed",
        checkedAt: session.authenticatedAt || now,
        rawResult: verification.x
      }, {
        checkType: "x_verified",
        targetId: session.profile.id,
        status: getVerificationStatus(Boolean(session.profile.verified)),
        checkedAt: session.authenticatedAt || now,
        rawResult: { verified: Boolean(session.profile.verified) }
      }]
    });
  }

  accounts.push(...socialProviders.buildSocialAccounts(socialSessions, now));

  return accounts;
}

function assertNoSocialConflicts(accounts, targetSignupId = "") {
  const conflict = findSocialConflict(signupStore, accounts, targetSignupId);
  if (conflict) {
    throw new HttpError(409, conflict.message || `This ${getProviderLabel(conflict.account?.provider)} account is already linked to another signup.`);
  }
}

function buildCurrentVerification({ session, socialSessions, walletProof, coinMarketCapOpened }) {
  const socialVerification = socialProviders.getVerificationSnapshot(socialSessions);
  return {
    x: session?.profile?.id
      ? {
          authenticated: true,
          userId: session.profile.id,
          username: session.profile.username,
          verified: Boolean(session.profile.verified),
          followChecks: []
        }
      : {
          authenticated: false,
          followChecks: []
        },
    wallet: {
      signed: true,
      chainId: walletProof.walletChainId
    },
    ...socialVerification,
    coinMarketCap: { opened: Boolean(coinMarketCapOpened), verified: false }
  };
}

async function handleSignupComplete(request, response) {
  const session = getOptionalSessionFromCookie(request);
  const socialSessions = socialProviders.getSessionsFromCookies(request);
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
    session,
    socialSessions,
    walletProof,
    coinMarketCapOpened: body.coinMarketCapOpened
  });
  const currentSocialAccounts = buildSignupSocialAccounts({
    session,
    socialSessions,
    verification: currentVerification,
    now
  });

  const existingByX = session?.profile?.id ? signupStore.findByXUserId(session.profile.id) : null;
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

  const verification = mergeVerification(targetSignup, currentVerification, { hasXSession: Boolean(session?.profile?.id) });
  const mergedSocialAccounts = targetSignupSerialized
    ? mergeSocialAccounts(targetSignupSerialized.socialAccounts, currentSocialAccounts)
    : currentSocialAccounts;
  const signupInput = {
    id: targetSignup?.id || crypto.randomUUID(),
    xUserId: session?.profile?.id || targetSignup?.x_user_id || undefined,
    xUsername: session?.profile?.username || targetSignup?.x_username || undefined,
    xName: session?.profile?.name || targetSignup?.x_name || undefined,
    xProfileImageUrl: session?.profile?.profileImageUrl || targetSignup?.x_profile_image_url || undefined,
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
        xApiConfigured: Boolean(getApiKey() && getApiSecret()),
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

    if (request.method === "GET" && pathname === "/api/x/start") {
      await handleStart(request, response, requestUrl);
      return;
    }

    if (request.method === "GET" && pathname === "/api/x/callback") {
      await handleCallback(request, response, requestUrl);
      return;
    }

    if (request.method === "GET" && pathname === "/api/x/session") {
      requireAllowedOrigin(request, response);
      await handleSessionLookup(request, response, requestUrl);
      return;
    }

    if (request.method === "POST" && pathname === "/api/x/logout") {
      requireAllowedOrigin(request, response);
      await handleLogout(request, response);
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
  console.log(`X API configured: ${getApiKey() && getApiSecret() ? "yes" : "no"}`);
  console.log(`X callback URL: ${getCallbackUrl() || "(missing)"}`);
  const socialHealth = socialProviders.getHealth();
  console.log(`Telegram bot configured: ${socialHealth.telegramBotConfigured ? "yes" : "no"}`);
  console.log(`LinkedIn API configured: ${socialHealth.linkedinApiConfigured ? "yes" : "no"}`);
  console.log(`GitHub API configured: ${socialHealth.githubApiConfigured ? "yes" : "no"}`);
  console.log(`Secure cookies: ${shouldUseSecureCookies() ? "yes" : "no"}`);
  console.log(`Signup count: ${signupStore.getStats().signupCount}`);
});
