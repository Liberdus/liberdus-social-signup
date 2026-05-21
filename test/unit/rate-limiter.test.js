const assert = require("node:assert/strict");
const test = require("node:test");

const { HttpError } = require("../../backend/lib/http-utils");
const {
  createFixedWindowRateLimiter,
  createRequestThrottles,
  getClientIp
} = require("../../backend/lib/rate-limiter");

function withEnv(overrides, fn) {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

function makeRequest({ remoteAddress = "127.0.0.1", headers = {} } = {}) {
  return {
    headers,
    socket: { remoteAddress }
  };
}

test("fixed window limiter returns 429 with retry-after after the quota is exceeded", () => {
  const limiter = createFixedWindowRateLimiter({
    HttpError,
    limit: 2,
    windowMs: 60_000,
    blockMs: 30_000,
    message: "Slow down."
  });

  limiter.consume("login:127.0.0.1", { now: 1_000 });
  limiter.consume("login:127.0.0.1", { now: 2_000 });

  assert.throws(
    () => limiter.consume("login:127.0.0.1", { now: 3_000 }),
    (error) => {
      assert.equal(error.statusCode, 429);
      assert.equal(error.message, "Slow down.");
      assert.equal(error.headers["Retry-After"], "30");
      return true;
    }
  );

  limiter.consume("login:127.0.0.1", { now: 64_000 });
});

test("request throttles enforce admin username quotas and allow reset after success", async () => {
  await withEnv({
    SIGNUP_RATE_LIMIT_DISABLED: undefined,
    SIGNUP_ADMIN_LOGIN_IP_LIMIT: "100",
    SIGNUP_ADMIN_LOGIN_USERNAME_LIMIT: "2",
    SIGNUP_ADMIN_LOGIN_WINDOW_SECONDS: "60",
    SIGNUP_ADMIN_LOGIN_BLOCK_SECONDS: "60"
  }, () => {
    const throttles = createRequestThrottles({ HttpError });
    const request = makeRequest();

    throttles.assertAdminLoginAllowed(request, "Admin");
    throttles.assertAdminLoginAllowed(request, "admin");

    assert.throws(
      () => throttles.assertAdminLoginAllowed(request, "ADMIN"),
      (error) => {
        assert.equal(error.statusCode, 429);
        assert.equal(error.message, "Too many admin login attempts. Try again later.");
        assert.equal(error.headers["Retry-After"], "60");
        return true;
      }
    );

    throttles.resetAdminLogin("admin");
    throttles.assertAdminLoginAllowed(request, "admin");
  });
});

test("client IP uses proxy headers only when explicitly trusted", async () => {
  await withEnv({ SIGNUP_TRUST_PROXY: undefined }, () => {
    const request = makeRequest({
      remoteAddress: "::ffff:10.0.0.10",
      headers: { "x-forwarded-for": "203.0.113.50" }
    });
    assert.equal(getClientIp(request), "10.0.0.10");
  });

  await withEnv({ SIGNUP_TRUST_PROXY: "true" }, () => {
    const request = makeRequest({
      remoteAddress: "10.0.0.10",
      headers: { "x-forwarded-for": "203.0.113.50, 10.0.0.10" }
    });
    assert.equal(getClientIp(request), "203.0.113.50");
  });
});
