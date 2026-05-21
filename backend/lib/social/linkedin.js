const LINKEDIN_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const LINKEDIN_SESSION_COOKIE_NAME = "liberdus_signup_linkedin_session";
const LINKEDIN_INIT_COOKIE_NAME = "liberdus_signup_linkedin_oauth_init";
const LINKEDIN_COMPLETE_QUERY_PARAM = "linkedin_auth";
const LINKEDIN_COMPLETE_QUERY_VALUE = "complete";
const LINKEDIN_ERROR_QUERY_PARAM = "linkedin_error";
const LINKEDIN_SESSION_TTL_MS = 30 * 60 * 1000;
const LINKEDIN_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function createLinkedInProvider(context) {
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
    getDefaultFrontendReturnUrl
  } = context;

  const sessions = new Map();
  const oauthStates = new Map();

  function getClientId() {
    return String(process.env.LINKEDIN_CLIENT_ID || "").trim();
  }

  function getClientSecret() {
    return String(process.env.LINKEDIN_CLIENT_SECRET || "").trim();
  }

  function getCallbackUrl() {
    return String(process.env.LINKEDIN_OAUTH_CALLBACK_URL || "").trim();
  }

  function normalizeProfile(rawProfile) {
    const name = String(rawProfile.name || "").trim();
    const givenName = String(rawProfile.given_name || "").trim();
    const familyName = String(rawProfile.family_name || "").trim();
    const displayName = name || [givenName, familyName].filter(Boolean).join(" ") || String(rawProfile.sub || "").trim();
    const locale = rawProfile.locale && typeof rawProfile.locale === "object"
      ? [rawProfile.locale.language, rawProfile.locale.country].filter(Boolean).join("_")
      : String(rawProfile.locale || "").trim();
    return {
      id: String(rawProfile.sub || "").trim(),
      name,
      givenName,
      familyName,
      displayName,
      picture: String(rawProfile.picture || "").trim(),
      email: String(rawProfile.email || "").trim(),
      emailVerified: rawProfile.email_verified === true,
      locale
    };
  }

  async function exchangeCode(code, redirectUri) {
    const clientId = getClientId();
    const clientSecret = getClientSecret();
    if (!clientId || !clientSecret) {
      throw new HttpError(500, "Missing LinkedIn client ID or client secret in .env.", { expose: false });
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret
    });

    const response = await fetch(LINKEDIN_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`[LinkedIn token] HTTP ${response.status}: ${JSON.stringify(payload)}`);
      throw new HttpError(502, "LinkedIn rejected the authentication request.", { expose: false });
    }
    return payload;
  }

  async function fetchProfile(accessToken) {
    const response = await fetch(LINKEDIN_USERINFO_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`[LinkedIn userinfo] HTTP ${response.status}: ${JSON.stringify(payload)}`);
      throw new HttpError(502, "LinkedIn user lookup failed.", { expose: false });
    }
    const profile = normalizeProfile(payload);
    if (!profile.id) {
      throw new HttpError(502, "LinkedIn did not return a usable profile.", { expose: false });
    }
    return profile;
  }

  function pruneExpired(now) {
    for (const [key, session] of sessions.entries()) {
      if (session.expiresAtMs <= now) sessions.delete(key);
    }
    for (const [key, pending] of oauthStates.entries()) {
      if (pending.expiresAtMs <= now) oauthStates.delete(key);
    }
  }

  function serializeSession(session) {
    if (!session) return null;
    return {
      profile: session.profile,
      authenticatedAt: session.authenticatedAt,
      expiresAt: session.expiresAtMs
    };
  }

  function getSessionFromCookie(request) {
    const sessionId = parseCookies(request)[LINKEDIN_SESSION_COOKIE_NAME];
    return sessionId ? sessions.get(sessionId) || null : null;
  }

  async function handleStart(request, response, requestUrl) {
    const clientId = getClientId();
    const callbackUrl = getCallbackUrl();
    if (!clientId || !getClientSecret()) {
      throw new HttpError(500, "Missing LinkedIn client ID or client secret in .env.", { expose: false });
    }
    if (!callbackUrl) {
      throw new HttpError(500, "Missing LinkedIn OAuth callback URL in .env.", { expose: false });
    }

    const returnUri = validateReturnUri(requestUrl.searchParams.get("return_uri"));
    const state = createRandomToken(24);
    oauthStates.set(state, {
      returnUri,
      expiresAtMs: Date.now() + LINKEDIN_OAUTH_STATE_TTL_MS
    });
    setCookie(response, LINKEDIN_INIT_COOKIE_NAME, state, {
      path: "/api/linkedin/",
      maxAge: LINKEDIN_OAUTH_STATE_TTL_MS / 1000,
      httpOnly: true,
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });

    const authorizeUrl = new URL(LINKEDIN_AUTHORIZE_URL);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
    authorizeUrl.searchParams.set("scope", "openid profile");
    authorizeUrl.searchParams.set("state", state);
    redirect(response, authorizeUrl.toString());
  }

  async function handleCallback(request, response, requestUrl) {
    const code = String(requestUrl.searchParams.get("code") || "").trim();
    const state = String(requestUrl.searchParams.get("state") || "").trim();
    const errorDescription = String(requestUrl.searchParams.get("error_description") || requestUrl.searchParams.get("error") || "").trim();
    const pending = state ? oauthStates.get(state) : null;
    const returnUri = pending?.returnUri || getDefaultFrontendReturnUrl();
    const initCookieState = String(parseCookies(request)[LINKEDIN_INIT_COOKIE_NAME] || "").trim();
    const hasValidInitCookie = Boolean(state && initCookieState && secureEquals(initCookieState, state));

    clearCookie(response, LINKEDIN_INIT_COOKIE_NAME, { path: "/api/linkedin/", sameSite: "Lax", secure: shouldUseSecureCookies() });

    if (errorDescription) {
      if (state) oauthStates.delete(state);
      const url = new URL(returnUri);
      url.searchParams.set(LINKEDIN_ERROR_QUERY_PARAM, `LinkedIn sign-in failed: ${errorDescription}`);
      redirect(response, url.toString());
      return;
    }

    if (!code || !pending || !hasValidInitCookie) {
      const url = new URL(returnUri);
      url.searchParams.set(LINKEDIN_ERROR_QUERY_PARAM, "LinkedIn sign-in expired. Try again.");
      redirect(response, url.toString());
      return;
    }

    const token = await exchangeCode(code, getCallbackUrl());
    const profile = await fetchProfile(token.access_token);
    const sessionId = createRandomToken();
    const now = new Date().toISOString();
    sessions.set(sessionId, {
      sessionId,
      profile,
      authenticatedAt: now,
      expiresAtMs: Date.now() + LINKEDIN_SESSION_TTL_MS
    });
    oauthStates.delete(state);
    setCookie(response, LINKEDIN_SESSION_COOKIE_NAME, sessionId, {
      path: "/api/",
      maxAge: LINKEDIN_SESSION_TTL_MS / 1000,
      httpOnly: true,
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });

    const url = new URL(returnUri);
    url.searchParams.set(LINKEDIN_COMPLETE_QUERY_PARAM, LINKEDIN_COMPLETE_QUERY_VALUE);
    redirect(response, url.toString());
  }

  async function handleSessionLookup(request, response, requestUrl) {
    const session = getSessionFromCookie(request);
    if (!session) {
      if (requestUrl.searchParams.get("optional") === "1") {
        writeJson(response, 200, { session: null });
        return;
      }
      throw new HttpError(401, "Sign in with LinkedIn first.");
    }
    writeJson(response, 200, serializeSession(session));
  }

  function clearSession(request, response) {
    const sessionId = parseCookies(request)[LINKEDIN_SESSION_COOKIE_NAME];
    if (sessionId) sessions.delete(sessionId);
    clearCookie(response, LINKEDIN_SESSION_COOKIE_NAME, {
      path: "/api/",
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });
    clearCookie(response, LINKEDIN_INIT_COOKIE_NAME, {
      path: "/api/linkedin/",
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });
  }

  async function handleLogout(request, response) {
    clearSession(request, response);
    writeJson(response, 200, { ok: true });
  }

  function getVerification(session) {
    return {
      connected: Boolean(session),
      authenticated: Boolean(session),
      userId: session?.profile?.id || "",
      name: session?.profile?.displayName || session?.profile?.name || "",
      picture: session?.profile?.picture || "",
      followVerified: false
    };
  }

  function buildSocialAccount(session, now) {
    if (!session?.profile?.id) return null;
    return {
      provider: "linkedin",
      providerUserId: session.profile.id,
      username: "",
      displayName: session.profile.displayName || session.profile.name || "",
      profileUrl: "",
      avatarUrl: session.profile.picture || "",
      connectedAt: session.authenticatedAt || now,
      rawProfile: session.profile,
      verifications: [{
        checkType: "linkedin_authenticated",
        targetId: session.profile.id,
        status: "passed",
        checkedAt: session.authenticatedAt || now,
        rawResult: {
          authenticated: true,
          userId: session.profile.id
        }
      }]
    };
  }

  return {
    id: "linkedin",
    routes: {
      "GET /api/linkedin/start": { handler: handleStart },
      "GET /api/linkedin/callback": { handler: handleCallback },
      "GET /api/linkedin/session": { handler: handleSessionLookup, requireOrigin: true },
      "POST /api/linkedin/logout": { handler: handleLogout, requireOrigin: true }
    },
    pruneExpired,
    clearSession,
    getSessionFromCookie,
    serializeSession,
    getVerification,
    buildSocialAccount,
    getHealth() {
      return {
        linkedinApiConfigured: Boolean(getClientId() && getClientSecret() && getCallbackUrl())
      };
    },
    getPublicConfig() {
      return {
        linkedinAuth: {
          enabled: Boolean(getClientId() && getClientSecret() && getCallbackUrl())
        }
      };
    }
  };
}

module.exports = {
  createLinkedInProvider
};
