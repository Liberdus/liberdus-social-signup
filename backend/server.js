const http = require("node:http");
const path = require("node:path");

const dotenv = require("dotenv");
const { createAdminController } = require("./lib/admin-controller");
const { openDatabase, getDatabasePath } = require("./lib/db");
const { createHttpUtils } = require("./lib/http-utils");
const { createRequestThrottles } = require("./lib/rate-limiter");
const { createSignupController } = require("./lib/signup-controller");
const { createSignupStore } = require("./lib/signup-store");
const { createSocialProviders } = require("./lib/social");

dotenv.config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const HOST = process.env.SIGNUP_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.SIGNUP_PORT || "8788", 10);
const DEFAULT_ALLOWED_ORIGIN = "http://127.0.0.1:5503";
const DEFAULT_FRONTEND_RETURN_URL = "http://127.0.0.1:5503/frontend/";
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
const throttles = createRequestThrottles({ HttpError });

let adminController;
let socialProviders;
let signupController;

const db = openDatabase();
const signupStore = createSignupStore(db);

function isE2ETestMode() {
  return /^(1|true|yes)$/iu.test(String(process.env.E2E_TEST_MODE || "").trim());
}

function pruneExpiredState() {
  const now = Date.now();
  socialProviders?.pruneExpired(now);
  signupController?.pruneExpired(now);
  adminController?.pruneExpired(now);
  throttles.pruneExpired(now);
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

signupController = createSignupController({
  HttpError,
  createRandomToken,
  parseCookies,
  setCookie,
  clearCookie,
  shouldUseSecureCookies,
  writeJson,
  readJsonRequest,
  signupStore,
  socialProviders
});

adminController = createAdminController({
  HttpError,
  createRandomToken,
  secureEquals,
  writeJson,
  writeText,
  readJsonRequest,
  signupStore,
  throttles
});

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
      throttles.assertSocialFlowAllowed(request, `${request.method} ${pathname}`);
      await socialRoute.handler(request, response, requestUrl);
      return;
    }

    if (request.method === "POST" && pathname === "/api/signup/challenge") {
      requireAllowedOrigin(request, response);
      throttles.assertSignupWriteAllowed(request, "challenge");
      await signupController.handleChallenge(request, response);
      return;
    }

    if (request.method === "POST" && pathname === "/api/signup/wallet/verify") {
      requireAllowedOrigin(request, response);
      throttles.assertSignupWriteAllowed(request, "wallet-verify");
      await signupController.handleWalletVerify(request, response);
      return;
    }

    if (request.method === "GET" && pathname === "/api/signup/session") {
      requireAllowedOrigin(request, response);
      throttles.assertSignupReadAllowed(request, "session");
      await signupController.handleSessionLookup(request, response);
      return;
    }

    if (request.method === "POST" && pathname === "/api/signup/session/reset") {
      requireAllowedOrigin(request, response);
      throttles.assertSignupWriteAllowed(request, "session-reset");
      await signupController.handleSessionReset(request, response);
      return;
    }

    if (request.method === "POST" && pathname === "/api/signup/complete") {
      requireAllowedOrigin(request, response);
      throttles.assertSignupWriteAllowed(request, "complete");
      await signupController.handleComplete(request, response);
      return;
    }

    if (request.method === "POST" && pathname === "/api/admin/login") {
      requireAllowedOrigin(request, response);
      await adminController.handleLogin(request, response);
      return;
    }

    if (request.method === "POST" && pathname === "/api/admin/logout") {
      requireAllowedOrigin(request, response);
      await adminController.handleLogout(request, response);
      return;
    }

    if (request.method === "GET" && pathname === "/api/admin/signups") {
      requireAllowedOrigin(request, response);
      adminController.handleSignupList(request, response, requestUrl);
      return;
    }

    if (request.method === "GET" && pathname === "/api/admin/signups/export") {
      requireAllowedOrigin(request, response);
      adminController.handleSignupExport(request, response, requestUrl);
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
