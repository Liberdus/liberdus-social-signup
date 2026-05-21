const DEFAULT_MAX_KEYS = 5000;

function isEnabled(value) {
  return /^(1|true|yes)$/iu.test(String(value || "").trim());
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getEnvInteger(name, fallback) {
  return parsePositiveInteger(process.env[name], fallback);
}

function getRetryAfterSeconds(retryAfterMs) {
  return String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
}

function normalizeKeyPart(value, fallback = "unknown") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .slice(0, 200);
  return normalized || fallback;
}

function getForwardedClientIp(request) {
  const forwardedFor = String(request.headers["x-forwarded-for"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)[0];
  return forwardedFor || String(request.headers["x-real-ip"] || "").trim();
}

function getClientIp(request) {
  const proxyIp = isEnabled(process.env.SIGNUP_TRUST_PROXY)
    ? getForwardedClientIp(request)
    : "";
  return normalizeKeyPart(
    proxyIp || String(request.socket?.remoteAddress || "").replace(/^::ffff:/u, ""),
    "unknown-ip"
  );
}

function createTooManyRequestsError(HttpError, message, retryAfterMs, extraHeaders = {}) {
  return new HttpError(429, message, {
    headers: {
      "Retry-After": getRetryAfterSeconds(retryAfterMs),
      ...extraHeaders
    }
  });
}

function createFixedWindowRateLimiter({
  HttpError,
  limit,
  windowMs,
  blockMs = windowMs,
  message = "Too many requests. Try again later.",
  maxKeys = DEFAULT_MAX_KEYS
}) {
  const entries = new Map();
  let pruneCounter = 0;

  function pruneExpired(now = Date.now()) {
    for (const [key, entry] of entries.entries()) {
      const windowExpired = entry.windowStartMs + windowMs <= now;
      const blockExpired = !entry.blockedUntilMs || entry.blockedUntilMs <= now;
      if (windowExpired && blockExpired) entries.delete(key);
    }
  }

  function pruneOverflow() {
    if (entries.size <= maxKeys) return;
    const overflow = entries.size - maxKeys;
    let removed = 0;
    for (const key of entries.keys()) {
      entries.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }

  function getEntry(key, now) {
    const normalizedKey = normalizeKeyPart(key);
    const existing = entries.get(normalizedKey);
    if (existing && existing.windowStartMs + windowMs > now) return existing;
    const entry = {
      count: 0,
      windowStartMs: now,
      blockedUntilMs: existing?.blockedUntilMs > now ? existing.blockedUntilMs : 0
    };
    entries.set(normalizedKey, entry);
    return entry;
  }

  function consume(key, { now = Date.now(), cost = 1 } = {}) {
    if (limit <= 0) return;
    pruneCounter += 1;
    if (pruneCounter % 100 === 0) pruneExpired(now);

    const entry = getEntry(key, now);
    if (entry.blockedUntilMs > now) {
      throw createTooManyRequestsError(HttpError, message, entry.blockedUntilMs - now);
    }

    entry.count += Math.max(1, cost);
    if (entry.count > limit) {
      entry.blockedUntilMs = now + blockMs;
      throw createTooManyRequestsError(HttpError, message, blockMs);
    }

    pruneOverflow();
  }

  function reset(key) {
    entries.delete(normalizeKeyPart(key));
  }

  function getSnapshot(key) {
    return entries.get(normalizeKeyPart(key)) || null;
  }

  return {
    consume,
    reset,
    pruneExpired,
    getSnapshot
  };
}

function createRequestThrottles({ HttpError }) {
  const disabled = isEnabled(process.env.SIGNUP_RATE_LIMIT_DISABLED);
  const adminWindowMs = getEnvInteger("SIGNUP_ADMIN_LOGIN_WINDOW_SECONDS", 15 * 60) * 1000;
  const adminBlockMs = getEnvInteger("SIGNUP_ADMIN_LOGIN_BLOCK_SECONDS", 15 * 60) * 1000;
  const signupWindowMs = getEnvInteger("SIGNUP_SIGNUP_RATE_WINDOW_SECONDS", 10 * 60) * 1000;
  const socialWindowMs = getEnvInteger("SIGNUP_SOCIAL_RATE_WINDOW_SECONDS", 10 * 60) * 1000;

  const adminIpLimiter = createFixedWindowRateLimiter({
    HttpError,
    limit: getEnvInteger("SIGNUP_ADMIN_LOGIN_IP_LIMIT", 20),
    windowMs: adminWindowMs,
    blockMs: adminBlockMs,
    message: "Too many admin login attempts. Try again later."
  });
  const adminUsernameLimiter = createFixedWindowRateLimiter({
    HttpError,
    limit: getEnvInteger("SIGNUP_ADMIN_LOGIN_USERNAME_LIMIT", 8),
    windowMs: adminWindowMs,
    blockMs: adminBlockMs,
    message: "Too many admin login attempts. Try again later."
  });
  const signupWriteLimiter = createFixedWindowRateLimiter({
    HttpError,
    limit: getEnvInteger("SIGNUP_WRITE_IP_LIMIT", 30),
    windowMs: signupWindowMs,
    blockMs: signupWindowMs,
    message: "Too many signup requests. Try again later."
  });
  const signupReadLimiter = createFixedWindowRateLimiter({
    HttpError,
    limit: getEnvInteger("SIGNUP_READ_IP_LIMIT", 120),
    windowMs: getEnvInteger("SIGNUP_READ_RATE_WINDOW_SECONDS", 5 * 60) * 1000,
    blockMs: getEnvInteger("SIGNUP_READ_RATE_WINDOW_SECONDS", 5 * 60) * 1000,
    message: "Too many signup requests. Try again later."
  });
  const socialFlowLimiter = createFixedWindowRateLimiter({
    HttpError,
    limit: getEnvInteger("SIGNUP_SOCIAL_FLOW_IP_LIMIT", 60),
    windowMs: socialWindowMs,
    blockMs: socialWindowMs,
    message: "Too many social sign-in requests. Try again later."
  });

  function assertAdminLoginAllowed(request, username) {
    if (disabled) return;
    const ip = getClientIp(request);
    adminIpLimiter.consume(`admin-login:ip:${ip}`);
    adminUsernameLimiter.consume(`admin-login:username:${normalizeKeyPart(username, "blank")}`);
  }

  function resetAdminLogin(username) {
    adminUsernameLimiter.reset(`admin-login:username:${normalizeKeyPart(username, "blank")}`);
  }

  function assertSignupWriteAllowed(request, action) {
    if (disabled) return;
    signupWriteLimiter.consume(`signup:${normalizeKeyPart(action)}:ip:${getClientIp(request)}`);
  }

  function assertSignupReadAllowed(request, action) {
    if (disabled) return;
    signupReadLimiter.consume(`signup:${normalizeKeyPart(action)}:ip:${getClientIp(request)}`);
  }

  function assertSocialFlowAllowed(request, routeKey) {
    if (disabled) return;
    socialFlowLimiter.consume(`social:${normalizeKeyPart(routeKey)}:ip:${getClientIp(request)}`);
  }

  function pruneExpired(now = Date.now()) {
    adminIpLimiter.pruneExpired(now);
    adminUsernameLimiter.pruneExpired(now);
    signupWriteLimiter.pruneExpired(now);
    signupReadLimiter.pruneExpired(now);
    socialFlowLimiter.pruneExpired(now);
  }

  return {
    assertAdminLoginAllowed,
    resetAdminLogin,
    assertSignupWriteAllowed,
    assertSignupReadAllowed,
    assertSocialFlowAllowed,
    pruneExpired
  };
}

module.exports = {
  createFixedWindowRateLimiter,
  createRequestThrottles,
  getClientIp,
  normalizeKeyPart
};
