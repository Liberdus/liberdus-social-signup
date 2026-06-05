const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const test = require("node:test");

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForStaticServer(baseUrl) {
  const deadline = Date.now() + 5_000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/frontend/`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }

  throw lastError || new Error("Timed out waiting for static server.");
}

async function startStaticServer(t, env = {}) {
  const port = await getAvailablePort();
  const child = spawn(process.execPath, ["scripts/static-server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      STATIC_HOST: "127.0.0.1",
      STATIC_PORT: String(port),
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  t.after(() => {
    if (!child.killed) child.kill();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForStaticServer(baseUrl);
  return baseUrl;
}

test("static server serves frontend files without exposing repository files", async (t) => {
  const baseUrl = await startStaticServer(t);

  const indexResponse = await fetch(`${baseUrl}/frontend/`);
  assert.equal(indexResponse.status, 200);
  assert.match(await indexResponse.text(), /Liberdus Social Rewards Signup/iu);

  const configResponse = await fetch(`${baseUrl}/frontend/config.json`);
  assert.equal(configResponse.status, 200);

  const walletModuleResponse = await fetch(`${baseUrl}/vendor/liberdus-wallet-module/index.js`);
  assert.equal(walletModuleResponse.status, 200);
  assert.match(await walletModuleResponse.text(), /createWalletCore/u);

  const blockedPaths = [
    "/package.json",
    "/backend/server.js",
    "/.env",
    "/data/liberdus-social-signup.sqlite",
    "/vendor/liberdus-wallet-module/package.json",
    "/vendor/liberdus-wallet-module/test/wallet-core.test.js",
    "/vendor/liberdus-wallet-module/.gitignore",
    "/%2e%2e/package.json"
  ];

  for (const blockedPath of blockedPaths) {
    const response = await fetch(`${baseUrl}${blockedPath}`);
    assert.notEqual(response.status, 200, `${blockedPath} should not be served`);
  }
});

test("static server still synthesizes local config for e2e mode", async (t) => {
  const apiBaseUrl = "http://127.0.0.1:9876";
  const baseUrl = await startStaticServer(t, {
    E2E_TEST_MODE: "true",
    E2E_API_BASE_URL: apiBaseUrl
  });

  const response = await fetch(`${baseUrl}/frontend/config.local.json`);
  assert.equal(response.status, 200);

  const config = await response.json();
  assert.equal(config.apiBaseUrl, apiBaseUrl);
});
