const GITHUB_COMPLETE_QUERY_PARAM = "github_auth";
const GITHUB_COMPLETE_QUERY_VALUE = "complete";
const GITHUB_ERROR_QUERY_PARAM = "github_error";

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

function cleanupGitHubQueryParams() {
  const currentUrl = new URL(window.location.href);
  [GITHUB_COMPLETE_QUERY_PARAM, GITHUB_ERROR_QUERY_PARAM].forEach((key) => {
    currentUrl.searchParams.delete(key);
  });
  window.history.replaceState({}, document.title, currentUrl.toString());
}

function getBackendUrl(config = {}) {
  return String(config?.apiBaseUrl || config?.xAuth?.backendUrl || "").trim().replace(/\/+$/u, "");
}

function getGitHubAuthConfig(config = {}) {
  const githubAuth = config?.githubAuth && typeof config.githubAuth === "object" ? config.githubAuth : {};
  return {
    enabled: githubAuth.enabled === true
  };
}

export function isGitHubAuthConfigured(config = {}) {
  const authConfig = getGitHubAuthConfig(config);
  return Boolean(getBackendUrl(config) && authConfig.enabled);
}

export async function startGitHubLogin(config = {}) {
  const backendUrl = getBackendUrl(config);
  if (!backendUrl || !isGitHubAuthConfigured(config)) {
    throw new Error("GitHub sign-in is not configured.");
  }

  const startUrl = new URL(`${backendUrl}/api/github/start`);
  startUrl.searchParams.set("return_uri", config?.xAuth?.redirectUri || `${window.location.origin}${window.location.pathname}`);
  window.location.assign(startUrl.toString());
}

export async function fetchGitHubSession(config = {}, { required = false } = {}) {
  const backendUrl = getBackendUrl(config);
  if (!backendUrl) return null;

  const sessionUrl = new URL(`${backendUrl}/api/github/session`);
  if (!required) sessionUrl.searchParams.set("optional", "1");

  const response = await fetch(sessionUrl.toString(), {
    credentials: "include",
    cache: "no-store"
  });
  const payload = await parseJsonResponse(response);
  if (!required && payload?.session === null) return null;
  if (response.status === 401 && !required) return null;
  if (!response.ok) throw new Error(`GitHub sign-in failed: ${describeErrorPayload(payload)}`);
  return payload;
}

export async function logoutGitHubSession(config = {}) {
  const backendUrl = getBackendUrl(config);
  if (!backendUrl) return;

  await fetch(`${backendUrl}/api/github/logout`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  }).catch(() => null);
}

export async function completeGitHubLoginIfPresent(config = {}) {
  const params = new URLSearchParams(window.location.search);
  const hasCompletionSignal = params.get(GITHUB_COMPLETE_QUERY_PARAM) === GITHUB_COMPLETE_QUERY_VALUE;
  const authError = params.get(GITHUB_ERROR_QUERY_PARAM);
  const handled = hasCompletionSignal || Boolean(authError);

  try {
    if (authError) throw new Error(authError);
    const session = await fetchGitHubSession(config, { required: hasCompletionSignal });
    return { handled, session };
  } finally {
    if (handled) cleanupGitHubQueryParams();
  }
}
