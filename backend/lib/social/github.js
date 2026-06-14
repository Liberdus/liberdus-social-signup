const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_CURRENT_USER_URL = "https://api.github.com/user";
const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_SESSION_COOKIE_NAME = "liberdus_signup_github_session";
const GITHUB_INIT_COOKIE_NAME = "liberdus_signup_github_oauth_init";
const GITHUB_COMPLETE_QUERY_PARAM = "github_auth";
const GITHUB_COMPLETE_QUERY_VALUE = "complete";
const GITHUB_ERROR_QUERY_PARAM = "github_error";
const GITHUB_SESSION_TTL_MS = 30 * 60 * 1000;
const GITHUB_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function createGitHubProvider(context) {
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
    getCookiePath,
    getDefaultFrontendReturnUrl,
    getVerificationStatus
  } = context;

  const sessions = new Map();
  const oauthStates = new Map();

  function getClientId() {
    return String(process.env.GITHUB_CLIENT_ID || "").trim();
  }

  function getClientSecret() {
    return String(process.env.GITHUB_CLIENT_SECRET || "").trim();
  }

  function getCallbackUrl() {
    return String(process.env.GITHUB_OAUTH_CALLBACK_URL || "").trim();
  }

  function getOAuthScopes() {
    return String(process.env.GITHUB_OAUTH_SCOPES || "read:user").trim();
  }

  function getTargetRepo() {
    return String(process.env.GITHUB_TARGET_REPO || "Liberdus/web-client-v2").trim();
  }

  function getTargetRepoParts() {
    const value = getTargetRepo();
    const [owner, repo, extra] = value.split("/").map((part) => part.trim()).filter(Boolean);
    if (!owner || !repo || extra) return null;
    return { owner, repo, fullName: `${owner}/${repo}` };
  }

  function getTargetOrg() {
    return String(process.env.GITHUB_TARGET_ORG || "Liberdus").trim();
  }

  function getRepoUrl() {
    const repo = getTargetRepoParts();
    return repo ? `https://github.com/${repo.fullName}` : "";
  }

  function getOrgUrl() {
    const org = getTargetOrg();
    return org ? `https://github.com/${org}` : "";
  }

  function normalizeProfile(rawProfile) {
    const username = String(rawProfile.login || "").trim();
    return {
      id: String(rawProfile.id || "").trim(),
      username,
      displayName: String(rawProfile.name || username || "").trim(),
      avatarUrl: String(rawProfile.avatar_url || "").trim(),
      profileUrl: String(rawProfile.html_url || (username ? `https://github.com/${username}` : "")).trim(),
      type: String(rawProfile.type || "").trim(),
      company: String(rawProfile.company || "").trim(),
      blog: String(rawProfile.blog || "").trim(),
      location: String(rawProfile.location || "").trim(),
      publicRepos: Number.isInteger(rawProfile.public_repos) ? rawProfile.public_repos : null,
      followers: Number.isInteger(rawProfile.followers) ? rawProfile.followers : null
    };
  }

  async function exchangeCode(code, redirectUri) {
    const clientId = getClientId();
    const clientSecret = getClientSecret();
    if (!clientId || !clientSecret) {
      throw new HttpError(500, "Missing GitHub client ID or client secret in .env.", { expose: false });
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri
    });

    const response = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error || !payload.access_token) {
      console.error(`[GitHub token] HTTP ${response.status}: ${JSON.stringify(payload)}`);
      throw new HttpError(502, "GitHub rejected the authentication request.", { expose: false });
    }
    return payload;
  }

  async function fetchGitHubApi(url, accessToken) {
    return fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Liberdus-Social-Signup"
      }
    });
  }

  async function fetchProfile(accessToken) {
    const response = await fetchGitHubApi(GITHUB_CURRENT_USER_URL, accessToken);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`[GitHub user] HTTP ${response.status}: ${JSON.stringify(payload)}`);
      throw new HttpError(502, "GitHub user lookup failed.", { expose: false });
    }
    const profile = normalizeProfile(payload);
    if (!profile.id || !profile.username) {
      throw new HttpError(502, "GitHub did not return a usable profile.", { expose: false });
    }
    return profile;
  }

  async function fetchRepoStar(accessToken) {
    const target = getTargetRepoParts();
    const checkedAt = new Date().toISOString();
    if (!target) {
      return {
        configured: false,
        starred: false,
        targetRepo: getTargetRepo(),
        repoUrl: "",
        checkedAt,
        error: "invalid_target_repo"
      };
    }

    const url = `${GITHUB_API_BASE_URL}/user/starred/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
    const response = await fetchGitHubApi(url, accessToken);
    if (response.status === 204) {
      return {
        configured: true,
        starred: true,
        targetRepo: target.fullName,
        repoUrl: getRepoUrl(),
        checkedAt,
        statusCode: response.status
      };
    }
    if (response.status === 404) {
      return {
        configured: true,
        starred: false,
        targetRepo: target.fullName,
        repoUrl: getRepoUrl(),
        checkedAt,
        statusCode: response.status
      };
    }

    const payload = await response.json().catch(() => ({}));
    console.error(`[GitHub repo star] HTTP ${response.status}: ${JSON.stringify(payload)}`);
    return {
      configured: true,
      starred: false,
      targetRepo: target.fullName,
      repoUrl: getRepoUrl(),
      checkedAt,
      statusCode: response.status,
      error: "lookup_failed"
    };
  }

  async function refreshSession(session) {
    if (!session?.accessToken) return null;
    try {
      session.star = await fetchRepoStar(session.accessToken);
    } catch (error) {
      console.error("[GitHub repo star]", error);
      session.star = {
        configured: Boolean(getTargetRepoParts()),
        starred: false,
        targetRepo: getTargetRepo(),
        repoUrl: getRepoUrl(),
        checkedAt: new Date().toISOString(),
        error: "lookup_failed"
      };
    }
    return session.star;
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
      star: session.star || null,
      authenticatedAt: session.authenticatedAt,
      expiresAt: session.expiresAtMs
    };
  }

  function getSessionFromCookie(request) {
    const sessionId = parseCookies(request)[GITHUB_SESSION_COOKIE_NAME];
    return sessionId ? sessions.get(sessionId) || null : null;
  }

  async function handleStart(request, response, requestUrl) {
    const clientId = getClientId();
    const callbackUrl = getCallbackUrl();
    if (!clientId || !getClientSecret()) {
      throw new HttpError(500, "Missing GitHub client ID or client secret in .env.", { expose: false });
    }
    if (!callbackUrl) {
      throw new HttpError(500, "Missing GitHub OAuth callback URL in .env.", { expose: false });
    }

    const returnUri = validateReturnUri(requestUrl.searchParams.get("return_uri"));
    const state = createRandomToken(24);
    oauthStates.set(state, {
      returnUri,
      expiresAtMs: Date.now() + GITHUB_OAUTH_STATE_TTL_MS
    });
    setCookie(response, GITHUB_INIT_COOKIE_NAME, state, {
      path: getCookiePath("/api/github/"),
      maxAge: GITHUB_OAUTH_STATE_TTL_MS / 1000,
      httpOnly: true,
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });

    const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("allow_signup", "true");
    const scopes = getOAuthScopes();
    if (scopes) authorizeUrl.searchParams.set("scope", scopes);
    redirect(response, authorizeUrl.toString());
  }

  async function handleCallback(request, response, requestUrl) {
    const code = String(requestUrl.searchParams.get("code") || "").trim();
    const state = String(requestUrl.searchParams.get("state") || "").trim();
    const errorDescription = String(requestUrl.searchParams.get("error_description") || requestUrl.searchParams.get("error") || "").trim();
    const pending = state ? oauthStates.get(state) : null;
    const returnUri = pending?.returnUri || getDefaultFrontendReturnUrl();
    const initCookieState = String(parseCookies(request)[GITHUB_INIT_COOKIE_NAME] || "").trim();
    const hasValidInitCookie = Boolean(state && initCookieState && secureEquals(initCookieState, state));

    clearCookie(response, GITHUB_INIT_COOKIE_NAME, { path: getCookiePath("/api/github/"), sameSite: "Lax", secure: shouldUseSecureCookies() });

    if (errorDescription) {
      if (state) oauthStates.delete(state);
      const url = new URL(returnUri);
      url.searchParams.set(GITHUB_ERROR_QUERY_PARAM, "GitHub sign-in was cancelled.");
      redirect(response, url.toString());
      return;
    }

    if (!code || !pending || !hasValidInitCookie) {
      const url = new URL(returnUri);
      url.searchParams.set(GITHUB_ERROR_QUERY_PARAM, "GitHub sign-in expired. Try again.");
      redirect(response, url.toString());
      return;
    }

    const token = await exchangeCode(code, getCallbackUrl());
    const profile = await fetchProfile(token.access_token);
    const sessionId = createRandomToken();
    const now = new Date().toISOString();
    const session = {
      sessionId,
      accessToken: token.access_token,
      profile,
      star: null,
      authenticatedAt: now,
      expiresAtMs: Date.now() + GITHUB_SESSION_TTL_MS
    };
    await refreshSession(session);
    sessions.set(sessionId, session);
    oauthStates.delete(state);
    setCookie(response, GITHUB_SESSION_COOKIE_NAME, sessionId, {
      path: getCookiePath("/api/"),
      maxAge: GITHUB_SESSION_TTL_MS / 1000,
      httpOnly: true,
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });

    const url = new URL(returnUri);
    url.searchParams.set(GITHUB_COMPLETE_QUERY_PARAM, GITHUB_COMPLETE_QUERY_VALUE);
    redirect(response, url.toString());
  }

  async function handleSessionLookup(request, response, requestUrl) {
    const session = getSessionFromCookie(request);
    if (!session) {
      if (requestUrl.searchParams.get("optional") === "1") {
        writeJson(response, 200, { session: null });
        return;
      }
      throw new HttpError(401, "Sign in with GitHub first.");
    }
    await refreshSession(session);
    writeJson(response, 200, serializeSession(session));
  }

  function clearSession(request, response) {
    const sessionId = parseCookies(request)[GITHUB_SESSION_COOKIE_NAME];
    if (sessionId) sessions.delete(sessionId);
    clearCookie(response, GITHUB_SESSION_COOKIE_NAME, {
      path: getCookiePath("/api/"),
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });
    clearCookie(response, GITHUB_INIT_COOKIE_NAME, {
      path: getCookiePath("/api/github/"),
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
      verified: Boolean(session?.star?.starred),
      userId: session?.profile?.id || "",
      username: session?.profile?.username || "",
      displayName: session?.profile?.displayName || "",
      profileUrl: session?.profile?.profileUrl || "",
      targetRepo: session?.star?.targetRepo || getTargetRepo(),
      repoUrl: session?.star?.repoUrl || getRepoUrl(),
      repoStarred: Boolean(session?.star?.starred),
      repoStarCheckedAt: session?.star?.checkedAt || null,
      repoStarCheckError: session?.star?.error || ""
    };
  }

  function buildSocialAccount(session, now) {
    if (!session?.profile?.id) return null;
    return {
      provider: "github",
      providerUserId: session.profile.id,
      username: session.profile.username || "",
      displayName: session.profile.displayName || session.profile.username || "",
      profileUrl: session.profile.profileUrl || "",
      avatarUrl: session.profile.avatarUrl || "",
      connectedAt: session.authenticatedAt || now,
      rawProfile: session.profile,
      verifications: [{
        checkType: "github_repo_starred",
        targetId: session.star?.targetRepo || getTargetRepo(),
        status: getVerificationStatus(Boolean(session.star?.starred), session.star?.configured !== false),
        checkedAt: session.star?.checkedAt || session.authenticatedAt || now,
        rawResult: session.star || {}
      }]
    };
  }

  return {
    id: "github",
    routes: {
      "GET /api/github/start": { handler: handleStart },
      "GET /api/github/callback": { handler: handleCallback },
      "GET /api/github/session": { handler: handleSessionLookup, requireOrigin: true },
      "POST /api/github/logout": { handler: handleLogout, requireOrigin: true }
    },
    pruneExpired,
    clearSession,
    getSessionFromCookie,
    refreshSession,
    serializeSession,
    getVerification,
    buildSocialAccount,
    getHealth() {
      return {
        githubApiConfigured: Boolean(getClientId() && getClientSecret() && getCallbackUrl()),
        githubTargetRepo: getTargetRepo()
      };
    },
    getPublicConfig() {
      const socialLinks = {};
      if (getRepoUrl()) socialLinks.githubRepo = getRepoUrl();
      if (getOrgUrl()) {
        socialLinks.github = getOrgUrl();
        socialLinks.githubOrg = getOrgUrl();
      }
      return {
        socialLinks,
        githubAuth: {
          enabled: Boolean(getClientId() && getClientSecret() && getCallbackUrl()),
          targetRepo: getTargetRepo(),
          targetOrg: getTargetOrg()
        }
      };
    }
  };
}

module.exports = {
  createGitHubProvider
};
