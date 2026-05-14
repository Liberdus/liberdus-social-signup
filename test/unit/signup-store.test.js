const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { openDatabase } = require("../../backend/lib/db");
const { createSignupStore } = require("../../backend/lib/signup-store");
const { findSocialConflict } = require("../../backend/lib/signup-rules");

const WALLETS = {
  one: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  oneMixedCase: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  two: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  three: "0xcccccccccccccccccccccccccccccccccccccccc"
};

function withTempStore(t) {
  const previousDbPath = process.env.SIGNUP_DB_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "liberdus-signup-store-"));
  process.env.SIGNUP_DB_PATH = path.join(tempDir, "signup.sqlite");

  const db = openDatabase();
  const store = createSignupStore(db);

  t.after(() => {
    db.close();
    if (previousDbPath === undefined) {
      delete process.env.SIGNUP_DB_PATH;
    } else {
      process.env.SIGNUP_DB_PATH = previousDbPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return store;
}

function makeSignupInput(overrides = {}) {
  const now = overrides.now || new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    xUserId: null,
    xUsername: "",
    xName: "",
    xProfileImageUrl: "",
    walletAddress: WALLETS.one,
    walletChainId: 1,
    signedMessage: "signed message",
    signature: "signature",
    displayName: "",
    email: "",
    country: "",
    interest: "",
    discordUsername: "",
    telegramUsername: "",
    linkedinUrl: "",
    notes: "",
    verificationJson: "{}",
    status: "received",
    userAgent: "node-test",
    ipAddress: "127.0.0.1",
    submittedAt: now,
    createdAt: now,
    updatedAt: now,
    socialAccounts: [],
    ...overrides
  };
}

function makeSocialAccount(overrides = {}) {
  const now = overrides.now || new Date().toISOString();
  return {
    provider: "discord",
    providerUserId: "discord-1",
    username: "discorduser",
    displayName: "Discord User",
    profileUrl: "",
    avatarUrl: "",
    connectedAt: now,
    rawProfile: { id: "discord-1", username: "discorduser" },
    verifications: [{
      checkType: "discord_guild_member",
      targetId: "guild-1",
      status: "passed",
      checkedAt: now,
      rawResult: { isMember: true }
    }],
    ...overrides
  };
}

test("saveSignup stores and serializes social accounts and verifications", (t) => {
  const store = withTempStore(t);
  const saved = store.saveSignup(makeSignupInput({
    discordUsername: "discorduser",
    socialAccounts: [makeSocialAccount()]
  }));

  assert.equal(saved.walletAddress, WALLETS.one);
  assert.equal(saved.socialAccounts.length, 1);
  assert.equal(saved.socialAccounts[0].provider, "discord");
  assert.equal(saved.socialAccounts[0].verifications[0].status, "passed");
  assert.equal(store.findByWalletAddress(WALLETS.one).id, saved.id);
  assert.equal(store.getStats().signupCount, 1);
  assert.equal(store.getStats().socialAccountCount, 1);
  assert.equal(store.getStats().socialVerificationCount, 1);
});

test("updateSignup replaces account rows for the signup", (t) => {
  const store = withTempStore(t);
  const created = store.saveSignup(makeSignupInput({
    socialAccounts: [makeSocialAccount({ providerUserId: "discord-old", username: "old" })]
  }));
  const updated = store.updateSignup(makeSignupInput({
    id: created.id,
    walletAddress: created.walletAddress,
    createdAt: created.createdAt,
    socialAccounts: [makeSocialAccount({ providerUserId: "discord-new", username: "new" })]
  }));

  assert.equal(updated.id, created.id);
  assert.equal(updated.socialAccounts.length, 1);
  assert.equal(updated.socialAccounts[0].providerUserId, "discord-new");
  assert.equal(store.findBySocialAccount("discord", "discord-old"), null);
  assert.equal(store.findBySocialAccount("discord", "discord-new").id, created.id);
});

test("updateSignup records account replacement history", (t) => {
  const store = withTempStore(t);
  const created = store.saveSignup(makeSignupInput({
    socialAccounts: [makeSocialAccount({ providerUserId: "discord-old", username: "old" })]
  }));

  const updated = store.updateSignup(makeSignupInput({
    id: created.id,
    walletAddress: created.walletAddress,
    createdAt: created.createdAt,
    socialAccounts: [makeSocialAccount({ providerUserId: "discord-new", username: "new" })],
    accountReplacements: [{
      accountType: "social",
      provider: "discord",
      oldProviderUserId: "discord-old",
      newProviderUserId: "discord-new",
      oldLabel: "old",
      newLabel: "new",
      authorizedWalletAddress: created.walletAddress,
      ipAddress: "127.0.0.1",
      userAgent: "node-test",
      rawContext: { reason: "signup_update" }
    }]
  }));

  assert.equal(updated.replacementHistory.length, 1);
  assert.equal(updated.replacementHistory[0].provider, "discord");
  assert.equal(updated.replacementHistory[0].oldProviderUserId, "discord-old");
  assert.equal(updated.replacementHistory[0].newProviderUserId, "discord-new");
  assert.equal(updated.replacementHistory[0].rawContext.reason, "signup_update");
  assert.equal(store.getStats().accountReplacementCount, 1);
});

test("wallet addresses are unique case-insensitively", (t) => {
  const store = withTempStore(t);
  store.saveSignup(makeSignupInput({ walletAddress: WALLETS.one }));

  assert.throws(
    () => store.saveSignup(makeSignupInput({ walletAddress: WALLETS.oneMixedCase })),
    /UNIQUE constraint failed|constraint/i
  );
});

test("social accounts cannot be reused by another signup", (t) => {
  const store = withTempStore(t);
  const created = store.saveSignup(makeSignupInput({
    walletAddress: WALLETS.one,
    socialAccounts: [makeSocialAccount({ providerUserId: "discord-shared" })]
  }));

  assert.throws(
    () => store.saveSignup(makeSignupInput({
      walletAddress: WALLETS.two,
      socialAccounts: [makeSocialAccount({ providerUserId: "discord-shared" })]
    })),
    /UNIQUE constraint failed|constraint/i
  );

  const conflict = findSocialConflict(store, [{ provider: "discord", providerUserId: "discord-shared" }], "");
  assert.equal(conflict.owner.id, created.id);
  assert.match(conflict.message, /Discord account is already linked/);
  assert.equal(findSocialConflict(store, [{ provider: "discord", providerUserId: "discord-shared" }], created.id), null);
});

test("X social conflict checks legacy x_user_id and social account rows", (t) => {
  const store = withTempStore(t);
  const created = store.saveSignup(makeSignupInput({
    walletAddress: WALLETS.three,
    xUserId: "x-1",
    xUsername: "liberdusfan"
  }));

  const conflict = findSocialConflict(store, [{ provider: "x", providerUserId: "x-1" }], "");

  assert.equal(conflict.owner.id, created.id);
  assert.match(conflict.message, /X account is already linked/);
});
