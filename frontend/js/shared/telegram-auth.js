const TELEGRAM_WIDGET_SCRIPT_URL = "https://telegram.org/js/telegram-widget.js?22";
const TELEGRAM_COMPLETE_QUERY_PARAM = "telegram_auth";
const TELEGRAM_COMPLETE_QUERY_VALUE = "complete";
const TELEGRAM_ERROR_QUERY_PARAM = "telegram_error";

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function describeErrorPayload(payload) {
  if (typeof payload?.error === "string" && payload.error.trim()) {
    return payload.error.trim();
  }
  return "Unexpected response from the signup backend.";
}

function cleanupTelegramQueryParams() {
  const currentUrl = new URL(window.location.href);
  [TELEGRAM_COMPLETE_QUERY_PARAM, TELEGRAM_ERROR_QUERY_PARAM].forEach((key) => {
    currentUrl.searchParams.delete(key);
  });
  window.history.replaceState({}, document.title, currentUrl.toString());
}

function getBackendUrl(config = {}) {
  return String(config?.apiBaseUrl || config?.xAuth?.backendUrl || "").trim().replace(/\/+$/u, "");
}

function getTelegramAuthConfig(config = {}) {
  const telegramAuth = config?.telegramAuth && typeof config.telegramAuth === "object" ? config.telegramAuth : {};
  return {
    enabled: telegramAuth.enabled !== false,
    botUsername: String(telegramAuth.botUsername || "").trim().replace(/^@/u, ""),
    botId: String(telegramAuth.botId || "").trim(),
    membershipConfigured: Boolean(telegramAuth.membershipConfigured)
  };
}

export function isTelegramAuthConfigured(config = {}) {
  const authConfig = getTelegramAuthConfig(config);
  return Boolean(getBackendUrl(config) && authConfig.enabled && authConfig.botId);
}

function loadTelegramScript() {
  if (window.Telegram?.Login?.auth) {
    return Promise.resolve();
  }

  const existingScript = document.querySelector(`script[src="${TELEGRAM_WIDGET_SCRIPT_URL}"]`);
  if (existingScript) {
    return new Promise((resolve, reject) => {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", () => reject(new Error("Unable to load Telegram sign-in.")), { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = TELEGRAM_WIDGET_SCRIPT_URL;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Unable to load Telegram sign-in.")), { once: true });
    document.head.append(script);
  });
}

function requestTelegramAuth(authConfig) {
  return new Promise((resolve, reject) => {
    try {
      window.Telegram.Login.auth({
        bot_id: authConfig.botId,
        request_access: "write"
      }, (authData) => {
        if (!authData) {
          reject(new Error("Telegram sign-in was cancelled."));
          return;
        }
        resolve(authData);
      });
    } catch (error) {
      reject(error);
    }
  });
}

export async function startTelegramLogin(config = {}) {
  const backendUrl = getBackendUrl(config);
  const authConfig = getTelegramAuthConfig(config);
  if (!backendUrl || !authConfig.enabled || !authConfig.botId) {
    throw new Error("Telegram sign-in is not configured.");
  }

  await loadTelegramScript();
  const authData = await requestTelegramAuth(authConfig);
  const response = await fetch(`${backendUrl}/api/telegram/verify`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(authData),
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok) throw new Error(`Telegram sign-in failed: ${describeErrorPayload(payload)}`);
  return payload;
}

export async function fetchTelegramSession(config = {}, { required = false } = {}) {
  const backendUrl = getBackendUrl(config);
  if (!backendUrl) return null;

  const sessionUrl = new URL(`${backendUrl}/api/telegram/session`);
  if (!required) sessionUrl.searchParams.set("optional", "1");

  const response = await fetch(sessionUrl.toString(), {
    credentials: "include",
    cache: "no-store",
  });
  const payload = await parseJsonResponse(response);
  if (!required && payload?.session === null) return null;
  if (response.status === 401 && !required) return null;
  if (!response.ok) throw new Error(`Telegram sign-in failed: ${describeErrorPayload(payload)}`);
  return payload;
}

export async function logoutTelegramSession(config = {}) {
  const backendUrl = getBackendUrl(config);
  if (!backendUrl) return;

  await fetch(`${backendUrl}/api/telegram/logout`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => null);
}

export async function completeTelegramLoginIfPresent(config = {}) {
  const params = new URLSearchParams(window.location.search);
  const hasCompletionSignal = params.get(TELEGRAM_COMPLETE_QUERY_PARAM) === TELEGRAM_COMPLETE_QUERY_VALUE;
  const authError = params.get(TELEGRAM_ERROR_QUERY_PARAM);
  const handled = hasCompletionSignal || Boolean(authError);

  try {
    if (authError) throw new Error(authError);
    const session = await fetchTelegramSession(config, { required: hasCompletionSignal });
    return { handled, session };
  } finally {
    if (handled) cleanupTelegramQueryParams();
  }
}
