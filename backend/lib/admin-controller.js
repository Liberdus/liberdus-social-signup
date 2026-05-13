const ADMIN_SESSION_TTL_MS = 60 * 60 * 1000;

function createAdminController(context) {
  const {
    HttpError,
    createRandomToken,
    secureEquals,
    writeJson,
    writeText,
    readJsonRequest,
    signupStore
  } = context;

  const sessions = new Map();

  function pruneExpired(now = Date.now()) {
    for (const [key, session] of sessions.entries()) {
      if (session.expiresAtMs <= now) sessions.delete(key);
    }
  }

  function getCredentials() {
    return {
      username: String(process.env.ADMIN_USERNAME || "admin"),
      password: String(process.env.ADMIN_PASSWORD || "")
    };
  }

  function getRequiredSession(request) {
    pruneExpired();
    const token = String(request.headers["x-admin-token"] || "").trim();
    const session = token ? sessions.get(token) : null;
    if (!session) throw new HttpError(401, "Admin login is required.");
    return session;
  }

  async function handleLogin(request, response) {
    const credentials = getCredentials();
    if (!credentials.password) {
      throw new HttpError(500, "ADMIN_PASSWORD is not configured.", { expose: false });
    }
    const body = await readJsonRequest(request);
    if (!secureEquals(body.username, credentials.username) || !secureEquals(body.password, credentials.password)) {
      throw new HttpError(401, "Admin username or password is incorrect.");
    }
    const token = createRandomToken();
    sessions.set(token, {
      token,
      createdAt: new Date().toISOString(),
      expiresAtMs: Date.now() + ADMIN_SESSION_TTL_MS
    });
    writeJson(response, 200, {
      adminToken: token,
      expiresAt: Date.now() + ADMIN_SESSION_TTL_MS
    });
  }

  async function handleLogout(request, response) {
    const token = String(request.headers["x-admin-token"] || "").trim();
    if (token) sessions.delete(token);
    writeJson(response, 200, { ok: true });
  }

  function handleSignupList(request, response, requestUrl) {
    getRequiredSession(request);
    const result = signupStore.listSignups({
      search: requestUrl.searchParams.get("search") || "",
      limit: requestUrl.searchParams.get("limit") || "50",
      offset: requestUrl.searchParams.get("offset") || "0"
    });
    writeJson(response, 200, {
      summary: signupStore.getStats(),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      signups: result.rows.map((row) => signupStore.serializeSignup(row))
    });
  }

  function handleSignupExport(request, response) {
    getRequiredSession(request);
    writeText(response, 200, signupStore.exportCsv(), "text/csv; charset=utf-8", {
      "Content-Disposition": `attachment; filename="liberdus-social-signups.csv"`
    });
  }

  return {
    pruneExpired,
    handleLogin,
    handleLogout,
    handleSignupList,
    handleSignupExport
  };
}

module.exports = {
  createAdminController
};
