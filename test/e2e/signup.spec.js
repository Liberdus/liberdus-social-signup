const { test, expect } = require("@playwright/test");
const nodeCrypto = require("node:crypto");
const { Wallet, getBytes, isHexString } = require("ethers");

const apiBaseUrl = process.env.E2E_API_BASE_URL
  || `http://127.0.0.1:${process.env.E2E_API_PORT || "8789"}`;

test.describe.configure({ mode: "serial" });

function createTestWallet() {
  return Wallet.createRandom();
}

async function installFakeWallet(page, wallet) {
  await page.exposeFunction("__e2eSignMessage", async (message) => {
    const payload = typeof message === "string" && isHexString(message)
      ? getBytes(message)
      : message;
    return wallet.signMessage(payload);
  });

  await page.addInitScript(({ address }) => {
    let account = address;
    const listeners = new Map();

    function emit(eventName, payload) {
      for (const listener of listeners.get(eventName) || []) {
        listener(payload);
      }
    }

    window.ethereum = {
      isMetaMask: true,
      request: async ({ method, params = [] }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return account ? [account] : [];
        if (method === "eth_chainId") return "0x1";
        if (method === "net_version") return "1";
        if (method === "personal_sign") return window.__e2eSignMessage(params[0]);
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        throw new Error(`Unsupported fake wallet method: ${method}`);
      },
      on: (eventName, listener) => {
        if (!listeners.has(eventName)) listeners.set(eventName, new Set());
        listeners.get(eventName).add(listener);
      },
      removeListener: (eventName, listener) => {
        listeners.get(eventName)?.delete(listener);
      }
    };

    window.__e2eWallet = {
      setAccount(nextAccount) {
        account = nextAccount;
        emit("accountsChanged", account ? [account] : []);
      }
    };
  }, { address: wallet.address });
}

async function connectWallet(page) {
  await page.getByRole("button", { name: "Connect Wallet" }).click();
  await page.getByRole("button", { name: /MetaMask/u }).click();
  await expect(page.locator("#walletStatusRow")).toHaveAttribute("data-ready", "true");
}

async function createDiscordSession(page, overrides = {}) {
  const result = await page.evaluate(async ({ url, payload }) => {
    const response = await fetch(`${url}/api/test/session/discord`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.json().catch(() => ({}))
    };
  }, {
    url: apiBaseUrl,
    payload: {
      id: `discord-${nodeCrypto.randomUUID()}`,
      username: "e2ediscord",
      displayName: "E2E Discord",
      isMember: true,
      ...overrides
    }
  });

  expect(result.ok, JSON.stringify(result.body)).toBe(true);
}

async function logoutDiscord(page) {
  await page.evaluate(async (url) => {
    await fetch(`${url}/api/discord/logout`, {
      method: "POST",
      credentials: "include"
    });
  }, apiBaseUrl);
}

test("social actions start disabled until a wallet is connected", async ({ page }) => {
  await installFakeWallet(page, createTestWallet());
  await page.goto("./");

  await expect(page.locator("#discordStatusRow")).toBeVisible();
  await expect(page.locator("#xAuthButton")).toBeDisabled();
  await expect(page.locator("#discordAuthButton")).toBeDisabled();
  await expect(page.locator("#submitButton")).toBeDisabled();

  await connectWallet(page);

  await expect(page.locator("#discordAuthButton")).toBeEnabled();
  await expect(page.locator("#submitButton")).toBeDisabled();
});

test("submits a new signup with a fake Discord session", async ({ page }) => {
  await installFakeWallet(page, createTestWallet());
  await page.goto("./");
  await createDiscordSession(page, { username: "submitdiscord" });
  await page.reload();

  await connectWallet(page);
  await expect(page.locator("#discordStatusRow")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#submitButton")).toBeEnabled();

  await page.locator("#submitButton").click();

  await expect(page.locator("#submissionStatus")).toHaveText("Loaded");
  await expect(page.locator("#submitButton")).toHaveText("Update & Sign");
  await expect(page.locator("#existingSignupPanel")).toBeVisible();
});

test("loads saved socials by signed wallet", async ({ page }) => {
  await installFakeWallet(page, createTestWallet());
  await page.goto("./");
  await createDiscordSession(page, { username: "saveddiscord" });
  await page.reload();
  await connectWallet(page);
  await page.locator("#submitButton").click();
  await expect(page.locator("#submitButton")).toHaveText("Update & Sign");

  await logoutDiscord(page);
  await page.reload();
  await connectWallet(page);
  await page.locator("#loadSignupButton").click();

  await expect(page.locator("#discordStatusRow")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#discordAuthButton")).toHaveText("Change");
  await expect(page.locator("#submitButton")).toHaveText("Update & Sign");
});

test("confirms replacing a saved social account", async ({ page }) => {
  const wallet = createTestWallet();
  await installFakeWallet(page, wallet);
  await page.goto("./");
  await createDiscordSession(page, { id: "discord-old", username: "olddiscord", displayName: "olddiscord" });
  await page.reload();
  await connectWallet(page);
  await page.locator("#submitButton").click();
  await expect(page.locator("#submitButton")).toHaveText("Update & Sign");

  await createDiscordSession(page, { id: "discord-new", username: "newdiscord", displayName: "newdiscord" });
  await page.reload();
  await connectWallet(page);
  await page.locator("#loadSignupButton").click();

  const unconfirmed = await page.evaluate(async ({ url, walletAddress }) => {
    const challengeResponse = await fetch(`${url}/api/signup/challenge`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress, chainId: 1 })
    });
    const challenge = await challengeResponse.json();
    const signature = await window.__e2eSignMessage(challenge.message);
    const completeResponse = await fetch(`${url}/api/signup/complete`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress,
        challengeId: challenge.challengeId,
        signature
      })
    });
    return {
      status: completeResponse.status,
      body: await completeResponse.json()
    };
  }, { url: apiBaseUrl, walletAddress: wallet.address });
  expect(unconfirmed.status).toBe(409);
  expect(unconfirmed.body.replacementRequired).toBe(true);

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Discord: olddiscord -> newdiscord");
    await dialog.accept();
  });
  await page.locator("#submitButton").click();

  await expect(page.locator("#discordStatusText")).toContainText("newdiscord");
  await expect(page.locator("#submitButton")).toHaveText("Update & Sign");
});
