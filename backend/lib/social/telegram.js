const crypto = require("node:crypto");

const TELEGRAM_BOT_API_BASE_URL = "https://api.telegram.org";
const TELEGRAM_SESSION_COOKIE_NAME = "liberdus_signup_telegram_session";
const TELEGRAM_COMPLETE_QUERY_PARAM = "telegram_auth";
const TELEGRAM_COMPLETE_QUERY_VALUE = "complete";
const TELEGRAM_ERROR_QUERY_PARAM = "telegram_error";
const TELEGRAM_SESSION_TTL_MS = 30 * 60 * 1000;
const TELEGRAM_LOGIN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function createTelegramProvider(context) {
  const {
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
    getPublicErrorMessage,
    getVerificationStatus
  } = context;

  const sessions = new Map();

  function getBotUsername() {
    return String(process.env.TELEGRAM_BOT_USERNAME || "").trim().replace(/^@/u, "");
  }

  function getBotToken() {
    return String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  }

  function getBotId() {
    return getBotToken().match(/^(\d+):/u)?.[1] || "";
  }

  function getChatId() {
    return String(process.env.TELEGRAM_CHAT_ID || "").trim();
  }

  function getInviteUrl() {
    return String(process.env.TELEGRAM_INVITE_URL || "").trim();
  }

  function getLoginPayload(source) {
    const payload = {};
    for (const key of ["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"]) {
      const value = source?.get ? source.get(key) : source?.[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        payload[key] = String(value).trim();
      }
    }
    return payload;
  }

  function verifyLoginPayload(payload) {
    const botToken = getBotToken();
    if (!getBotUsername() || !botToken) {
      throw new HttpError(500, "Missing Telegram bot username or token in .env.", { expose: false });
    }
    if (!payload?.id || !payload?.auth_date || !payload?.hash) {
      throw new HttpError(400, "Telegram sign-in response is incomplete.");
    }

    const authDateMs = Number(payload.auth_date) * 1000;
    if (!Number.isFinite(authDateMs) || authDateMs <= 0) {
      throw new HttpError(400, "Telegram sign-in timestamp is invalid.");
    }
    if (Date.now() - authDateMs > TELEGRAM_LOGIN_MAX_AGE_MS || authDateMs - Date.now() > 5 * 60 * 1000) {
      throw new HttpError(400, "Telegram sign-in response expired. Try again.");
    }

    const dataCheckString = Object.entries(payload)
      .filter(([key]) => key !== "hash")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    const secretKey = crypto.createHash("sha256").update(botToken).digest();
    const expectedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (!secureEquals(expectedHash, payload.hash)) {
      throw new HttpError(400, "Telegram sign-in response could not be verified.");
    }
  }

  function normalizeProfile(payload) {
    const firstName = String(payload.first_name || "").trim();
    const lastName = String(payload.last_name || "").trim();
    const username = String(payload.username || "").trim();
    return {
      id: String(payload.id || "").trim(),
      username,
      firstName,
      lastName,
      displayName: [firstName, lastName].filter(Boolean).join(" ") || username || String(payload.id || "").trim(),
      photoUrl: String(payload.photo_url || "").trim()
    };
  }

  async function fetchBotApi(method, params = {}) {
    const botToken = getBotToken();
    if (!botToken) {
      throw new HttpError(500, "Missing Telegram bot token in .env.", { expose: false });
    }
    const url = new URL(`${TELEGRAM_BOT_API_BASE_URL}/bot${botToken}/${method}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && String(value) !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await fetch(url);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const description = String(payload.description || "").trim();
      const notMember = /user not found|participant_id_invalid|member not found/iu.test(description);
      if (method === "getChatMember" && response.status === 400 && notMember) {
        return null;
      }
      console.error(`[Telegram ${method}] HTTP ${response.status}: ${JSON.stringify(payload)}`);
      throw new HttpError(502, "Telegram membership lookup failed.", { expose: false });
    }
    return payload.result;
  }

  async function fetchMembership(userId) {
    const chatId = getChatId();
    if (!chatId) {
      return { configured: false, isMember: false, chatId: "", status: "", checkedAt: null };
    }
    const checkedAt = new Date().toISOString();
    const member = await fetchBotApi("getChatMember", {
      chat_id: chatId,
      user_id: userId
    });
    const status = String(member?.status || "").trim();
    const isMember = ["creator", "administrator", "member"].includes(status)
      || (status === "restricted" && member?.is_member === true);
    return {
      configured: true,
      isMember,
      chatId,
      status,
      checkedAt
    };
  }

  function pruneExpired(now) {
    for (const [key, session] of sessions.entries()) {
      if (session.expiresAtMs <= now) sessions.delete(key);
    }
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

  function getSessionFromCookie(request) {
    const sessionId = parseCookies(request)[TELEGRAM_SESSION_COOKIE_NAME];
    return sessionId ? sessions.get(sessionId) || null : null;
  }

  async function createSession(response, loginPayload) {
    verifyLoginPayload(loginPayload);
    const profile = normalizeProfile(loginPayload);
    if (!profile.id) {
      throw new HttpError(400, "Telegram did not return a usable profile.");
    }

    const membership = await fetchMembership(profile.id);
    const sessionId = createRandomToken();
    const now = new Date().toISOString();
    const session = {
      sessionId,
      profile,
      membership,
      authenticatedAt: now,
      expiresAtMs: Date.now() + TELEGRAM_SESSION_TTL_MS
    };
    sessions.set(sessionId, session);
    setCookie(response, TELEGRAM_SESSION_COOKIE_NAME, sessionId, {
      path: "/api/",
      maxAge: TELEGRAM_SESSION_TTL_MS / 1000,
      httpOnly: true,
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });
    return session;
  }

  async function handleCallback(request, response, requestUrl) {
    const returnUri = validateReturnUri(requestUrl.searchParams.get("return_uri"));
    const loginPayload = getLoginPayload(requestUrl.searchParams);

    try {
      await createSession(response, loginPayload);

      const url = new URL(returnUri);
      url.searchParams.set(TELEGRAM_COMPLETE_QUERY_PARAM, TELEGRAM_COMPLETE_QUERY_VALUE);
      redirect(response, url.toString());
    } catch (error) {
      const url = new URL(returnUri);
      url.searchParams.set(TELEGRAM_ERROR_QUERY_PARAM, getPublicErrorMessage(error, "Telegram sign-in failed."));
      redirect(response, url.toString());
    }
  }

  async function handleVerify(request, response) {
    const body = await readJsonRequest(request);
    const session = await createSession(response, getLoginPayload(body));
    writeJson(response, 200, serializeSession(session));
  }

  async function handleSessionLookup(request, response, requestUrl) {
    const session = getSessionFromCookie(request);
    if (!session) {
      if (requestUrl.searchParams.get("optional") === "1") {
        writeJson(response, 200, { session: null });
        return;
      }
      throw new HttpError(401, "Sign in with Telegram first.");
    }
    writeJson(response, 200, serializeSession(session));
  }

  async function handleLogout(request, response) {
    const sessionId = parseCookies(request)[TELEGRAM_SESSION_COOKIE_NAME];
    if (sessionId) sessions.delete(sessionId);
    clearCookie(response, TELEGRAM_SESSION_COOKIE_NAME, {
      path: "/api/",
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });
    writeJson(response, 200, { ok: true });
  }

  function getVerification(session) {
    return {
      connected: Boolean(session),
      verified: Boolean(session?.membership?.isMember),
      userId: session?.profile?.id || "",
      username: session?.profile?.username || "",
      displayName: session?.profile?.displayName || "",
      chatId: session?.membership?.chatId || "",
      status: session?.membership?.status || "",
      membershipCheckedAt: session?.membership?.checkedAt || null
    };
  }

  function buildSocialAccount(session, now) {
    if (!session?.profile?.id) return null;
    return {
      provider: "telegram",
      providerUserId: session.profile.id,
      username: session.profile.username || "",
      displayName: session.profile.displayName || session.profile.username || "",
      profileUrl: session.profile.username ? `https://t.me/${session.profile.username}` : "",
      avatarUrl: session.profile.photoUrl || "",
      connectedAt: session.authenticatedAt || now,
      rawProfile: session.profile,
      verifications: [{
        checkType: "telegram_group_member",
        targetId: session.membership?.chatId || "",
        status: getVerificationStatus(Boolean(session.membership?.isMember), session.membership?.configured !== false),
        checkedAt: session.membership?.checkedAt || session.authenticatedAt || now,
        rawResult: session.membership || {}
      }]
    };
  }

  return {
    id: "telegram",
    routes: {
      "GET /api/telegram/callback": { handler: handleCallback },
      "POST /api/telegram/verify": { handler: handleVerify, requireOrigin: true },
      "GET /api/telegram/session": { handler: handleSessionLookup, requireOrigin: true },
      "POST /api/telegram/logout": { handler: handleLogout, requireOrigin: true }
    },
    pruneExpired,
    getSessionFromCookie,
    serializeSession,
    getVerification,
    buildSocialAccount,
    getHealth() {
      return {
        telegramBotConfigured: Boolean(getBotUsername() && getBotToken()),
        telegramChatConfigured: Boolean(getChatId())
      };
    },
    getPublicConfig() {
      return {
        socialLinks: getInviteUrl() ? { telegram: getInviteUrl() } : {},
        telegramAuth: {
          enabled: Boolean(getBotUsername() && getBotToken()),
          botUsername: getBotUsername(),
          botId: getBotId(),
          membershipConfigured: Boolean(getChatId())
        }
      };
    }
  };
}

module.exports = {
  createTelegramProvider
};
