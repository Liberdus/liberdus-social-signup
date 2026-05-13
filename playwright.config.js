const path = require("node:path");
const { defineConfig } = require("@playwright/test");

const apiPort = Number.parseInt(process.env.E2E_API_PORT || "8789", 10);
const staticPort = Number.parseInt(process.env.E2E_STATIC_PORT || "5513", 10);
const frontendOrigin = `http://127.0.0.1:${staticPort}`;
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;

module.exports = defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: `${frontendOrigin}/frontend/`,
    trace: "on-first-retry"
  },
  webServer: [{
    command: "node scripts/e2e-backend.js",
    url: `${apiBaseUrl}/health`,
    reuseExistingServer: false,
    timeout: 20_000,
    env: {
      ...process.env,
      E2E_TEST_MODE: "true",
      SIGNUP_HOST: "127.0.0.1",
      SIGNUP_PORT: String(apiPort),
      SIGNUP_DB_PATH: path.join("data", "e2e-signup.sqlite"),
      SIGNUP_ALLOWED_ORIGINS: frontendOrigin,
      SIGNUP_FRONTEND_RETURN_URL: `${frontendOrigin}/frontend/`,
      SIGNUP_FRONTEND_RETURN_URLS: `${frontendOrigin}/frontend/`
    }
  }, {
    command: "node scripts/static-server.js",
    url: `${frontendOrigin}/frontend/`,
    reuseExistingServer: false,
    timeout: 20_000,
    env: {
      ...process.env,
      E2E_TEST_MODE: "true",
      STATIC_HOST: "127.0.0.1",
      STATIC_PORT: String(staticPort),
      E2E_API_BASE_URL: apiBaseUrl
    }
  }]
});
