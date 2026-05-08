const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const YOUTUBE_API_BASE_URL = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_SESSION_COOKIE_NAME = "liberdus_signup_youtube_session";
const YOUTUBE_INIT_COOKIE_NAME = "liberdus_signup_youtube_oauth_init";
const YOUTUBE_COMPLETE_QUERY_PARAM = "youtube_auth";
const YOUTUBE_COMPLETE_QUERY_VALUE = "complete";
const YOUTUBE_ERROR_QUERY_PARAM = "youtube_error";
const YOUTUBE_SESSION_TTL_MS = 30 * 60 * 1000;
const YOUTUBE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TARGET_CHANNEL_HANDLE = "Liberdus";
const DEFAULT_TARGET_CHANNEL_URL = "https://www.youtube.com/@Liberdus";
const DEFAULT_OAUTH_SCOPES = "openid profile https://www.googleapis.com/auth/youtube.readonly";

function createYouTubeProvider(context) {
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
    return String(process.env.YOUTUBE_CLIENT_ID || "").trim();
  }

  function getClientSecret() {
    return String(process.env.YOUTUBE_CLIENT_SECRET || "").trim();
  }

  function getCallbackUrl() {
    return String(process.env.YOUTUBE_OAUTH_CALLBACK_URL || "").trim();
  }

  function getOAuthScopes() {
    return String(process.env.YOUTUBE_OAUTH_SCOPES || DEFAULT_OAUTH_SCOPES).trim();
  }

  function getTargetChannelHandle() {
    const explicit = String(process.env.YOUTUBE_TARGET_CHANNEL_HANDLE || "").trim();
    if (explicit) return explicit.replace(/^@/u, "");

    const configuredUrl = String(process.env.YOUTUBE_TARGET_CHANNEL_URL || "").trim();
    const match = configuredUrl.match(/youtube\.com\/@([^/?#]+)/iu);
    return match?.[1] || DEFAULT_TARGET_CHANNEL_HANDLE;
  }

  function getTargetChannelId() {
    return String(process.env.YOUTUBE_TARGET_CHANNEL_ID || "").trim();
  }

  function getTargetChannelUrl() {
    const explicit = String(process.env.YOUTUBE_TARGET_CHANNEL_URL || "").trim();
    if (explicit) return explicit;
    const handle = getTargetChannelHandle();
    return handle ? `https://www.youtube.com/@${handle}` : DEFAULT_TARGET_CHANNEL_URL;
  }

  function normalizeProfile(rawProfile) {
    return {
      id: String(rawProfile.sub || "").trim(),
      email: String(rawProfile.email || "").trim(),
      emailVerified: rawProfile.email_verified === true,
      displayName: String(rawProfile.name || "").trim(),
      givenName: String(rawProfile.given_name || "").trim(),
      familyName: String(rawProfile.family_name || "").trim(),
      picture: String(rawProfile.picture || "").trim(),
      locale: String(rawProfile.locale || "").trim()
    };
  }

  function normalizeChannelHandle(customUrl) {
    return String(customUrl || "").trim().replace(/^https?:\/\/(www\.)?youtube\.com\//iu, "").replace(/^@/u, "");
  }

  function normalizeChannelUrl(rawChannel, customUrl) {
    const cleanCustomUrl = String(customUrl || "").trim();
    if (cleanCustomUrl) return `https://www.youtube.com/${cleanCustomUrl.replace(/^\/+/u, "")}`;
    const channelId = String(rawChannel?.id || "").trim();
    return channelId ? `https://www.youtube.com/channel/${channelId}` : "";
  }

  function normalizeChannel(rawChannel) {
    const snippet = rawChannel?.snippet || {};
    const thumbnails = snippet.thumbnails || {};
    return {
      id: String(rawChannel?.id || "").trim(),
      title: String(snippet.title || "").trim(),
      handle: getTargetChannelHandle(),
      url: getTargetChannelUrl(),
      thumbnailUrl: String(thumbnails.default?.url || thumbnails.medium?.url || thumbnails.high?.url || "").trim()
    };
  }

  function normalizeOwnChannel(rawChannel) {
    const snippet = rawChannel?.snippet || {};
    const thumbnails = snippet.thumbnails || {};
    const customUrl = String(snippet.customUrl || "").trim();
    return {
      id: String(rawChannel?.id || "").trim(),
      title: String(snippet.title || "").trim(),
      handle: normalizeChannelHandle(customUrl),
      customUrl,
      url: normalizeChannelUrl(rawChannel, customUrl),
      thumbnailUrl: String(thumbnails.default?.url || thumbnails.medium?.url || thumbnails.high?.url || "").trim(),
      publishedAt: String(snippet.publishedAt || "").trim(),
      country: String(snippet.country || "").trim()
    };
  }

  function getYouTubeDisplayName(profile) {
    const channel = profile?.youtubeChannel || null;
    if (channel?.handle) return `@${channel.handle}`;
    return channel?.title || profile?.displayName || profile?.email || "YouTube account";
  }

  async function exchangeCode(code, redirectUri) {
    const clientId = getClientId();
    const clientSecret = getClientSecret();
    if (!clientId || !clientSecret) {
      throw new HttpError(500, "Missing YouTube client ID or client secret in .env.", { expose: false });
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret
    });

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error || !payload.access_token) {
      console.error(`[YouTube token] HTTP ${response.status}: ${JSON.stringify(payload)}`);
      throw new HttpError(502, "Google rejected the YouTube authentication request.", { expose: false });
    }
    return payload;
  }

  async function fetchGoogleApi(url, accessToken) {
    return fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });
  }

  async function fetchProfile(accessToken) {
    const response = await fetchGoogleApi(GOOGLE_USERINFO_URL, accessToken);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`[YouTube userinfo] HTTP ${response.status}: ${JSON.stringify(payload)}`);
      throw new HttpError(502, "Google user lookup failed.", { expose: false });
    }
    const profile = normalizeProfile(payload);
    if (!profile.id) {
      throw new HttpError(502, "Google did not return a usable profile.", { expose: false });
    }
    return profile;
  }

  async function fetchOwnChannel(accessToken) {
    const url = new URL(`${YOUTUBE_API_BASE_URL}/channels`);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("mine", "true");
    url.searchParams.set("maxResults", "1");

    const response = await fetchGoogleApi(url.toString(), accessToken);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`[YouTube own channel] HTTP ${response.status}: ${JSON.stringify(payload)}`);
      return null;
    }

    const channel = normalizeOwnChannel(payload.items?.[0]);
    return channel.id ? channel : null;
  }

  async function resolveTargetChannel(accessToken) {
    const configuredChannelId = getTargetChannelId();
    const checkedAt = new Date().toISOString();
    if (configuredChannelId) {
      return {
        id: configuredChannelId,
        title: "",
        handle: getTargetChannelHandle(),
        url: getTargetChannelUrl(),
        checkedAt,
        source: "env"
      };
    }

    const handle = getTargetChannelHandle();
    if (!handle) {
      return {
        id: "",
        title: "",
        handle: "",
        url: getTargetChannelUrl(),
        checkedAt,
        source: "config",
        error: "missing_target_channel_handle"
      };
    }

    const url = new URL(`${YOUTUBE_API_BASE_URL}/channels`);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("forHandle", handle);
    url.searchParams.set("maxResults", "1");

    const response = await fetchGoogleApi(url.toString(), accessToken);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`[YouTube channel] HTTP ${response.status}: ${JSON.stringify(payload)}`);
      return {
        id: "",
        title: "",
        handle,
        url: getTargetChannelUrl(),
        checkedAt,
        source: "forHandle",
        error: "lookup_failed",
        statusCode: response.status
      };
    }

    const channel = normalizeChannel(payload.items?.[0]);
    return {
      ...channel,
      checkedAt,
      source: "forHandle",
      error: channel.id ? "" : "channel_not_found"
    };
  }

  async function fetchSubscription(accessToken) {
    const checkedAt = new Date().toISOString();
    const targetChannel = await resolveTargetChannel(accessToken);
    if (!targetChannel.id) {
      return {
        configured: false,
        subscribed: false,
        targetChannelId: "",
        targetChannelHandle: targetChannel.handle || getTargetChannelHandle(),
        targetChannelUrl: targetChannel.url || getTargetChannelUrl(),
        targetChannelTitle: targetChannel.title || "",
        checkedAt,
        error: targetChannel.error || "target_channel_unavailable"
      };
    }

    const url = new URL(`${YOUTUBE_API_BASE_URL}/subscriptions`);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("mine", "true");
    url.searchParams.set("forChannelId", targetChannel.id);
    url.searchParams.set("maxResults", "1");

    const response = await fetchGoogleApi(url.toString(), accessToken);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`[YouTube subscription] HTTP ${response.status}: ${JSON.stringify(payload)}`);
      return {
        configured: true,
        subscribed: false,
        targetChannelId: targetChannel.id,
        targetChannelHandle: targetChannel.handle || getTargetChannelHandle(),
        targetChannelUrl: targetChannel.url || getTargetChannelUrl(),
        targetChannelTitle: targetChannel.title || "",
        checkedAt,
        statusCode: response.status,
        error: "lookup_failed"
      };
    }

    const subscribed = Array.isArray(payload.items) && payload.items.length > 0;
    return {
      configured: true,
      subscribed,
      targetChannelId: targetChannel.id,
      targetChannelHandle: targetChannel.handle || getTargetChannelHandle(),
      targetChannelUrl: targetChannel.url || getTargetChannelUrl(),
      targetChannelTitle: targetChannel.title || "",
      checkedAt,
      statusCode: response.status,
      subscriptionId: subscribed ? String(payload.items[0]?.id || "").trim() : "",
      rawPageInfo: payload.pageInfo || {}
    };
  }

  async function refreshSession(session) {
    if (!session?.accessToken) return null;
    try {
      if (!session.profile?.youtubeChannel) {
        session.profile.youtubeChannel = await fetchOwnChannel(session.accessToken);
      }
    } catch (error) {
      console.error("[YouTube own channel]", error);
    }

    try {
      session.subscription = await fetchSubscription(session.accessToken);
    } catch (error) {
      console.error("[YouTube subscription]", error);
      session.subscription = {
        configured: Boolean(getTargetChannelId() || getTargetChannelHandle()),
        subscribed: false,
        targetChannelId: getTargetChannelId(),
        targetChannelHandle: getTargetChannelHandle(),
        targetChannelUrl: getTargetChannelUrl(),
        targetChannelTitle: "",
        checkedAt: new Date().toISOString(),
        error: "lookup_failed"
      };
    }
    return session.subscription;
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
      subscription: session.subscription || null,
      authenticatedAt: session.authenticatedAt,
      expiresAt: session.expiresAtMs
    };
  }

  function getSessionFromCookie(request) {
    const sessionId = parseCookies(request)[YOUTUBE_SESSION_COOKIE_NAME];
    return sessionId ? sessions.get(sessionId) || null : null;
  }

  async function handleStart(request, response, requestUrl) {
    const clientId = getClientId();
    const callbackUrl = getCallbackUrl();
    if (!clientId || !getClientSecret()) {
      throw new HttpError(500, "Missing YouTube client ID or client secret in .env.", { expose: false });
    }
    if (!callbackUrl) {
      throw new HttpError(500, "Missing YouTube OAuth callback URL in .env.", { expose: false });
    }

    const returnUri = validateReturnUri(requestUrl.searchParams.get("return_uri"));
    const state = createRandomToken(24);
    oauthStates.set(state, {
      returnUri,
      expiresAtMs: Date.now() + YOUTUBE_OAUTH_STATE_TTL_MS
    });
    setCookie(response, YOUTUBE_INIT_COOKIE_NAME, state, {
      path: "/api/youtube/",
      maxAge: YOUTUBE_OAUTH_STATE_TTL_MS / 1000,
      httpOnly: true,
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });

    const authorizeUrl = new URL(GOOGLE_AUTHORIZE_URL);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
    authorizeUrl.searchParams.set("scope", getOAuthScopes());
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("access_type", "online");
    authorizeUrl.searchParams.set("include_granted_scopes", "true");
    authorizeUrl.searchParams.set("prompt", "consent");
    redirect(response, authorizeUrl.toString());
  }

  async function handleCallback(request, response, requestUrl) {
    const code = String(requestUrl.searchParams.get("code") || "").trim();
    const state = String(requestUrl.searchParams.get("state") || "").trim();
    const errorDescription = String(requestUrl.searchParams.get("error_description") || requestUrl.searchParams.get("error") || "").trim();
    const pending = state ? oauthStates.get(state) : null;
    const returnUri = pending?.returnUri || getDefaultFrontendReturnUrl();
    const initCookieState = String(parseCookies(request)[YOUTUBE_INIT_COOKIE_NAME] || "").trim();
    const hasValidInitCookie = Boolean(state && initCookieState && secureEquals(initCookieState, state));

    clearCookie(response, YOUTUBE_INIT_COOKIE_NAME, { path: "/api/youtube/", sameSite: "Lax", secure: shouldUseSecureCookies() });

    if (errorDescription) {
      if (state) oauthStates.delete(state);
      const url = new URL(returnUri);
      url.searchParams.set(YOUTUBE_ERROR_QUERY_PARAM, `YouTube sign-in failed: ${errorDescription}`);
      redirect(response, url.toString());
      return;
    }

    if (!code || !pending || !hasValidInitCookie) {
      const url = new URL(returnUri);
      url.searchParams.set(YOUTUBE_ERROR_QUERY_PARAM, "YouTube sign-in expired. Try again.");
      redirect(response, url.toString());
      return;
    }

    const token = await exchangeCode(code, getCallbackUrl());
    const profile = await fetchProfile(token.access_token);
    profile.youtubeChannel = await fetchOwnChannel(token.access_token);
    const sessionId = createRandomToken();
    const now = new Date().toISOString();
    const session = {
      sessionId,
      accessToken: token.access_token,
      profile,
      subscription: null,
      authenticatedAt: now,
      expiresAtMs: Date.now() + YOUTUBE_SESSION_TTL_MS
    };
    await refreshSession(session);
    sessions.set(sessionId, session);
    oauthStates.delete(state);
    setCookie(response, YOUTUBE_SESSION_COOKIE_NAME, sessionId, {
      path: "/api/",
      maxAge: YOUTUBE_SESSION_TTL_MS / 1000,
      httpOnly: true,
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });

    const url = new URL(returnUri);
    url.searchParams.set(YOUTUBE_COMPLETE_QUERY_PARAM, YOUTUBE_COMPLETE_QUERY_VALUE);
    redirect(response, url.toString());
  }

  async function handleSessionLookup(request, response, requestUrl) {
    const session = getSessionFromCookie(request);
    if (!session) {
      if (requestUrl.searchParams.get("optional") === "1") {
        writeJson(response, 200, { session: null });
        return;
      }
      throw new HttpError(401, "Sign in with YouTube first.");
    }
    await refreshSession(session);
    writeJson(response, 200, serializeSession(session));
  }

  async function handleLogout(request, response) {
    const sessionId = parseCookies(request)[YOUTUBE_SESSION_COOKIE_NAME];
    if (sessionId) sessions.delete(sessionId);
    clearCookie(response, YOUTUBE_SESSION_COOKIE_NAME, {
      path: "/api/",
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });
    writeJson(response, 200, { ok: true });
  }

  function getVerification(session) {
    return {
      connected: Boolean(session),
      authenticated: Boolean(session),
      verified: Boolean(session?.subscription?.subscribed),
      userId: session?.profile?.id || "",
      email: session?.profile?.email || "",
      displayName: getYouTubeDisplayName(session?.profile),
      picture: session?.profile?.picture || "",
      channelId: session?.profile?.youtubeChannel?.id || "",
      channelTitle: session?.profile?.youtubeChannel?.title || "",
      channelHandle: session?.profile?.youtubeChannel?.handle || "",
      channelUrl: session?.profile?.youtubeChannel?.url || "",
      targetChannelId: session?.subscription?.targetChannelId || getTargetChannelId(),
      targetChannelHandle: session?.subscription?.targetChannelHandle || getTargetChannelHandle(),
      targetChannelUrl: session?.subscription?.targetChannelUrl || getTargetChannelUrl(),
      targetChannelTitle: session?.subscription?.targetChannelTitle || "",
      subscribed: Boolean(session?.subscription?.subscribed),
      subscriptionCheckedAt: session?.subscription?.checkedAt || null,
      subscriptionCheckError: session?.subscription?.error || ""
    };
  }

  function buildSocialAccount(session, now) {
    if (!session?.profile?.id) return null;
    const channel = session.profile.youtubeChannel || null;
    return {
      provider: "youtube",
      providerUserId: channel?.id || session.profile.id,
      username: channel?.handle ? `@${channel.handle}` : "",
      displayName: channel?.title || session.profile.displayName || session.profile.email || "",
      profileUrl: channel?.url || "",
      avatarUrl: channel?.thumbnailUrl || session.profile.picture || "",
      connectedAt: session.authenticatedAt || now,
      rawProfile: session.profile,
      verifications: [{
        checkType: "youtube_channel_subscribed",
        targetId: session.subscription?.targetChannelId || getTargetChannelId() || getTargetChannelHandle(),
        status: getVerificationStatus(Boolean(session.subscription?.subscribed), session.subscription?.configured !== false),
        checkedAt: session.subscription?.checkedAt || session.authenticatedAt || now,
        rawResult: session.subscription || {}
      }]
    };
  }

  return {
    id: "youtube",
    routes: {
      "GET /api/youtube/start": { handler: handleStart },
      "GET /api/youtube/callback": { handler: handleCallback },
      "GET /api/youtube/session": { handler: handleSessionLookup, requireOrigin: true },
      "POST /api/youtube/logout": { handler: handleLogout, requireOrigin: true }
    },
    pruneExpired,
    getSessionFromCookie,
    refreshSession,
    serializeSession,
    getVerification,
    buildSocialAccount,
    getHealth() {
      return {
        youtubeApiConfigured: Boolean(getClientId() && getClientSecret() && getCallbackUrl()),
        youtubeTargetChannelHandle: getTargetChannelHandle(),
        youtubeTargetChannelIdConfigured: Boolean(getTargetChannelId())
      };
    },
    getPublicConfig() {
      return {
        socialLinks: {
          youtube: getTargetChannelUrl()
        },
        youtubeAuth: {
          enabled: Boolean(getClientId() && getClientSecret() && getCallbackUrl()),
          targetChannelHandle: getTargetChannelHandle(),
          targetChannelId: getTargetChannelId(),
          targetChannelUrl: getTargetChannelUrl()
        }
      };
    }
  };
}

module.exports = {
  createYouTubeProvider
};
