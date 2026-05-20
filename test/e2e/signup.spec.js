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
  const connectButton = page.getByRole("button", { name: "Connect & Sign Wallet" });
  if (await connectButton.count() === 0) return;
  await connectButton.click();
  await page.getByRole("button", { name: /MetaMask/u }).click();
  await expect(page.locator("#walletStatusRow")).toHaveAttribute("data-ready", "true");
}

async function signWallet(page) {
  if (await page.locator("#walletStatusRow").getAttribute("data-ready") === "true") return;
  await page.getByRole("button", { name: /Sign Wallet/i }).click();
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

  await expect(page.locator("#walletStatusRow")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#xStatusRow")).toBeVisible();
  await expect(page.locator("#discordStatusRow")).toBeVisible();
  await expect(page.locator("#profileTaskText")).toContainText("profile tasks complete");
  await expect(page.locator("#discordAuthButton")).toBeEnabled();
  await expect(page.locator("#submitButton")).toBeDisabled();
});

test("header wallet connect keeps page locked until page-level signature", async ({ page }) => {
  await installFakeWallet(page, createTestWallet());
  await page.goto("./");

  await page.locator("#connectButton").click();
  await page.getByRole("button", { name: /MetaMask/u }).click();

  await expect(page.locator("#walletStatusRow")).toHaveAttribute("data-ready", "false");
  await expect(page.locator("#requiredSocialChecklist")).toBeHidden();
  await expect(page.locator("#walletGatePanel")).toBeVisible();
  await expect(page.locator("#walletGateTitle")).toContainText("Sign wallet to unlock");
  await expect(page.locator("#walletSignButton")).toBeVisible();

  await page.locator("#walletSignButton").click();
  await expect(page.locator("#walletStatusRow")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#requiredSocialChecklist")).toBeVisible();
});

test("restores signed wallet state after a reload", async ({ page }) => {
  await installFakeWallet(page, createTestWallet());
  await page.goto("./");

  await connectWallet(page);
  await signWallet(page);
  await expect(page.locator("#xStatusRow")).toBeVisible();

  await page.reload();

  await expect(page.locator("#walletStatusRow")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#xStatusRow")).toBeVisible();
  await expect(page.locator("#discordStatusRow")).toBeVisible();
});

test("keeps signed wallet state after provider auth redirect completion", async ({ page }) => {
  await installFakeWallet(page, createTestWallet());
  await page.goto("./");

  await connectWallet(page);
  await signWallet(page);
  await createDiscordSession(page, { username: "redirectdiscord", displayName: "redirectdiscord" });

  await page.goto("./?discord_auth=complete");

  await expect(page.locator("#walletStatusRow")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#discordStatusRow")).toBeVisible();
  await expect(page.locator("#discordStatusRow")).toContainText("redirectdiscord");
});

test("locks checklist when signup session expires during provider return", async ({ page }) => {
  await installFakeWallet(page, createTestWallet());
  await page.goto("./");

  await connectWallet(page);
  await signWallet(page);
  await page.context().clearCookies();
  await createDiscordSession(page, { username: "expireddiscord" });

  await page.goto("./?discord_auth=complete");

  await expect(page.locator("#walletStatusRow")).toHaveAttribute("data-ready", "false");
  await expect(page.locator("#discordStatusRow")).toBeHidden();
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

test("clears signed wallet state when the connected wallet changes with unsaved socials", async ({ page }) => {
  const firstWallet = createTestWallet();
  const secondWallet = createTestWallet();
  await installFakeWallet(page, [firstWallet, secondWallet]);
  await page.goto("./");
  await createDiscordSession(page, { username: "unsavedsocial" });
  await page.reload();

  await connectWallet(page);
  await signWallet(page);
  await expect(page.locator("#discordStatusRow")).toHaveAttribute("data-ready", "true");

  await page.evaluate((nextAddress) => {
    window.__e2eWallet.setAccount(nextAddress);
  }, secondWallet.address);

  await expect(page.locator("#walletStatusRow")).toHaveAttribute("data-ready", "false");
  await expect(page.locator("#discordStatusRow")).toBeHidden();
  await expect(page.locator("#submitButton")).toBeDisabled();
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
  await expect(page.locator("#submitButton")).toBeDisabled();
  await expect(page.locator("#profileGateText")).toContainText("Profile saved.");
  await expect(page.locator("#profileSaveNote")).toBeHidden();
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
  await expect(page.locator("#discordStatusText")).toContainText("will replace saved Discord olddiscord with newdiscord");
  await expect(page.locator("#profileSaveNote")).toContainText("Changes are not saved until you submit and sign.");

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

test("blocks a social account already linked to another signup before submit", async ({ page }) => {
  const firstWallet = createTestWallet();
  const secondWallet = createTestWallet();
  const discordUserId = `discord-conflict-${nodeCrypto.randomUUID()}`;

  await installFakeWallet(page, [firstWallet, secondWallet]);
  await page.goto("./");
  await createDiscordSession(page, {
    id: discordUserId,
    username: "conflictdiscord",
    displayName: "conflictdiscord"
  });
  await page.reload();
  await connectWallet(page);
  await signWallet(page);
  await page.locator("#submitButton").click();
  await expect(page.locator("#submitButton")).toHaveText("Update & Sign");

  await page.context().clearCookies();
  await page.goto("./");
  await page.evaluate(() => window.localStorage.clear());
  await createDiscordSession(page, {
    id: discordUserId,
    username: "conflictdiscord",
    displayName: "conflictdiscord"
  });
  await page.reload();
  await page.evaluate((address) => {
    window.__e2eWallet.setAccount(address);
  }, secondWallet.address);

  await connectWallet(page);
  await signWallet(page);

  await expect(page.locator("#discordStatusText")).toContainText("already linked to another signup");
  await expect(page.locator("#minimumSubmit")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#submitButton")).toBeDisabled();
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

  await page.locator("#connectButton").click();
  await expect(page.locator("#changeWalletButton")).toBeVisible();
  await page.locator("#changeWalletButton").click();
  await expect(page.locator("#walletStatusRow")).toHaveAttribute("data-ready", "false");
  await expect(page.locator("#discordStatusRow")).toBeHidden();
  await page.evaluate((nextAddress) => {
    window.__e2eWallet.setAccount(nextAddress);
  }, newWallet.address);
  await connectWallet(page);
  await expect(page.locator("#walletStatusText")).toContainText("will replace saved wallet");
  await expect(page.locator("#discordStatusRow")).toBeVisible();
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

  await expect(page.locator("#walletStatusRow")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#submitButton")).toHaveText("Update & Sign");
});
