async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function getErrorMessage(payload, fallback) {
  return String(payload?.error || payload?.detail || fallback || "Request failed.");
}

export async function apiFetch(config, path, options = {}) {
  const baseUrl = String(config?.apiBaseUrl || config?.xAuth?.backendUrl || "").replace(/\/+$/u, "");
  if (!baseUrl) throw new Error("API backend is not configured.");

  const response = await fetch(`${baseUrl}${path}`, {
    credentials: "include",
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    const error = new Error(getErrorMessage(payload, `HTTP ${response.status}`));
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

