const DISCORD_COMPLETE_QUERY_PARAM = "discord_auth";
const DISCORD_COMPLETE_QUERY_VALUE = "complete";
const DISCORD_ERROR_QUERY_PARAM = "discord_error";

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

function cleanupDiscordQueryParams() {
  const currentUrl = new URL(window.location.href);
  [DISCORD_COMPLETE_QUERY_PARAM, DISCORD_ERROR_QUERY_PARAM].forEach((key) => {
    currentUrl.searchParams.delete(key);
  });
  window.history.replaceState({}, document.title, currentUrl.toString());
}

function getBackendUrl(config = {}) {
  return String(config?.apiBaseUrl || config?.xAuth?.backendUrl || "").trim().replace(/\/+$/u, "");
}

export function isDiscordAuthConfigured(config = {}) {
  return Boolean(getBackendUrl(config));
}

export async function startDiscordLogin(config = {}) {
  const backendUrl = getBackendUrl(config);
  if (!backendUrl) throw new Error("Discord sign-in is not configured.");

  const startUrl = new URL(`${backendUrl}/api/discord/start`);
  startUrl.searchParams.set("return_uri", config?.xAuth?.redirectUri || `${window.location.origin}${window.location.pathname}`);
  window.location.assign(startUrl.toString());
}

export async function fetchDiscordSession(config = {}, { required = false } = {}) {
  const backendUrl = getBackendUrl(config);
  if (!backendUrl) return null;

  const sessionUrl = new URL(`${backendUrl}/api/discord/session`);
  if (!required) sessionUrl.searchParams.set("optional", "1");

  const response = await fetch(sessionUrl.toString(), {
    credentials: "include",
    cache: "no-store",
  });
  const payload = await parseJsonResponse(response);
  if (!required && payload?.session === null) return null;
  if (response.status === 401 && !required) return null;
  if (!response.ok) throw new Error(`Discord sign-in failed: ${describeErrorPayload(payload)}`);
  return payload;
}

export async function logoutDiscordSession(config = {}) {
  const backendUrl = getBackendUrl(config);
  if (!backendUrl) return;

  await fetch(`${backendUrl}/api/discord/logout`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => null);
}

export async function completeDiscordLoginIfPresent(config = {}) {
  const params = new URLSearchParams(window.location.search);
  const hasCompletionSignal = params.get(DISCORD_COMPLETE_QUERY_PARAM) === DISCORD_COMPLETE_QUERY_VALUE;
  const authError = params.get(DISCORD_ERROR_QUERY_PARAM);
  const handled = hasCompletionSignal || Boolean(authError);

  try {
    if (authError) throw new Error(authError);
    const session = await fetchDiscordSession(config, { required: hasCompletionSignal });
    return { handled, session };
  } finally {
    if (handled) cleanupDiscordQueryParams();
  }
}
