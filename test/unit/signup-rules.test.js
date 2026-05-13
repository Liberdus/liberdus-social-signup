const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getDistinctExistingSignups,
  hasRequiredSocialAccount,
  signupHasRequiredSocial,
  mergeVerification,
  mergeSocialAccounts,
  getOptionalSummaryValue,
  getProviderLabel
} = require("../../backend/lib/signup-rules");

test("required social rule accepts X, Discord, Telegram, or LinkedIn", () => {
  assert.equal(hasRequiredSocialAccount([{ provider: "github", providerUserId: "gh-1" }]), false);
  assert.equal(hasRequiredSocialAccount([{ provider: "discord", providerUserId: "discord-1" }]), true);
  assert.equal(signupHasRequiredSocial({ socialAccounts: [{ provider: "telegram", providerUserId: "tg-1" }] }), true);
  assert.equal(signupHasRequiredSocial({ xUserId: "x-1", socialAccounts: [] }), true);
  assert.equal(signupHasRequiredSocial({ socialAccounts: [{ provider: "youtube", providerUserId: "yt-1" }] }), false);
});

test("mergeVerification preserves saved providers that were not reconnected", () => {
  const existing = {
    verification_json: JSON.stringify({
      x: { authenticated: true, userId: "x-old", username: "oldx" },
      discord: { connected: true, verified: true, userId: "discord-old" },
      telegram: { connected: true, verified: true, userId: "telegram-old" },
      coinMarketCap: { opened: true, verified: false }
    })
  };
  const current = {
    x: { authenticated: false, followChecks: [] },
    wallet: { signed: true, chainId: 1 },
    discord: { connected: false, verified: false },
    telegram: { connected: true, verified: false, userId: "telegram-new" },
    coinMarketCap: { opened: false, verified: false }
  };

  const merged = mergeVerification(existing, current, { hasXSession: false });

  assert.equal(merged.x.userId, "x-old");
  assert.equal(merged.discord.userId, "discord-old");
  assert.equal(merged.telegram.userId, "telegram-new");
  assert.equal(merged.coinMarketCap.opened, true);
  assert.equal(merged.wallet.signed, true);
});

test("mergeVerification replaces X when a current X session exists", () => {
  const merged = mergeVerification({
    verification_json: JSON.stringify({ x: { authenticated: true, userId: "x-old" } })
  }, {
    x: { authenticated: true, userId: "x-new", username: "newx" },
    wallet: { signed: true, chainId: 1 }
  }, { hasXSession: true });

  assert.equal(merged.x.userId, "x-new");
});

test("mergeSocialAccounts keeps one account per provider and prefers current accounts", () => {
  const merged = mergeSocialAccounts([
    { provider: "discord", providerUserId: "discord-old", username: "old" },
    { provider: "telegram", providerUserId: "telegram-old", username: "oldtg" }
  ], [
    { provider: "discord", providerUserId: "discord-new", username: "new" },
    { provider: "github", providerUserId: "github-new", username: "newgh" }
  ]);

  assert.deepEqual(merged.map((account) => [account.provider, account.providerUserId]), [
    ["discord", "discord-new"],
    ["telegram", "telegram-old"],
    ["github", "github-new"]
  ]);
});

test("deduplicates existing signups by id", () => {
  const first = { id: "same", walletAddress: "0x1" };
  const second = { id: "same", walletAddress: "0x2" };
  const unique = getDistinctExistingSignups([first, second, null, { id: "other" }]);

  assert.equal(unique.length, 2);
  assert.equal(unique[0], second);
});

test("optional summary values trim current input and fall back cleanly", () => {
  assert.equal(getOptionalSummaryValue("  current  ", "fallback"), "current");
  assert.equal(getOptionalSummaryValue("", "fallback"), "fallback");
  assert.equal(getOptionalSummaryValue("", ""), undefined);
});

test("provider labels stay user-facing", () => {
  assert.equal(getProviderLabel("linkedin"), "LinkedIn");
  assert.equal(getProviderLabel("unknown"), "unknown");
});
