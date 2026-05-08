const LINKEDIN_COMPLETE_QUERY_PARAM = "linkedin_auth";
const LINKEDIN_COMPLETE_QUERY_VALUE = "complete";
const LINKEDIN_ERROR_QUERY_PARAM = "linkedin_error";

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

function cleanupLinkedInQueryParams() {
  const currentUrl = new URL(window.location.href);
  [LINKEDIN_COMPLETE_QUERY_PARAM, LINKEDIN_ERROR_QUERY_PARAM].forEach((key) => {
    currentUrl.searchParams.delete(key);
  });
  window.history.replaceState({}, document.title, currentUrl.toString());
}

function getBackendUrl(config = {}) {
  return String(config?.apiBaseUrl || config?.xAuth?.backendUrl || "").trim().replace(/\/+$/u, "");
}

function getLinkedInAuthConfig(config = {}) {
  const linkedinAuth = config?.linkedinAuth && typeof config.linkedinAuth === "object" ? config.linkedinAuth : {};
  return {
    enabled: linkedinAuth.enabled === true
  };
}

export function isLinkedInAuthConfigured(config = {}) {
  const authConfig = getLinkedInAuthConfig(config);
  return Boolean(getBackendUrl(config) && authConfig.enabled);
}

export async function startLinkedInLogin(config = {}) {
  const backendUrl = getBackendUrl(config);
  if (!backendUrl || !isLinkedInAuthConfigured(config)) {
    throw new Error("LinkedIn sign-in is not configured.");
  }

  const startUrl = new URL(`${backendUrl}/api/linkedin/start`);
  startUrl.searchParams.set("return_uri", config?.xAuth?.redirectUri || `${window.location.origin}${window.location.pathname}`);
  window.location.assign(startUrl.toString());
}

export async function fetchLinkedInSession(config = {}, { required = false } = {}) {
  const backendUrl = getBackendUrl(config);
  if (!backendUrl) return null;

  const sessionUrl = new URL(`${backendUrl}/api/linkedin/session`);
  if (!required) sessionUrl.searchParams.set("optional", "1");

  const response = await fetch(sessionUrl.toString(), {
    credentials: "include",
    cache: "no-store",
  });
  const payload = await parseJsonResponse(response);
  if (!required && payload?.session === null) return null;
  if (response.status === 401 && !required) return null;
  if (!response.ok) throw new Error(`LinkedIn sign-in failed: ${describeErrorPayload(payload)}`);
  return payload;
}

export async function logoutLinkedInSession(config = {}) {
  const backendUrl = getBackendUrl(config);
  if (!backendUrl) return;

  await fetch(`${backendUrl}/api/linkedin/logout`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => null);
}

export async function completeLinkedInLoginIfPresent(config = {}) {
  const params = new URLSearchParams(window.location.search);
  const hasCompletionSignal = params.get(LINKEDIN_COMPLETE_QUERY_PARAM) === LINKEDIN_COMPLETE_QUERY_VALUE;
  const authError = params.get(LINKEDIN_ERROR_QUERY_PARAM);
  const handled = hasCompletionSignal || Boolean(authError);

  try {
    if (authError) throw new Error(authError);
    const session = await fetchLinkedInSession(config, { required: hasCompletionSignal });
    return { handled, session };
  } finally {
    if (handled) cleanupLinkedInQueryParams();
  }
}
