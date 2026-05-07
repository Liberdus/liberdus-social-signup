import { UI_ROOT } from "./constants.js";

function isLocalhost() {
  return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
}

function getCurrentReturnUri() {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  if (url.pathname.endsWith("/index.html")) {
    url.pathname = url.pathname.slice(0, -"index.html".length);
  }
  return url.toString();
}

export async function loadUiConfig() {
  let loaded = null;
  let source = "config.json";

  if (isLocalhost()) {
    try {
      const localResponse = await fetch(new URL("./config.local.json", UI_ROOT), { cache: "no-store" });
      if (localResponse.ok) {
        loaded = await localResponse.json();
        source = "config.local.json";
      }
    } catch {
      // Fall back to committed config.
    }
  }

  if (!loaded) {
    const response = await fetch(new URL("./config.json", UI_ROOT), { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to load frontend config.json.");
    loaded = await response.json();
  }

  const apiBaseUrl = String(loaded.apiBaseUrl || loaded.xBackendUrl || "").trim().replace(/\/+$/u, "");
  const xAuth = loaded.xAuth && typeof loaded.xAuth === "object" ? loaded.xAuth : {};
  const redirectUri = String(xAuth.redirectUri || "").trim() || getCurrentReturnUri();

  return {
    source,
    config: {
      ...loaded,
      apiBaseUrl,
      xAuth: {
        enabled: xAuth.enabled !== false,
        backendUrl: String(xAuth.backendUrl || apiBaseUrl || "").trim().replace(/\/+$/u, ""),
        redirectUri
      },
      socialLinks: loaded.socialLinks && typeof loaded.socialLinks === "object" ? loaded.socialLinks : {}
    }
  };
}
