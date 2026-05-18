const { test, expect } = require("@playwright/test");
const nodeCrypto = require("node:crypto");
const { Wallet, getBytes, isHexString } = require("ethers");

const apiBaseUrl = process.env.E2E_API_BASE_URL
  || `http://127.0.0.1:${process.env.E2E_API_PORT || "8789"}`;

test.describe.configure({ mode: "serial" });

function createTestWallet() {
  return Wallet.createRandom();
}

async function installFakeWallet(page, walletOrWallets) {
  const wallets = Array.isArray(walletOrWallets) ? walletOrWallets : [walletOrWallets];
  const defaultWallet = wallets[0];
  const walletByAddress = new Map(wallets.map((wallet) => [wallet.address.toLowerCase(), wallet]));

  await page.exposeFunction("__e2eSignMessage", async (input) => {
    const message = typeof input === "object" && input !== null ? input.message : input;
    const requestedAccount = typeof input === "object" && input !== null ? String(input.account || "").toLowerCase() : "";
    const signer = walletByAddress.get(requestedAccount) || defaultWallet;
    const payload = typeof message === "string" && isHexString(message)
      ? getBytes(message)
      : message;
    return signer.signMessage(payload);
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
        if (method === "personal_sign") return window.__e2eSignMessage({ message: params[0], account });
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
  }, { address: defaultWallet.address });
}

async function connectWallet(page) {
  await page.getByRole("button", { name: "Connect Wallet" }).click();
  await page.getByRole("button", { name: /MetaMask/u }).click();
  await expect(page.locator("#walletConnectTaskRow")).toHaveAttribute("data-state", "done");
}

async function signWallet(page) {
  await page.locator("#loadSignupButton").click();
  await expect(page.locator("#walletSignTaskRow")).toHaveAttribute("data-state", "done");
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

async function dispatchBeforeUnload(page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    const allowed = window.dispatchEvent(event);
    return {
      allowed,
      defaultPrevented: event.defaultPrevented
    };
  });
}

async function clickManualChecklistLink(page, selector) {
  const link = page.locator(selector);
  await link.evaluate((anchor) => {
    anchor.addEventListener("click", (event) => event.preventDefault(), {
      capture: true,
      once: true
    });
  });
  await link.click();
}

test("social actions stay hidden until wallet ownership is signed", async ({ page }) => {
  await installFakeWallet(page, createTestWallet());
  await page.goto("./");

  await expect(page.locator("#xStatusRow")).toBeHidden();
  await expect(page.locator("#discordStatusRow")).toBeHidden();
  await expect(page.locator("#profileTaskText")).toBeEmpty();
  await expect(page.locator("#xAuthButton")).toBeDisabled();
  await expect(page.locator("#discordAuthButton")).toBeDisabled();
  await expect(page.locator("#submitButton")).toBeDisabled();

  await connectWallet(page);

  await expect(page.locator("#walletConnectTaskRow")).toHaveAttribute("data-state", "done");
  await expect(page.locator("#xStatusRow")).toBeHidden();
  await expect(page.locator("#discordStatusRow")).toBeHidden();
  await expect(page.locator("#submitButton")).toBeDisabled();

  await page.locator("#loadSignupButton").click();

  await expect(page.locator("#xStatusRow")).toBeVisible();
  await expect(page.locator("#discordStatusRow")).toBeVisible();
  await expect(page.locator("#profileTaskText")).toContainText("tasks complete");
  await expect(page.locator("#discordAuthButton")).toBeEnabled();
  await expect(page.locator("#submitButton")).toBeDisabled();
});

