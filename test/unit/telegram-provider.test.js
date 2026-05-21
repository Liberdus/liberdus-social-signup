const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const { createHttpUtils } = require("../../backend/lib/http-utils");
const { createTelegramProvider } = require("../../backend/lib/social/telegram");

const DEFAULT_RETURN_URL = "http://frontend.test/frontend/";
const BOT_TOKEN = "123456:test_secret";

function createMockResponse() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: "",
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    writeHead(statusCode, nextHeaders = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(nextHeaders)) {
        headers.set(name.toLowerCase(), value);
      }
    },
    end(value = "") {
      this.body += String(value || "");
    }
  };
}

function getSetCookies(response) {
  const value = response.getHeader("Set-Cookie") || [];
  return Array.isArray(value) ? value : [value];
}

function getCookieValue(response, name) {
  const prefix = `${name}=`;
  const cookie = getSetCookies(response).find((entry) => String(entry).startsWith(prefix));
  return cookie ? String(cookie).slice(prefix.length).split(";")[0] : "";
}

function createProvider() {
  const utils = createHttpUtils({
    defaultAllowedOrigin: "http://frontend.test",
    defaultFrontendReturnUrl: DEFAULT_RETURN_URL
  });
  return createTelegramProvider({
    ...utils,
    getVerificationStatus(isPassed, isConfigured = true) {
      if (!isConfigured) return "unknown";
      return isPassed ? "passed" : "failed";
    }
  });
}

function withTelegramEnv(fn) {
  const previousEnv = {
    SIGNUP_ALLOWED_ORIGINS: process.env.SIGNUP_ALLOWED_ORIGINS,
    SIGNUP_FRONTEND_RETURN_URL: process.env.SIGNUP_FRONTEND_RETURN_URL,
    SIGNUP_FRONTEND_RETURN_URLS: process.env.SIGNUP_FRONTEND_RETURN_URLS,
    SIGNUP_COOKIE_SECURE: process.env.SIGNUP_COOKIE_SECURE,
    TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID
  };

  process.env.SIGNUP_ALLOWED_ORIGINS = "http://frontend.test";
  process.env.SIGNUP_FRONTEND_RETURN_URL = DEFAULT_RETURN_URL;
  process.env.SIGNUP_FRONTEND_RETURN_URLS = DEFAULT_RETURN_URL;
  process.env.SIGNUP_COOKIE_SECURE = "false";
  process.env.TELEGRAM_BOT_USERNAME = "liberdus_test_bot";
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

function signTelegramPayload(payload) {
  const dataCheckString = Object.entries(payload)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  return crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
}

function createLoginSearchParams(extra = {}) {
  const payload = {
    id: "987654321",
    first_name: "Test",
    last_name: "User",
    username: "telegram_test",
    auth_date: String(Math.floor(Date.now() / 1000))
  };
  payload.hash = signTelegramPayload(payload);
  return new URLSearchParams({ ...payload, ...extra });
}

test("Telegram callback rejects a valid login payload without browser-bound state", async () => {
  await withTelegramEnv(async () => {
    const provider = createProvider();
    const response = createMockResponse();
    const params = createLoginSearchParams({ return_uri: DEFAULT_RETURN_URL });
    const requestUrl = new URL(`http://backend.test/api/telegram/callback?${params}`);

    await provider.routes["GET /api/telegram/callback"].handler({ headers: {} }, response, requestUrl);

    assert.equal(response.statusCode, 302);
    const location = new URL(response.getHeader("Location"));
    assert.equal(location.origin + location.pathname, DEFAULT_RETURN_URL);
    assert.equal(location.searchParams.get("telegram_error"), "Telegram sign-in expired. Try again.");
    assert.equal(getCookieValue(response, "liberdus_signup_telegram_session"), "");
  });
});

test("Telegram callback creates a session after init state and cookie validation", async () => {
  await withTelegramEnv(async () => {
    const provider = createProvider();
    const initResponse = createMockResponse();
    const initUrl = new URL(`http://backend.test/api/telegram/init?return_uri=${encodeURIComponent(DEFAULT_RETURN_URL)}`);

    assert.equal(provider.routes["POST /api/telegram/init"].requireOrigin, true);
    await provider.routes["POST /api/telegram/init"].handler({ headers: {} }, initResponse, initUrl);

    assert.equal(initResponse.statusCode, 200);
    const initPayload = JSON.parse(initResponse.body);
    const initCookie = getCookieValue(initResponse, "liberdus_signup_telegram_init");
    assert.ok(initPayload.state);
    assert.equal(decodeURIComponent(initCookie), initPayload.state);
    assert.match(initPayload.authUrl, /^http:\/\/backend\.test\/api\/telegram\/callback\?state=/u);

    const callbackResponse = createMockResponse();
    const params = createLoginSearchParams({ state: initPayload.state });
    const callbackUrl = new URL(`http://backend.test/api/telegram/callback?${params}`);
    const request = {
      headers: {
        cookie: `liberdus_signup_telegram_init=${encodeURIComponent(initPayload.state)}`
      }
    };

    await provider.routes["GET /api/telegram/callback"].handler(request, callbackResponse, callbackUrl);

    assert.equal(callbackResponse.statusCode, 302);
    const location = new URL(callbackResponse.getHeader("Location"));
    assert.equal(location.origin + location.pathname, DEFAULT_RETURN_URL);
    assert.equal(location.searchParams.get("telegram_auth"), "complete");
    assert.ok(getCookieValue(callbackResponse, "liberdus_signup_telegram_session"));
  });
});
