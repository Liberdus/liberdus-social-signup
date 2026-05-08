const YOUTUBE_COMPLETE_QUERY_PARAM = "youtube_auth";
const YOUTUBE_COMPLETE_QUERY_VALUE = "complete";
const YOUTUBE_ERROR_QUERY_PARAM = "youtube_error";

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

function cleanupYouTubeQueryParams() {
  const currentUrl = new URL(window.location.href);
  [YOUTUBE_COMPLETE_QUERY_PARAM, YOUTUBE_ERROR_QUERY_PARAM].forEach((key) => {
    currentUrl.searchParams.delete(key);
  });
  window.history.replaceState({}, document.title, currentUrl.toString());
}

function getBackendUrl(config = {}) {
  return String(config?.apiBaseUrl || config?.xAuth?.backendUrl || "").trim().replace(/\/+$/u, "");
}

function getYouTubeAuthConfig(config = {}) {
  const youtubeAuth = config?.youtubeAuth && typeof config.youtubeAuth === "object" ? config.youtubeAuth : {};
  return {
    enabled: youtubeAuth.enabled === true
  };
}

export function isYouTubeAuthConfigured(config = {}) {
  const authConfig = getYouTubeAuthConfig(config);
  return Boolean(getBackendUrl(config) && authConfig.enabled);
}

export async function startYouTubeLogin(config = {}) {
  const backendUrl = getBackendUrl(config);
  if (!backendUrl || !isYouTubeAuthConfigured(config)) {
    throw new Error("YouTube sign-in is not configured.");
  }

  const startUrl = new URL(`${backendUrl}/api/youtube/start`);
  startUrl.searchParams.set("return_uri", config?.xAuth?.redirectUri || `${window.location.origin}${window.location.pathname}`);
  window.location.assign(startUrl.toString());
}

export async function fetchYouTubeSession(config = {}, { required = false } = {}) {
  const backendUrl = getBackendUrl(config);
  if (!backendUrl) return null;

  const sessionUrl = new URL(`${backendUrl}/api/youtube/session`);
  if (!required) sessionUrl.searchParams.set("optional", "1");

  const response = await fetch(sessionUrl.toString(), {
    credentials: "include",
    cache: "no-store"
  });
  const payload = await parseJsonResponse(response);
  if (!required && payload?.session === null) return null;
  if (response.status === 401 && !required) return null;
  if (!response.ok) throw new Error(`YouTube sign-in failed: ${describeErrorPayload(payload)}`);
  return payload;
}

export async function logoutYouTubeSession(config = {}) {
  const backendUrl = getBackendUrl(config);
  if (!backendUrl) return;

  await fetch(`${backendUrl}/api/youtube/logout`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  }).catch(() => null);
}

export async function completeYouTubeLoginIfPresent(config = {}) {
  const params = new URLSearchParams(window.location.search);
  const hasCompletionSignal = params.get(YOUTUBE_COMPLETE_QUERY_PARAM) === YOUTUBE_COMPLETE_QUERY_VALUE;
  const authError = params.get(YOUTUBE_ERROR_QUERY_PARAM);
  const handled = hasCompletionSignal || Boolean(authError);

  try {
    if (authError) throw new Error(authError);
    const session = await fetchYouTubeSession(config, { required: hasCompletionSignal });
    return { handled, session };
  } finally {
    if (handled) cleanupYouTubeQueryParams();
  }
}
