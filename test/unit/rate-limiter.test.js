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

test("request throttles enforce admin IP quotas across usernames", async () => {
  await withEnv({
    SIGNUP_RATE_LIMIT_DISABLED: undefined,
    SIGNUP_ADMIN_LOGIN_IP_LIMIT: "2",
    SIGNUP_ADMIN_LOGIN_USERNAME_LIMIT: "100",
    SIGNUP_ADMIN_LOGIN_WINDOW_SECONDS: "60",
    SIGNUP_ADMIN_LOGIN_BLOCK_SECONDS: "90"
  }, () => {
    const throttles = createRequestThrottles({ HttpError });
    const request = makeRequest({ remoteAddress: "203.0.113.10" });

    throttles.assertAdminLoginAllowed(request, "admin-one");
    throttles.assertAdminLoginAllowed(request, "admin-two");

    assert.throws(
      () => throttles.assertAdminLoginAllowed(request, "admin-three"),
      (error) => {
        assert.equal(error.statusCode, 429);
        assert.equal(error.message, "Too many admin login attempts. Try again later.");
        assert.equal(error.headers["Retry-After"], "90");
        return true;
      }
    );
  });
});

test("request throttles enforce signup write quotas per action and IP", async () => {
  await withEnv({
    SIGNUP_RATE_LIMIT_DISABLED: undefined,
    SIGNUP_WRITE_IP_LIMIT: "2",
    SIGNUP_SIGNUP_RATE_WINDOW_SECONDS: "60"
  }, () => {
    const throttles = createRequestThrottles({ HttpError });
    const request = makeRequest({ remoteAddress: "203.0.113.20" });

    throttles.assertSignupWriteAllowed(request, "challenge");
    throttles.assertSignupWriteAllowed(request, "challenge");

    assert.throws(
      () => throttles.assertSignupWriteAllowed(request, "challenge"),
      (error) => {
        assert.equal(error.statusCode, 429);
        assert.equal(error.message, "Too many signup requests. Try again later.");
        assert.equal(error.headers["Retry-After"], "60");
        return true;
      }
    );

    throttles.assertSignupWriteAllowed(request, "complete");
  });
});

test("request throttles enforce signup read quotas separately from writes", async () => {
  await withEnv({
    SIGNUP_RATE_LIMIT_DISABLED: undefined,
    SIGNUP_READ_IP_LIMIT: "1",
    SIGNUP_READ_RATE_WINDOW_SECONDS: "45",
    SIGNUP_WRITE_IP_LIMIT: "100"
  }, () => {
    const throttles = createRequestThrottles({ HttpError });
    const request = makeRequest({ remoteAddress: "203.0.113.30" });

    throttles.assertSignupReadAllowed(request, "session");

    assert.throws(
      () => throttles.assertSignupReadAllowed(request, "session"),
      (error) => {
        assert.equal(error.statusCode, 429);
        assert.equal(error.message, "Too many signup requests. Try again later.");
        assert.equal(error.headers["Retry-After"], "45");
        return true;
      }
    );

    throttles.assertSignupWriteAllowed(request, "challenge");
  });
});

test("request throttles enforce social flow quotas per route and IP", async () => {
  await withEnv({
    SIGNUP_RATE_LIMIT_DISABLED: undefined,
    SIGNUP_SOCIAL_FLOW_IP_LIMIT: "1",
    SIGNUP_SOCIAL_RATE_WINDOW_SECONDS: "30"
  }, () => {
    const throttles = createRequestThrottles({ HttpError });
    const request = makeRequest({ remoteAddress: "203.0.113.40" });

    throttles.assertSocialFlowAllowed(request, "GET /api/discord/start");

    assert.throws(
      () => throttles.assertSocialFlowAllowed(request, "GET /api/discord/start"),
      (error) => {
        assert.equal(error.statusCode, 429);
        assert.equal(error.message, "Too many social sign-in requests. Try again later.");
        assert.equal(error.headers["Retry-After"], "30");
        return true;
      }
    );

    throttles.assertSocialFlowAllowed(request, "GET /api/github/start");
  });
});

test("request throttles can be disabled explicitly for trusted test environments", async () => {
  await withEnv({
    SIGNUP_RATE_LIMIT_DISABLED: "true",
    SIGNUP_ADMIN_LOGIN_IP_LIMIT: "1",
    SIGNUP_ADMIN_LOGIN_USERNAME_LIMIT: "1",
    SIGNUP_WRITE_IP_LIMIT: "1",
    SIGNUP_READ_IP_LIMIT: "1",
    SIGNUP_SOCIAL_FLOW_IP_LIMIT: "1"
  }, () => {
    const throttles = createRequestThrottles({ HttpError });
    const request = makeRequest({ remoteAddress: "203.0.113.50" });

    for (let index = 0; index < 3; index += 1) {
      throttles.assertAdminLoginAllowed(request, "admin");
      throttles.assertSignupWriteAllowed(request, "challenge");
      throttles.assertSignupReadAllowed(request, "session");
      throttles.assertSocialFlowAllowed(request, "GET /api/discord/start");
    }
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
