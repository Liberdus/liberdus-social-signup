const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
const DISCORD_CURRENT_USER_URL = "https://discord.com/api/users/@me";
const DISCORD_CURRENT_USER_GUILD_MEMBER_URL_PREFIX = "https://discord.com/api/users/@me/guilds";
const DISCORD_SESSION_COOKIE_NAME = "liberdus_signup_discord_session";
const DISCORD_INIT_COOKIE_NAME = "liberdus_signup_discord_oauth_init";
const DISCORD_COMPLETE_QUERY_PARAM = "discord_auth";
const DISCORD_COMPLETE_QUERY_VALUE = "complete";
const DISCORD_ERROR_QUERY_PARAM = "discord_error";
const DISCORD_SESSION_TTL_MS = 30 * 60 * 1000;
const DISCORD_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function createDiscordProvider(context) {
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
  const oauthStates = new Map();

  function getClientId() {
    return String(process.env.DISCORD_CLIENT_ID || "").trim();
  }

  function getClientSecret() {
    return String(process.env.DISCORD_CLIENT_SECRET || "").trim();
  }

  function getCallbackUrl() {
    return String(process.env.DISCORD_OAUTH_CALLBACK_URL || "").trim();
  }

  function getGuildId() {
    return String(process.env.DISCORD_GUILD_ID || "").trim();
  }

  function getInviteUrl() {
    return String(process.env.DISCORD_INVITE_URL || "").trim();
  }

  function normalizeProfile(rawProfile) {
    const discriminator = String(rawProfile.discriminator || "").trim();
    const username = String(rawProfile.username || "").trim();
    return {
      id: String(rawProfile.id || "").trim(),
      username,
      globalName: String(rawProfile.global_name || "").trim(),
      displayName: String(rawProfile.global_name || username || "").trim(),
      discriminator,
      avatar: String(rawProfile.avatar || "").trim(),
      avatarUrl: rawProfile.id && rawProfile.avatar
        ? `https://cdn.discordapp.com/avatars/${rawProfile.id}/${rawProfile.avatar}.png`
        : "",
      legacyTag: discriminator && discriminator !== "0" ? `${username}#${discriminator}` : username
    };
  }

  async function exchangeCode(code, redirectUri) {
    const clientId = getClientId();
    const clientSecret = getClientSecret();
    if (!clientId || !clientSecret) {
      throw new HttpError(500, "Missing Discord client ID or client secret in .env.", { expose: false });
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri
    });

    const response = await fetch(DISCORD_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
      },
      body
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`[Discord token] HTTP ${response.status}: ${JSON.stringify(payload)}`);
      throw new HttpError(502, "Discord rejected the authentication request.", { expose: false });
    }
    return payload;
  }

  async function fetchDiscordJson(url, accessToken, fallbackMessage) {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 404) return null;
      console.error(`[Discord ${url}] HTTP ${response.status}: ${JSON.stringify(payload)}`);
      throw new HttpError(502, fallbackMessage, { expose: false });
    }
    return payload;
  }

  async function fetchProfile(accessToken) {
    const rawProfile = await fetchDiscordJson(DISCORD_CURRENT_USER_URL, accessToken, "Discord user lookup failed.");
    const profile = normalizeProfile(rawProfile);
    if (!profile.id || !profile.username) {
      throw new HttpError(502, "Discord did not return a usable profile.", { expose: false });
    }
    return profile;
  }

  async function fetchMembership(accessToken) {
    const guildId = getGuildId();
    if (!guildId) {
      return { configured: false, isMember: false, guildId: "", checkedAt: null };
    }
    const checkedAt = new Date().toISOString();
    const member = await fetchDiscordJson(
      `${DISCORD_CURRENT_USER_GUILD_MEMBER_URL_PREFIX}/${encodeURIComponent(guildId)}/member`,
      accessToken,
      "Discord server membership lookup failed."
    );
    return {
      configured: true,
      isMember: Boolean(member),
      guildId,
      nick: String(member?.nick || "").trim(),
      roles: Array.isArray(member?.roles) ? member.roles.map(String) : [],
      joinedAt: member?.joined_at || null,
      checkedAt
    };
  }

  function serializeSession(session) {
    if (!session) return null;
    return {
      profile: session.profile,
      membership: session.membership,
      authenticatedAt: session.authenticatedAt,
      expiresAt: session.expiresAtMs
    };
  }

  function pruneExpired(now) {
    for (const [key, session] of sessions.entries()) {
      if (session.expiresAtMs <= now) sessions.delete(key);
    }
    for (const [key, pending] of oauthStates.entries()) {
      if (pending.expiresAtMs <= now) oauthStates.delete(key);
    }
  }

  function getSessionFromCookie(request) {
    const sessionId = parseCookies(request)[DISCORD_SESSION_COOKIE_NAME];
    return sessionId ? sessions.get(sessionId) || null : null;
  }

  async function handleStart(request, response, requestUrl) {
    const clientId = getClientId();
    const callbackUrl = getCallbackUrl();
    if (!clientId || !getClientSecret()) {
      throw new HttpError(500, "Missing Discord client ID or client secret in .env.", { expose: false });
    }
    if (!callbackUrl) {
      throw new HttpError(500, "Missing Discord OAuth callback URL in .env.", { expose: false });
    }

    const returnUri = validateReturnUri(requestUrl.searchParams.get("return_uri"));
    const state = createRandomToken(24);
    oauthStates.set(state, {
      returnUri,
      expiresAtMs: Date.now() + DISCORD_OAUTH_STATE_TTL_MS
    });
    setCookie(response, DISCORD_INIT_COOKIE_NAME, state, {
      path: "/api/discord/",
      maxAge: DISCORD_OAUTH_STATE_TTL_MS / 1000,
      httpOnly: true,
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });

    const authorizeUrl = new URL(DISCORD_AUTHORIZE_URL);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
    authorizeUrl.searchParams.set("scope", "identify guilds.members.read");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("prompt", "consent");
    redirect(response, authorizeUrl.toString());
  }

  async function handleCallback(request, response, requestUrl) {
    const code = String(requestUrl.searchParams.get("code") || "").trim();
    const state = String(requestUrl.searchParams.get("state") || "").trim();
    const errorDescription = String(requestUrl.searchParams.get("error_description") || requestUrl.searchParams.get("error") || "").trim();
    const pending = state ? oauthStates.get(state) : null;
    const returnUri = pending?.returnUri || getDefaultFrontendReturnUrl();
    const initCookieState = String(parseCookies(request)[DISCORD_INIT_COOKIE_NAME] || "").trim();
    const hasValidInitCookie = Boolean(state && initCookieState && secureEquals(initCookieState, state));

    clearCookie(response, DISCORD_INIT_COOKIE_NAME, { path: "/api/discord/", sameSite: "Lax", secure: shouldUseSecureCookies() });

    if (errorDescription) {
      if (state) oauthStates.delete(state);
      const url = new URL(returnUri);
      url.searchParams.set(DISCORD_ERROR_QUERY_PARAM, "Discord sign-in was cancelled.");
      redirect(response, url.toString());
      return;
    }

    if (!code || !pending || !hasValidInitCookie) {
      const url = new URL(returnUri);
      url.searchParams.set(DISCORD_ERROR_QUERY_PARAM, "Discord sign-in expired. Try again.");
      redirect(response, url.toString());
      return;
    }

    const token = await exchangeCode(code, getCallbackUrl());
    const profile = await fetchProfile(token.access_token);
    const membership = await fetchMembership(token.access_token);
    const sessionId = createRandomToken();
    const now = new Date().toISOString();
    sessions.set(sessionId, {
      sessionId,
      profile,
      membership,
      authenticatedAt: now,
      expiresAtMs: Date.now() + DISCORD_SESSION_TTL_MS
    });
    oauthStates.delete(state);
    setCookie(response, DISCORD_SESSION_COOKIE_NAME, sessionId, {
      path: "/api/",
      maxAge: DISCORD_SESSION_TTL_MS / 1000,
      httpOnly: true,
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });

    const url = new URL(returnUri);
    url.searchParams.set(DISCORD_COMPLETE_QUERY_PARAM, DISCORD_COMPLETE_QUERY_VALUE);
    redirect(response, url.toString());
  }

  async function handleSessionLookup(request, response, requestUrl) {
    const session = getSessionFromCookie(request);
    if (!session) {
      if (requestUrl.searchParams.get("optional") === "1") {
        writeJson(response, 200, { session: null });
        return;
      }
      throw new HttpError(401, "Sign in with Discord first.");
    }
    writeJson(response, 200, serializeSession(session));
  }

  function clearSession(request, response) {
    const sessionId = parseCookies(request)[DISCORD_SESSION_COOKIE_NAME];
    if (sessionId) sessions.delete(sessionId);
    clearCookie(response, DISCORD_SESSION_COOKIE_NAME, {
      path: "/api/",
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });
    clearCookie(response, DISCORD_INIT_COOKIE_NAME, {
      path: "/api/discord/",
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
      verified: Boolean(session?.membership?.isMember),
      userId: session?.profile?.id || "",
      username: session?.profile?.username || "",
      displayName: session?.profile?.displayName || "",
      guildId: session?.membership?.guildId || "",
      membershipCheckedAt: session?.membership?.checkedAt || null
    };
  }

  function buildSocialAccount(session, now) {
    if (!session?.profile?.id) return null;
    return {
      provider: "discord",
      providerUserId: session.profile.id,
      username: session.profile.legacyTag || session.profile.username,
      displayName: session.profile.displayName || session.profile.username,
      profileUrl: "",
      avatarUrl: session.profile.avatarUrl || "",
      connectedAt: session.authenticatedAt || now,
      rawProfile: session.profile,
      verifications: [{
        checkType: "discord_guild_member",
        targetId: session.membership?.guildId || "",
        status: getVerificationStatus(Boolean(session.membership?.isMember), session.membership?.configured !== false),
        checkedAt: session.membership?.checkedAt || session.authenticatedAt || now,
        rawResult: session.membership || {}
      }]
    };
  }

  function createTestSession(response, overrides = {}) {
    const now = new Date().toISOString();
    const profile = normalizeProfile({
      id: overrides.id || "e2e-discord-user",
      username: overrides.username || "e2ediscord",
      global_name: overrides.displayName || overrides.username || "E2E Discord",
      discriminator: "0",
      avatar: ""
    });
    const membership = {
      configured: true,
      isMember: overrides.isMember !== false,
      guildId: overrides.guildId || getGuildId() || "e2e-guild",
      nick: "",
      roles: [],
      joinedAt: now,
      checkedAt: now
    };
    const sessionId = createRandomToken();
    sessions.set(sessionId, {
      sessionId,
      profile,
      membership,
      authenticatedAt: now,
      expiresAtMs: Date.now() + DISCORD_SESSION_TTL_MS
    });
    setCookie(response, DISCORD_SESSION_COOKIE_NAME, sessionId, {
      path: "/api/",
      maxAge: DISCORD_SESSION_TTL_MS / 1000,
      httpOnly: true,
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });
    return serializeSession(sessions.get(sessionId));
  }

  return {
    id: "discord",
    routes: {
      "GET /api/discord/start": { handler: handleStart },
      "GET /api/discord/callback": { handler: handleCallback },
      "GET /api/discord/session": { handler: handleSessionLookup, requireOrigin: true },
      "POST /api/discord/logout": { handler: handleLogout, requireOrigin: true }
    },
    pruneExpired,
    clearSession,
    getSessionFromCookie,
    serializeSession,
    getVerification,
    buildSocialAccount,
    createTestSession,
    getHealth() {
      return {
        discordApiConfigured: Boolean(getClientId() && getClientSecret() && getCallbackUrl()),
        discordGuildConfigured: Boolean(getGuildId())
      };
    },
    getPublicConfig() {
      return {
        socialLinks: getInviteUrl() ? { discord: getInviteUrl() } : {},
        discordAuth: {
          enabled: Boolean(getClientId() && getClientSecret() && getCallbackUrl()),
          membershipConfigured: Boolean(getGuildId())
        }
      };
    }
  };
}

module.exports = {
  createDiscordProvider
};
