const crypto = require("node:crypto");

class HttpError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.expose = options.expose !== false;
    this.headers = options.headers || {};
  }
}

function createRandomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function secureEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeUrlString(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  const url = new URL(value);
  url.hash = "";
  if (url.pathname.endsWith("/index.html")) {
    url.pathname = url.pathname.slice(0, -"index.html".length);
  }
  return url.toString();
}

function parseCookies(request) {
  const rawCookie = String(request.headers.cookie || "");
  if (!rawCookie) return {};

  return rawCookie.split(";").reduce((cookies, chunk) => {
    const separatorIndex = chunk.indexOf("=");
    if (separatorIndex < 0) return cookies;
    const name = chunk.slice(0, separatorIndex).trim();
    const value = chunk.slice(separatorIndex + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function appendSetCookie(response, cookieValue) {
  const existing = response.getHeader("Set-Cookie");
  response.setHeader("Set-Cookie", existing ? [...(Array.isArray(existing) ? existing : [existing]), cookieValue] : [cookieValue]);
}

function serializeCookie(name, value, options = {}) {
  const segments = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path || "/"}`];
  if (typeof options.maxAge === "number") segments.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.httpOnly !== false) segments.push("HttpOnly");
  if (options.sameSite) segments.push(`SameSite=${options.sameSite}`);
  if (options.secure) segments.push("Secure");
  return segments.join("; ");
}

function setCookie(response, name, value, options = {}) {
  appendSetCookie(response, serializeCookie(name, value, options));
}

function clearCookie(response, name, options = {}) {
  setCookie(response, name, "", { ...options, maxAge: 0 });
}

function setStandardHeaders(response) {
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Permissions-Policy", "interest-cohort=()");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-site");
}

function writeJson(response, statusCode, value, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, private, max-age=0",
    Pragma: "no-cache",
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    ...headers
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function writeText(response, statusCode, value, contentType, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store, private, max-age=0",
    Pragma: "no-cache",
    ...headers
  });
  response.end(String(value || ""));
}

function redirect(response, location) {
  response.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store, private, max-age=0",
    Pragma: "no-cache"
  });
  response.end();
}

function createHttpUtils({
  defaultAllowedOrigin,
  defaultFrontendReturnUrl,
  maxJsonBodyBytes = 64 * 1024
} = {}) {
  function getAllowedOrigins() {
    return String(process.env.SIGNUP_ALLOWED_ORIGINS || defaultAllowedOrigin)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  function getDefaultFrontendReturnUrl() {
    return normalizeUrlString(process.env.SIGNUP_FRONTEND_RETURN_URL || defaultFrontendReturnUrl);
  }

  function getAllowedReturnUrls() {
    return String(process.env.SIGNUP_FRONTEND_RETURN_URLS || getDefaultFrontendReturnUrl())
      .split(",")
      .map((value) => normalizeUrlString(value))
      .filter(Boolean);
  }

  function validateReturnUri(returnUri) {
    const normalized = normalizeUrlString(returnUri || getDefaultFrontendReturnUrl());
    if (!normalized || !getAllowedReturnUrls().includes(normalized)) {
      throw new HttpError(400, "Frontend return URI is not allowed.");
    }
    return normalized;
  }

  function getCookieSecureMode() {
    return String(process.env.SIGNUP_COOKIE_SECURE || "auto").trim().toLowerCase();
  }

  function shouldUseSecureCookies() {
    const mode = getCookieSecureMode();
    if (mode === "true") return true;
    if (mode === "false") return false;
    try {
      return new URL(getDefaultFrontendReturnUrl()).protocol === "https:";
    } catch {
      return false;
    }
  }

  function getCorsOrigin(origin) {
    return origin && getAllowedOrigins().includes(origin) ? origin : "";
  }

  function setCorsHeaders(request, response) {
    const origin = getCorsOrigin(String(request.headers.origin || ""));
    if (!origin) return false;
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token, X-Admin-Token");
    response.setHeader("Access-Control-Max-Age", "600");
    response.setHeader("Vary", "Origin, Access-Control-Request-Headers");
    return true;
  }

  function requireAllowedOrigin(request, response) {
    const origin = String(request.headers.origin || "").trim();
    if (!origin || !setCorsHeaders(request, response)) {
      throw new HttpError(403, "Origin is not allowed.");
    }
  }

  function readJsonRequest(request, maxBytes = maxJsonBodyBytes) {
    return new Promise((resolve, reject) => {
      let rawBody = "";
      request.on("data", (chunk) => {
        rawBody += chunk;
        if (Buffer.byteLength(rawBody, "utf8") > maxBytes) {
          rawBody = "";
          reject(new HttpError(413, "Request body is too large."));
          request.destroy();
        }
      });
      request.on("end", () => {
        if (!rawBody) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(rawBody));
        } catch {
          reject(new HttpError(400, "Request body must be valid JSON."));
        }
      });
      request.on("error", reject);
    });
  }

  function handleOptions(request, response) {
    if (!setCorsHeaders(request, response)) {
      throw new HttpError(403, "Origin is not allowed.");
    }
    response.writeHead(204, {
      "Cache-Control": "no-store, private, max-age=0",
      Pragma: "no-cache"
    });
    response.end();
  }

  function getPublicErrorMessage(error, fallback) {
    if (error instanceof HttpError && error.expose) return error.message;
    return fallback;
  }

  function handleError(response, error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const headers = error instanceof HttpError ? error.headers : {};
    if (!(error instanceof HttpError) || statusCode >= 500) {
      console.error("[Liberdus signup server]", error);
    }
    writeJson(response, statusCode, {
      error: getPublicErrorMessage(error, "Request failed.")
    }, headers);
  }

  return {
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
    setCorsHeaders,
    requireAllowedOrigin,
    writeJson,
    writeText,
    redirect,
    readJsonRequest,
    handleOptions,
    getPublicErrorMessage,
    handleError
  };
}

module.exports = {
  HttpError,
  createHttpUtils,
  createRandomToken,
  secureEquals,
  normalizeUrlString,
  parseCookies,
  setCookie,
  clearCookie,
  setStandardHeaders,
  writeJson,
  writeText,
  redirect
};