test("submits a new signup with a fake Discord session", async ({ page }) => {
  await installFakeWallet(page, createTestWallet());
  await page.goto("./");
  await createDiscordSession(page, { username: "submitdiscord" });
  await page.reload();

  await connectWallet(page);
  await signWallet(page);
  await expect(page.locator("#discordStatusRow")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#submitButton")).toBeEnabled();

  await page.locator("#submitButton").click();

  await expect(page.locator("#submitButton")).toHaveText("Update & Sign");
  await expect(page.locator("#minimumSubmit")).toHaveAttribute("data-state", "done");
});

test("persists manual follow claims after submit", async ({ page }) => {
  await installFakeWallet(page, createTestWallet());
  await page.goto("./");
  await createDiscordSession(page, { username: "manualclaims" });
  await page.reload();

  await connectWallet(page);
  await signWallet(page);
  await clickManualChecklistLink(page, "#xChecklistLink");
  await clickManualChecklistLink(page, "#linkedinStatusRow .task-link");
  await clickManualChecklistLink(page, "#coinMarketCapStatusRow .task-link");
  await expect(page.locator("#xStatusRow")).toContainText("Follow complete");
  await expect(page.locator("#linkedinStatusRow")).toContainText("Follow complete");
  await expect(page.locator("#coinMarketCapStatusRow")).toContainText("Follow complete");

  await page.locator("#submitButton").click();
  await expect(page.locator("#submitButton")).toHaveText("Update & Sign");

  await page.reload();
  await connectWallet(page);
  await signWallet(page);
  await expect(page.locator("#xStatusRow")).toContainText("Follow complete");
  await expect(page.locator("#linkedinStatusRow")).toContainText("Follow complete");
  await expect(page.locator("#coinMarketCapStatusRow")).toContainText("Follow complete");
});

test("warns before leaving with unsaved signup progress", async ({ page }) => {
  await installFakeWallet(page, createTestWallet());
  await page.goto("./");

  await expect(await dispatchBeforeUnload(page)).toEqual({
    allowed: true,
    defaultPrevented: false
  });

  await connectWallet(page);
  await expect(await dispatchBeforeUnload(page)).toEqual({
    allowed: true,
    defaultPrevented: false
  });

  await createDiscordSession(page, { username: "warnbeforeleave" });
  await page.reload();
  await connectWallet(page);
  await signWallet(page);
  await expect(page.locator("#discordStatusRow")).toHaveAttribute("data-ready", "true");
  await expect(await dispatchBeforeUnload(page)).toEqual({
    allowed: false,
    defaultPrevented: true
  });

  await page.locator("#submitButton").click();
  await expect(page.locator("#submitButton")).toHaveText("Update & Sign");
  await expect(await dispatchBeforeUnload(page)).toEqual({
    allowed: true,
    defaultPrevented: false
  });
});

test("loads saved socials by signed wallet", async ({ page }) => {
  await installFakeWallet(page, createTestWallet());
  await page.goto("./");
  await createDiscordSession(page, { username: "saveddiscord" });
  await page.reload();
  await connectWallet(page);
  await signWallet(page);
  await page.locator("#submitButton").click();
  await expect(page.locator("#submitButton")).toHaveText("Update & Sign");

  await logoutDiscord(page);
  await page.reload();
  await connectWallet(page);
  await signWallet(page);

  await expect(page.locator("#discordStatusRow")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#discordAuthButton")).toHaveAttribute("aria-label", "Change Discord account");
  await expect(page.locator("#submitButton")).toHaveText("Update & Sign");
});

test("confirms replacing a saved social account", async ({ page }) => {
  const wallet = createTestWallet();
  await installFakeWallet(page, wallet);
  await page.goto("./");
  await createDiscordSession(page, { id: "discord-old", username: "olddiscord", displayName: "olddiscord" });
  await page.reload();
  await connectWallet(page);
  await signWallet(page);
  await page.locator("#submitButton").click();
  await expect(page.locator("#submitButton")).toHaveText("Update & Sign");

  await createDiscordSession(page, { id: "discord-new", username: "newdiscord", displayName: "newdiscord" });
  await page.reload();
  await connectWallet(page);
  await signWallet(page);

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

  await expect(page.locator("#discordStatusRow")).toContainText("newdiscord");
  await expect(page.locator("#submitButton")).toHaveText("Update & Sign");
});

test("confirms replacing a saved wallet", async ({ page }) => {
  const oldWallet = createTestWallet();
  const newWallet = createTestWallet();
  await installFakeWallet(page, [oldWallet, newWallet]);
  await page.goto("./");
  await createDiscordSession(page, { id: "discord-wallet-change", username: "walletdiscord", displayName: "walletdiscord" });
  await page.reload();
  await connectWallet(page);
  await signWallet(page);
  await page.locator("#submitButton").click();
  await expect(page.locator("#submitButton")).toHaveText("Update & Sign");

  await page.evaluate((nextAddress) => {
    window.__e2eWallet.setAccount(nextAddress);
  }, newWallet.address);
  await expect(page.locator("#walletStatusText")).toContainText("will replace saved wallet");
  await expect(page.locator("#discordStatusRow")).toBeHidden();
  await signWallet(page);
  await expect(page.locator("#discordStatusRow")).toBeVisible();

  const unconfirmed = await page.evaluate(async ({ url, walletAddress }) => {
    const challengeResponse = await fetch(`${url}/api/signup/challenge`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress, chainId: 1 })
    });
    const challenge = await challengeResponse.json();
    const signature = await window.__e2eSignMessage({ message: challenge.message, account: walletAddress });
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
  }, { url: apiBaseUrl, walletAddress: newWallet.address });
  expect(unconfirmed.status).toBe(409);
  expect(unconfirmed.body.replacementRequired).toBe(true);
  expect(unconfirmed.body.replacements[0].accountType).toBe("wallet");

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Wallet:");
    await dialog.accept();
  });
  await page.locator("#submitButton").click();

  await expect(page.locator("#walletSignTaskRow")).toHaveAttribute("data-state", "done");
  await expect(page.locator("#submitButton")).toHaveText("Update & Sign");
});
