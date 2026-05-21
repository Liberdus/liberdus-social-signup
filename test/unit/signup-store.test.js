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

function withTempDbStore(t) {
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

  return { db, store };
}

function withTempStore(t) {
  return withTempDbStore(t).store;
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

function parseCsvRows(csv) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];

    if (inQuotes) {
      if (character === '"' && csv[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function parseCsvRecords(csv) {
  const [header, ...rows] = parseCsvRows(csv);
  return rows.map((row) => Object.fromEntries(header.map((column, index) => [column, row[index] || ""])));
}

function setStoredSocialProfileFields(db, signupId, provider, fields) {
  db.prepare(`
    UPDATE signup_social_accounts
    SET username = @username, display_name = @displayName
    WHERE signup_id = @signupId AND provider = @provider
  `).run({
    signupId,
    provider,
    username: fields.username || "",
    displayName: fields.displayName || ""
  });
}

function exportRowWithStoredGithubUsername(t, username) {
  const { db, store } = withTempDbStore(t);
  const saved = store.saveSignup(makeSignupInput({
    socialAccounts: [
      makeSocialAccount({
        provider: "github",
        providerUserId: "github-1",
        username: "safe",
        displayName: "Safe GitHub",
        verifications: []
      })
    ]
  }));
  setStoredSocialProfileFields(db, saved.id, "github", {
    username,
    displayName: "Safe GitHub"
  });

  return parseCsvRecords(store.exportCsv())[0];
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

test("saveSignup preserves manual claimed verification status", (t) => {
  const store = withTempStore(t);
  const saved = store.saveSignup(makeSignupInput({
    socialAccounts: [makeSocialAccount({
      provider: "linkedin",
      providerUserId: "linkedin-1",
      username: "",
      displayName: "LinkedIn User",
      verifications: [{
        checkType: "linkedin_follow_manual",
        targetId: "https://www.linkedin.com/company/liberdus",
        status: "claimed",
        checkedAt: new Date().toISOString(),
        rawResult: { claimed: true, source: "user_click" }
      }]
    })]
  }));

  assert.equal(saved.socialAccounts[0].verifications[0].checkType, "linkedin_follow_manual");
  assert.equal(saved.socialAccounts[0].verifications[0].status, "claimed");
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
    walletAddress: WALLETS.two,
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
    }, {
      accountType: "wallet",
      provider: "wallet",
      oldProviderUserId: WALLETS.one,
      newProviderUserId: WALLETS.two,
      oldLabel: WALLETS.one,
      newLabel: WALLETS.two,
      authorizedWalletAddress: WALLETS.one,
      ipAddress: "127.0.0.1",
      userAgent: "node-test",
      rawContext: { reason: "signup_update", signedWalletAddress: WALLETS.two }
    }]
  }));

  assert.equal(updated.replacementHistory.length, 2);
  const socialReplacement = updated.replacementHistory.find((replacement) => replacement.accountType === "social");
  const walletReplacement = updated.replacementHistory.find((replacement) => replacement.accountType === "wallet");
  assert.equal(socialReplacement.provider, "discord");
  assert.equal(socialReplacement.oldProviderUserId, "discord-old");
  assert.equal(socialReplacement.newProviderUserId, "discord-new");
  assert.equal(socialReplacement.rawContext.reason, "signup_update");
  assert.equal(walletReplacement.provider, "wallet");
  assert.equal(walletReplacement.oldProviderUserId, WALLETS.one);
  assert.equal(walletReplacement.newProviderUserId, WALLETS.two);
  assert.equal(walletReplacement.rawContext.signedWalletAddress, WALLETS.two);
  assert.equal(store.getStats().accountReplacementCount, 2);
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

test("listSignups filters normalized admin account and verification data", (t) => {
  const store = withTempStore(t);
  const created = store.saveSignup(makeSignupInput({
    walletAddress: WALLETS.one,
    socialAccounts: [
      makeSocialAccount({
        provider: "github",
        providerUserId: "github-1",
        username: "liberdusfan",
        displayName: "Liberdus Fan",
        verifications: [{
          checkType: "github_repo_starred",
          targetId: "Liberdus/web-client-v2",
          status: "passed",
          checkedAt: new Date().toISOString(),
          rawResult: { starred: true }
        }]
      })
    ]
  }));
  const changed = store.updateSignup(makeSignupInput({
    id: created.id,
    walletAddress: WALLETS.one,
    createdAt: created.createdAt,
    socialAccounts: created.socialAccounts,
    accountReplacements: [{
      accountType: "wallet",
      provider: "wallet",
      oldProviderUserId: WALLETS.three,
      newProviderUserId: WALLETS.one,
      oldLabel: WALLETS.three,
      newLabel: WALLETS.one,
      authorizedWalletAddress: WALLETS.three,
      rawContext: { reason: "signup_update" }
    }]
  }));
  store.saveSignup(makeSignupInput({
    walletAddress: WALLETS.two,
    socialAccounts: [
      makeSocialAccount({
        provider: "linkedin",
        providerUserId: "linkedin-1",
        displayName: "LinkedIn User",
        verifications: [{
          checkType: "linkedin_follow_manual",
          targetId: "https://www.linkedin.com/company/liberdus",
          status: "claimed",
          checkedAt: new Date().toISOString(),
          rawResult: { claimed: true }
        }]
      })
    ]
  }));

  assert.equal(store.listSignups({ provider: "github" }).signups[0].id, changed.id);
  assert.equal(store.listSignups({ checkType: "github_repo_starred", checkStatus: "passed" }).total, 1);
  assert.equal(store.listSignups({ manualClaim: "linkedin_follow_manual" }).total, 1);
  assert.equal(store.listSignups({ changed: "wallet" }).total, 1);

  const csv = store.exportCsv({ provider: "github" });
  const header = csv.split("\n")[0];
  assert.match(header, /github_starred_repo/);
  assert.doesNotMatch(header, /status/);
  assert.doesNotMatch(header, /replacement_count/);
  assert.match(csv, /liberdusfan/);
  assert.match(csv, /starred/);
  assert.match(csv, /has_account_changes/);
});

const FORMULA_PREFIX_CASES = [
  { name: "equals", input: "=github", expected: "'=github" },
  { name: "plus", input: "+github", expected: "'+github" },
  { name: "minus", input: "-github", expected: "'-github" },
  { name: "at sign", input: "@github", expected: "'@github" },
  { name: "tab", input: "\tgithub", expected: "'\tgithub" },
  { name: "carriage return", input: "\rgithub", expected: "'\rgithub" },
  { name: "newline", input: "\ngithub", expected: "'\ngithub" }
];

for (const { name, input, expected } of FORMULA_PREFIX_CASES) {
  test(`exportCsv neutralizes provider fields starting with ${name}`, (t) => {
    const row = exportRowWithStoredGithubUsername(t, input);
    assert.equal(row.github_username, expected);
  });
}

const SAFE_CSV_VALUE_CASES = [
  { name: "plain text", input: "liberdusfan" },
  { name: "formula character after first byte", input: "user=1+1" },
  { name: "leading space before formula character", input: " =1+1" },
  { name: "empty string", input: "" }
];

for (const { name, input } of SAFE_CSV_VALUE_CASES) {
  test(`exportCsv preserves safe provider field ${name}`, (t) => {
    const row = exportRowWithStoredGithubUsername(t, input);
    assert.equal(row.github_username, input);
  });
}

test("exportCsv neutralizes all exported provider username and display name fields", (t) => {
  const { db, store } = withTempDbStore(t);
  const saved = store.saveSignup(makeSignupInput({
    socialAccounts: [
      makeSocialAccount({
        provider: "x",
        providerUserId: "x-1",
        username: "xuser",
        displayName: "X User",
        verifications: []
      }),
      makeSocialAccount({
        provider: "discord",
        providerUserId: "discord-1",
        username: "discord",
        displayName: "Discord",
        verifications: []
      }),
      makeSocialAccount({
        provider: "telegram",
        providerUserId: "telegram-1",
        username: "telegram",
        displayName: "Telegram",
        verifications: []
      }),
      makeSocialAccount({
        provider: "linkedin",
        providerUserId: "linkedin-1",
        username: "",
        displayName: "LinkedIn",
        verifications: []
      }),
      makeSocialAccount({
        provider: "github",
        providerUserId: "github-1",
        username: "github",
        displayName: "GitHub",
        verifications: []
      }),
      makeSocialAccount({
        provider: "youtube",
        providerUserId: "youtube-1",
        username: "youtube",
        displayName: "YouTube",
        verifications: []
      })
    ]
  }));

  const providerFields = [
    { provider: "x", username: "=xuser", displayName: "+X, User", columns: { username: "x_username", displayName: "x_display_name" } },
    { provider: "discord", username: "-discord", displayName: "@Discord", columns: { username: "discord_username", displayName: "discord_display_name" } },
    { provider: "telegram", username: "\ttelegram", displayName: "\rTelegram", columns: { username: "telegram_username", displayName: "telegram_display_name" } },
    { provider: "linkedin", username: "", displayName: "\nLinkedIn", columns: { displayName: "linkedin_display_name" } },
    { provider: "github", username: "=github", displayName: '+Git "Hub"', columns: { username: "github_username", displayName: "github_display_name" } },
    { provider: "youtube", username: "@youtube", displayName: "-YouTube", columns: { username: "youtube_username", displayName: "youtube_display_name" } }
  ];

  for (const field of providerFields) {
    setStoredSocialProfileFields(db, saved.id, field.provider, field);
  }

  const csv = store.exportCsv();
  const [row] = parseCsvRecords(csv);

  for (const field of providerFields) {
    if (field.columns.username) {
      assert.equal(row[field.columns.username], `'${field.username}`);
    }
    assert.equal(row[field.columns.displayName], `'${field.displayName}`);
  }
  assert.match(csv, /"'\+X, User"/u);
  assert.match(csv, /"'\+Git ""Hub"""/u);
});

test("exportCsv neutralizes formula-like non-provider fields", (t) => {
  const store = withTempStore(t);
  store.saveSignup(makeSignupInput({
    id: "=signup-id"
  }));

  const [row] = parseCsvRecords(store.exportCsv());

  assert.equal(row.signup_id, "'=signup-id");
});

test("CoinMarketCap opened snapshot is treated as a manual admin claim", (t) => {
  const store = withTempStore(t);
  store.saveSignup(makeSignupInput({
    verificationJson: JSON.stringify({
      coinMarketCap: {
        opened: true,
        verified: false
      }
    })
  }));

  assert.equal(store.listSignups({ provider: "coinmarketcap" }).total, 1);
  assert.equal(store.listSignups({ manualClaim: "coinmarketcap_follow_manual" }).total, 1);

  const csv = store.exportCsv({ provider: "coinmarketcap" });
  assert.match(csv, /coinmarketcap_follow_claimed/);
  assert.match(csv, /claimed/);
});
