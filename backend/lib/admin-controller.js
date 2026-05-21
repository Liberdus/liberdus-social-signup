const ADMIN_SESSION_TTL_MS = 60 * 60 * 1000;

function createAdminController(context) {
  const {
    HttpError,
    createRandomToken,
    secureEquals,
    writeJson,
    writeText,
    readJsonRequest,
    signupStore,
    throttles
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

  function getSignupFilters(searchParams) {
    return {
      search: searchParams.get("search") || "",
      limit: searchParams.get("limit") || "50",
      offset: searchParams.get("offset") || "0",
      provider: searchParams.get("provider") || "",
      checkType: searchParams.get("checkType") || "",
      checkStatus: searchParams.get("checkStatus") || "",
      manualClaim: searchParams.get("manualClaim") || "",
      changed: searchParams.get("changed") || "",
      status: searchParams.get("status") || "",
      submittedFrom: searchParams.get("submittedFrom") || "",
      submittedTo: searchParams.get("submittedTo") || ""
    };
  }

  async function handleLogin(request, response) {
    const credentials = getCredentials();
    if (!credentials.password) {
      throw new HttpError(500, "ADMIN_PASSWORD is not configured.", { expose: false });
    }
    const body = await readJsonRequest(request);
    throttles?.assertAdminLoginAllowed(request, body.username);
    if (!secureEquals(body.username, credentials.username) || !secureEquals(body.password, credentials.password)) {
      throw new HttpError(401, "Admin username or password is incorrect.");
    }
    throttles?.resetAdminLogin(body.username);
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
    const result = signupStore.listSignups(getSignupFilters(requestUrl.searchParams));
    writeJson(response, 200, {
      summary: signupStore.getStats(),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      signups: result.signups
    });
  }

  function handleSignupExport(request, response, requestUrl) {
    getRequiredSession(request);
    writeText(response, 200, signupStore.exportCsv(getSignupFilters(requestUrl.searchParams)), "text/csv; charset=utf-8", {
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
