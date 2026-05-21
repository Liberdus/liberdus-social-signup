const crypto = require("node:crypto");

const REQUEST_TOKEN_URL = "https://api.x.com/oauth/request_token";
const AUTHORIZE_URL = "https://api.x.com/oauth/authorize";
const ACCESS_TOKEN_URL = "https://api.x.com/oauth/access_token";
const VERIFY_CREDENTIALS_URL = "https://api.x.com/1.1/account/verify_credentials.json";
const AUTH_SESSION_COOKIE_NAME = "liberdus_signup_x_session";
const AUTH_INIT_COOKIE_NAME = "liberdus_signup_x_oauth_init";
const AUTH_COMPLETE_QUERY_PARAM = "x_auth";
const AUTH_COMPLETE_QUERY_VALUE = "complete";
const AUTH_COMPLETION_TOKEN_QUERY_PARAM = "x_completion";
const AUTH_ERROR_QUERY_PARAM = "x_error";
const AUTH_SESSION_TTL_MS = 30 * 60 * 1000;
const AUTH_COMPLETION_TOKEN_TTL_MS = 5 * 60 * 1000;
const REQUEST_TOKEN_TTL_MS = 10 * 60 * 1000;

function createXProvider(context) {
  const {
    HttpError,
    createRandomToken,
    secureEquals,
    parseCookies,
    setCookie,
    clearCookie,
    redirect,
    writeJson,
    validateReturnUri,
    shouldUseSecureCookies,
    getDefaultFrontendReturnUrl,
    getVerificationStatus
  } = context;

  const sessions = new Map();
  const completions = new Map();
  const requestTokens = new Map();

  function getApiKey() {
    return String(process.env.X_API_KEY || process.env.X_CONSUMER_KEY || process.env.X_APP_KEY || "").trim();
  }

  function getApiSecret() {
    return String(process.env.X_API_SECRET || process.env.X_API_SECRET_KEY || process.env.X_CONSUMER_SECRET || "").trim();
  }

  function getCallbackUrl() {
    return String(process.env.X_OAUTH1_CALLBACK_URL || "").trim();
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

  function normalizeProfile(rawProfile) {
    return {
      id: String(rawProfile.id_str || rawProfile.id || "").trim(),
      username: String(rawProfile.screen_name || rawProfile.username || "").trim(),
      name: String(rawProfile.name || rawProfile.screen_name || "").trim(),
      profileImageUrl: String(rawProfile.profile_image_url_https || rawProfile.profile_image_url || "").trim(),
      verified: Boolean(rawProfile.verified)
    };
  }

  function serializeSession(session) {
    if (!session) return null;
    return {
      profile: session.profile,
      csrfToken: session.csrfToken,
      authenticatedAt: session.authenticatedAt,
      expiresAt: session.expiresAtMs
    };
  }

  function getSessionFromCookie(request) {
    const sessionId = parseCookies(request)[AUTH_SESSION_COOKIE_NAME];
    return sessionId ? sessions.get(sessionId) || null : null;
  }

  function getRequiredSessionFromCookie(request) {
    const session = getSessionFromCookie(request);
    if (!session) throw new HttpError(401, "Sign in with X first.");
    return session;
  }

  function setSessionCookie(response, sessionId) {
    setCookie(response, AUTH_SESSION_COOKIE_NAME, sessionId, {
      path: "/api/",
      maxAge: AUTH_SESSION_TTL_MS / 1000,
      httpOnly: true,
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });
  }

  function requireCsrf(request, session) {
    const csrfToken = String(request.headers["x-csrf-token"] || "").trim();
    if (!csrfToken || !secureEquals(csrfToken, session.csrfToken)) {
      throw new HttpError(403, "CSRF token is invalid.");
    }
  }

  function pruneExpired(now) {
    for (const [key, session] of sessions.entries()) {
      if (session.expiresAtMs <= now) sessions.delete(key);
    }
    for (const [key, completion] of completions.entries()) {
      if (completion.expiresAtMs <= now) completions.delete(key);
    }
    for (const [key, pending] of requestTokens.entries()) {
      if (pending.expiresAtMs <= now) requestTokens.delete(key);
    }
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
    const profile = normalizeProfile(rawProfile);
    if (!profile.id || !profile.username) {
      throw new HttpError(502, "X did not return a usable profile.", { expose: false });
    }

    const sessionId = createRandomToken();
    const now = new Date().toISOString();
    sessions.set(sessionId, {
      sessionId,
      csrfToken: createRandomToken(24),
      profile,
      authenticatedAt: now,
      expiresAtMs: Date.now() + AUTH_SESSION_TTL_MS
    });
    requestTokens.delete(oauthToken);
    setSessionCookie(response, sessionId);
    const completionToken = createRandomToken(18);
    completions.set(completionToken, {
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
    const completion = completionToken ? completions.get(completionToken) : null;
    const session = completion?.sessionId
      ? sessions.get(completion.sessionId) || null
      : getRequiredSessionFromCookie(request);
    if (completionToken) completions.delete(completionToken);
    if (!session) throw new HttpError(401, "Sign in with X first.");
    setSessionCookie(response, session.sessionId);
    writeJson(response, 200, serializeSession(session));
  }

  function clearSession(request, response) {
    const cookies = parseCookies(request);
    const sessionId = cookies[AUTH_SESSION_COOKIE_NAME];
    if (sessionId) sessions.delete(sessionId);
    const pendingToken = String(cookies[AUTH_INIT_COOKIE_NAME] || "").trim();
    if (pendingToken) requestTokens.delete(pendingToken);
    clearCookie(response, AUTH_INIT_COOKIE_NAME, { path: "/api/x/", sameSite: "Lax", secure: shouldUseSecureCookies() });
    clearCookie(response, AUTH_SESSION_COOKIE_NAME, {
      path: "/api/",
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });
  }

  async function handleLogout(request, response) {
    try {
      const session = getRequiredSessionFromCookie(request);
      requireCsrf(request, session);
      clearSession(request, response);
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 401) throw error;
      clearSession(request, response);
    }
    writeJson(response, 200, { ok: true });
  }

  function getVerification(session) {
    return session?.profile?.id
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
        };
  }

  function buildSocialAccount(session, now) {
    if (!session?.profile?.id) return null;
    const verification = getVerification(session);
    return {
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
        rawResult: verification
      }, {
        checkType: "x_verified",
        targetId: session.profile.id,
        status: getVerificationStatus(Boolean(session.profile.verified)),
        checkedAt: session.authenticatedAt || now,
        rawResult: { verified: Boolean(session.profile.verified) }
      }]
    };
  }

  return {
    id: "x",
    routes: {
      "GET /api/x/start": { handler: handleStart },
      "GET /api/x/callback": { handler: handleCallback },
      "GET /api/x/session": { handler: handleSessionLookup, requireOrigin: true },
      "POST /api/x/logout": { handler: handleLogout, requireOrigin: true }
    },
    pruneExpired,
    clearSession,
    getSessionFromCookie,
    serializeSession,
    getVerification,
    buildSocialAccount,
    getHealth() {
      return {
        xApiConfigured: Boolean(getApiKey() && getApiSecret()),
        xCallbackConfigured: Boolean(getCallbackUrl())
      };
    },
    getPublicConfig() {
      return {
        xAuth: {
          enabled: Boolean(getApiKey() && getApiSecret() && getCallbackUrl())
        }
      };
    }
  };
}

module.exports = {
  createXProvider
};
