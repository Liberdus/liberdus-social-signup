const crypto = require("node:crypto");

const { ethers } = require("ethers");
const {
  getDistinctExistingSignups,
  getOptionalSummaryValue,
  getProviderLabel,
  hasRequiredSocialAccount,
  signupHasRequiredSocial,
  findSocialConflict,
  mergeSocialAccounts,
  mergeVerification
} = require("./signup-rules");

const SIGNUP_BROWSER_COOKIE_NAME = "liberdus_signup_browser_session";
const SIGNUP_BROWSER_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MANUAL_FOLLOW_CLAIMS = {
  xFollow: {
    provider: "x",
    checkType: "x_follow_manual",
    targetId: "https://x.com/liberdus"
  },
  linkedinFollow: {
    provider: "linkedin",
    checkType: "linkedin_follow_manual",
    targetId: "https://www.linkedin.com/company/liberdus"
  },
  coinMarketCapFollow: {
    provider: "coinMarketCap",
    checkType: "coinmarketcap_follow_manual",
    targetId: "https://coinmarketcap.com/community/profile/Liberdus/"
  }
};
const MANUAL_CLAIM_KEY = "followClaim";

function createSignupController(context) {
  const {
    HttpError,
    createRandomToken,
    parseCookies,
    setCookie,
    shouldUseSecureCookies,
    writeJson,
    readJsonRequest,
    signupStore,
    socialProviders
  } = context;

  const browserSessions = new Map();
  const challenges = new Map();

  function pruneExpired(now = Date.now()) {
    for (const [key, session] of browserSessions.entries()) {
      if (session.expiresAtMs <= now) browserSessions.delete(key);
    }
    for (const [key, challenge] of challenges.entries()) {
      if (challenge.expiresAtMs <= now) challenges.delete(key);
    }
  }

  function createBrowserSession(response) {
    const sessionId = createRandomToken();
    const now = new Date().toISOString();
    const session = {
      sessionId,
      createdAt: now,
      updatedAt: now,
      walletProof: null,
      expiresAtMs: Date.now() + SIGNUP_BROWSER_SESSION_TTL_MS
    };
    browserSessions.set(sessionId, session);
    setCookie(response, SIGNUP_BROWSER_COOKIE_NAME, sessionId, {
      path: "/api/",
      maxAge: SIGNUP_BROWSER_SESSION_TTL_MS / 1000,
      httpOnly: true,
      sameSite: "Lax",
      secure: shouldUseSecureCookies()
    });
    return session;
  }

  function getBrowserSession(request, response) {
    pruneExpired();
    const sessionId = parseCookies(request)[SIGNUP_BROWSER_COOKIE_NAME];
    const existing = sessionId ? browserSessions.get(sessionId) : null;
    if (existing) {
      existing.expiresAtMs = Date.now() + SIGNUP_BROWSER_SESSION_TTL_MS;
      existing.updatedAt = new Date().toISOString();
      return existing;
    }
    return createBrowserSession(response);
  }

  function requireBrowserSession(request) {
    pruneExpired();
    const sessionId = parseCookies(request)[SIGNUP_BROWSER_COOKIE_NAME];
    const existing = sessionId ? browserSessions.get(sessionId) : null;
    if (!existing) {
      throw new HttpError(403, "Signup session expired. Reload the page and try again.");
    }
    existing.expiresAtMs = Date.now() + SIGNUP_BROWSER_SESSION_TTL_MS;
    existing.updatedAt = new Date().toISOString();
    return existing;
  }

  function requireWalletAddress(value) {
    if (!ethers.isAddress(value)) throw new HttpError(400, "Wallet address is invalid.");
    return ethers.getAddress(value);
  }

  function normalizeText(value, maxLength) {
    const text = String(value || "").trim();
    return text.slice(0, maxLength);
  }

  function buildWalletSignupMessage({ profile, walletAddress, challengeId, issuedAt }) {
    const lines = [
      "Liberdus Social Rewards Signup",
      "",
      "Sign this message to prove wallet ownership for your rewards signup.",
      "This does not authorize a transaction or spend tokens.",
      "",
      `Wallet: ${walletAddress}`,
      `Challenge: ${challengeId}`,
      `Issued At: ${issuedAt}`
    ];
    if (profile?.id && profile?.username) {
      lines.splice(5, 0, `X Account: @${profile.username} (${profile.id})`);
    }
    return lines.join("\n");
  }

  function getClientIp(request) {
    return String(request.socket?.remoteAddress || "").replace(/^::ffff:/u, "");
  }

  async function handleChallenge(request, response) {
    const browserSession = getBrowserSession(request, response);
    const xSession = socialProviders.providerById.get("x")?.getSessionFromCookie?.(request) || null;
    const body = await readJsonRequest(request);
    const walletAddress = requireWalletAddress(body.walletAddress);
    const challengeId = createRandomToken(18);
    const issuedAt = new Date().toISOString();
    const message = buildWalletSignupMessage({
      profile: xSession?.profile,
      walletAddress,
      challengeId,
      issuedAt
    });

    challenges.set(challengeId, {
      challengeId,
      browserSessionId: browserSession.sessionId,
      walletAddress,
      walletChainId: Number.isInteger(Number(body.chainId)) ? Number(body.chainId) : null,
      message,
      issuedAt,
      expiresAtMs: Date.now() + CHALLENGE_TTL_MS
    });

    writeJson(response, 200, {
      challengeId,
      message,
      expiresAt: Date.now() + CHALLENGE_TTL_MS
    });
  }

  function verifyWalletChallengeForBrowserSession(browserSession, body, { consume = true } = {}) {
    const walletAddress = requireWalletAddress(body.walletAddress);
    const challengeId = String(body.challengeId || "").trim();
    const signature = String(body.signature || "").trim();
    const challenge = challenges.get(challengeId);

    if (!challenge || challenge.expiresAtMs <= Date.now()) {
      throw new HttpError(400, "Wallet challenge expired. Start again.");
    }
    if (challenge.browserSessionId !== browserSession.sessionId) {
      throw new HttpError(403, "Wallet challenge does not match this signup session.");
    }
    if (challenge.walletAddress !== walletAddress) {
      throw new HttpError(400, "Wallet challenge does not match the submitted wallet.");
    }
    if (!signature) {
      throw new HttpError(400, "Wallet signature is required.");
    }

    let recoveredAddress;
    try {
      recoveredAddress = ethers.verifyMessage(challenge.message, signature);
    } catch {
      throw new HttpError(400, "Wallet signature is invalid.");
    }
    if (ethers.getAddress(recoveredAddress) !== walletAddress) {
      throw new HttpError(400, "Wallet signature did not match the connected wallet.");
    }

    if (consume) challenges.delete(challengeId);
    const walletProof = {
      walletAddress,
      walletChainId: challenge.walletChainId,
      signedMessage: challenge.message,
      signature,
      challengeId,
      verifiedAt: new Date().toISOString()
    };
    browserSession.walletProof = walletProof;
    browserSession.updatedAt = walletProof.verifiedAt;
    return walletProof;
  }

  async function handleWalletVerify(request, response) {
    const browserSession = requireBrowserSession(request);
    const body = await readJsonRequest(request);
    const walletProof = verifyWalletChallengeForBrowserSession(browserSession, body);
    const existingSignupRow = signupStore.findByWalletAddress(walletProof.walletAddress);
    if (existingSignupRow?.id) {
      browserSession.authenticatedSignupId = existingSignupRow.id;
      browserSession.authenticatedWalletAddress = walletProof.walletAddress;
      browserSession.updatedAt = new Date().toISOString();
    }
    writeJson(response, 200, {
      wallet: {
        address: walletProof.walletAddress,
        chainId: walletProof.walletChainId,
        verifiedAt: walletProof.verifiedAt
      },
      existingSignup: signupStore.serializeSignup(existingSignupRow)
    });
  }

  function normalizeManualClaims(value = {}) {
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(Object.keys(MANUAL_FOLLOW_CLAIMS).map((key) => [
      key,
      value[key] === true
    ]));
  }

  function buildManualClaim({ key, now }) {
    const definition = MANUAL_FOLLOW_CLAIMS[key];
    if (!definition) return null;
    return {
      claimed: true,
      status: "claimed",
      checkType: definition.checkType,
      targetId: definition.targetId,
      claimedAt: now,
      source: "user_click",
      verified: false
    };
  }

  function applyManualClaimsToVerification(verification, manualClaims, now) {
    const next = { ...verification };
    for (const [key, claimed] of Object.entries(manualClaims)) {
      if (!claimed) continue;
      const definition = MANUAL_FOLLOW_CLAIMS[key];
      const claim = buildManualClaim({ key, now });
      next[definition.provider] = {
        ...(next[definition.provider] || {}),
        [MANUAL_CLAIM_KEY]: claim
      };
      if (definition.provider === "coinMarketCap") {
        next.coinMarketCap.opened = true;
        next.coinMarketCap.verified = false;
      }
    }
    return next;
  }

  function attachManualClaimVerifications(accounts = [], verification = {}, now) {
    return accounts.map((account) => {
      const definition = Object.values(MANUAL_FOLLOW_CLAIMS)
        .find((claimDefinition) => claimDefinition.provider === account.provider);
      const claim = definition ? verification[account.provider]?.[MANUAL_CLAIM_KEY] : null;
      if (!claim?.claimed) return account;

      const verifications = (account.verifications || [])
        .filter((event) => event.checkType !== definition.checkType);
      return {
        ...account,
        verifications: [
          ...verifications,
          {
            checkType: definition.checkType,
            targetId: definition.targetId,
            status: "claimed",
            checkedAt: claim.claimedAt || now,
            rawResult: claim
          }
        ]
      };
    });
  }

  function buildSignupSocialAccounts({ socialSessions = {}, now }) {
    return socialProviders.buildSocialAccounts(socialSessions, now);
  }

  function getAccountLabel(account) {
    if (!account) return "";
    if (account.provider === "x" && account.username) return `@${account.username}`;
    if (account.provider === "telegram" && account.username) return `@${account.username}`;
    if (account.provider === "github" && account.username) return `@${account.username}`;
    return account.displayName || account.username || account.providerUserId || "account";
  }

  function getWalletLabel(walletAddress) {
    const address = String(walletAddress || "").trim();
    return address || "wallet";
  }

  function getSocialAccountByProvider(signup, provider) {
    return (signup?.socialAccounts || [])
      .find((account) => account?.provider === provider && account.providerUserId) || null;
  }

  function getPendingSocialReplacements(targetSignupSerialized, currentSocialAccounts) {
    if (!targetSignupSerialized?.id) return [];
    return currentSocialAccounts
      .map((account) => {
        const savedAccount = getSocialAccountByProvider(targetSignupSerialized, account.provider);
        if (!savedAccount || savedAccount.providerUserId === account.providerUserId) return null;
        return {
          accountType: "social",
          provider: account.provider,
          providerLabel: getProviderLabel(account.provider),
          oldProviderUserId: savedAccount.providerUserId,
          newProviderUserId: account.providerUserId,
          oldLabel: getAccountLabel(savedAccount),
          newLabel: getAccountLabel(account)
        };
      })
      .filter(Boolean);
  }

  function getPendingWalletReplacement(targetSignupSerialized, walletAddress) {
    if (!targetSignupSerialized?.id || !targetSignupSerialized.walletAddress) return null;
    const oldWalletAddress = requireWalletAddress(targetSignupSerialized.walletAddress);
    const newWalletAddress = requireWalletAddress(walletAddress);
    if (oldWalletAddress === newWalletAddress) return null;

    return {
      accountType: "wallet",
      provider: "wallet",
      providerLabel: "Wallet",
      oldProviderUserId: oldWalletAddress,
      newProviderUserId: newWalletAddress,
      oldLabel: getWalletLabel(oldWalletAddress),
      newLabel: getWalletLabel(newWalletAddress)
    };
  }

  function normalizeConfirmedReplacements(confirmations = []) {
    return Array.isArray(confirmations)
      ? confirmations.map((confirmation) => ({
          accountType: String(confirmation.accountType || confirmation.type || "social").trim().toLowerCase(),
          provider: String(confirmation.provider || "").trim().toLowerCase(),
          oldProviderUserId: String(confirmation.oldProviderUserId || "").trim(),
          newProviderUserId: String(confirmation.newProviderUserId || "").trim()
        }))
      : [];
  }

  function isReplacementConfirmed(replacement, confirmations) {
    return confirmations.some((confirmation) => (
      confirmation.accountType === replacement.accountType
      && confirmation.provider === replacement.provider
      && confirmation.oldProviderUserId === replacement.oldProviderUserId
      && confirmation.newProviderUserId === replacement.newProviderUserId
    ));
  }

  function getUnconfirmedReplacements(replacements, confirmations) {
    return replacements.filter((replacement) => !isReplacementConfirmed(replacement, confirmations));
  }

  function buildReplacementAuditEvents({ replacements, walletAddress, authenticatedWalletAddress, request, now }) {
    return replacements.map((replacement) => ({
      ...replacement,
      authorizedWalletAddress: replacement.accountType === "wallet"
        ? authenticatedWalletAddress || walletAddress
        : walletAddress,
      ipAddress: normalizeText(getClientIp(request), 80),
      userAgent: normalizeText(request.headers["user-agent"], 500),
      createdAt: now,
      rawContext: {
        reason: "signup_update",
        providerLabel: replacement.providerLabel,
        signedWalletAddress: walletAddress
      }
    }));
  }

  function assertNoSocialConflicts(accounts, targetSignupId = "") {
    const conflict = findSocialConflict(signupStore, accounts, targetSignupId);
    if (conflict) {
      throw new HttpError(409, conflict.message || `This ${getProviderLabel(conflict.account?.provider)} account is already linked to another signup.`);
    }
  }

  function buildCurrentVerification({ socialSessions, walletProof, coinMarketCapOpened, manualClaims, now }) {
    const socialVerification = socialProviders.getVerificationSnapshot(socialSessions);
    return applyManualClaimsToVerification({
      ...socialVerification,
      wallet: {
        signed: true,
        chainId: walletProof.walletChainId
      },
      coinMarketCap: { opened: Boolean(coinMarketCapOpened), verified: false }
    }, manualClaims, now);
  }

  async function handleComplete(request, response) {
    const socialSessions = socialProviders.getSessionsFromCookies(request);
    const xSession = socialSessions.x;
    const browserSession = requireBrowserSession(request);
    const body = await readJsonRequest(request);

    await socialProviders.refreshSessions(socialSessions);

    const walletProof = verifyWalletChallengeForBrowserSession(browserSession, body);
    if (!walletProof) {
      throw new HttpError(400, "Verify wallet ownership before submitting.");
    }

    const walletAddress = requireWalletAddress(body.walletAddress || walletProof.walletAddress);
    if (walletAddress !== walletProof.walletAddress) {
      throw new HttpError(400, "Submitted wallet does not match the verified wallet.");
    }

    const now = new Date().toISOString();
    const manualClaimInput = body.manualClaims && typeof body.manualClaims === "object" ? body.manualClaims : {};
    const manualClaims = normalizeManualClaims({
      ...manualClaimInput,
      coinMarketCapFollow: manualClaimInput.coinMarketCapFollow === true || body.coinMarketCapOpened === true
    });
    const currentVerification = buildCurrentVerification({
      socialSessions,
      walletProof,
      coinMarketCapOpened: body.coinMarketCapOpened,
      manualClaims,
      now
    });
    const currentSocialAccounts = buildSignupSocialAccounts({
      socialSessions,
      now
    });

    const existingByX = xSession?.profile?.id ? signupStore.findByXUserId(xSession.profile.id) : null;
    const existingByWallet = signupStore.findByWalletAddress(walletAddress);
    const authenticatedSignup = browserSession.authenticatedSignupId
      ? signupStore.findById(browserSession.authenticatedSignupId)
      : null;
    const targetMatches = getDistinctExistingSignups([authenticatedSignup, existingByWallet]);
    if (targetMatches.length > 1) {
      throw new HttpError(409, "These accounts are already linked to different signups.");
    }
    const targetSignup = targetMatches[0] || null;
    const targetSignupId = targetSignup?.id || "";

    if (existingByX?.id && existingByX.id !== targetSignupId) {
      throw new HttpError(409, "This X account is already linked to another signup.");
    }

    assertNoSocialConflicts(currentSocialAccounts, targetSignupId);

    const targetSignupSerialized = targetSignup ? signupStore.serializeSignup(targetSignup) : null;
    const pendingReplacements = [
      getPendingWalletReplacement(targetSignupSerialized, walletAddress),
      ...getPendingSocialReplacements(targetSignupSerialized, currentSocialAccounts)
    ].filter(Boolean);
    const confirmedReplacements = normalizeConfirmedReplacements(body.confirmedReplacements);
    const unconfirmedReplacements = getUnconfirmedReplacements(pendingReplacements, confirmedReplacements);
    if (unconfirmedReplacements.length > 0) {
      writeJson(response, 409, {
        error: "Confirm account replacement before updating this signup.",
        replacementRequired: true,
        replacements: unconfirmedReplacements
      });
      return;
    }

    if (!hasRequiredSocialAccount(currentSocialAccounts) && !signupHasRequiredSocial(targetSignupSerialized)) {
      throw new HttpError(400, "Connect X, Telegram, Discord, or LinkedIn before submitting.");
    }

    const verification = mergeVerification(targetSignup, currentVerification, { hasXSession: Boolean(xSession?.profile?.id) });
    const mergedSocialAccounts = targetSignupSerialized
      ? mergeSocialAccounts(targetSignupSerialized.socialAccounts, currentSocialAccounts)
      : currentSocialAccounts;
    const socialAccountsWithManualClaims = attachManualClaimVerifications(mergedSocialAccounts, verification, now);
    const signupInput = {
      id: targetSignup?.id || crypto.randomUUID(),
      xUserId: xSession?.profile?.id || targetSignup?.x_user_id || undefined,
      xUsername: xSession?.profile?.username || targetSignup?.x_username || undefined,
      xName: xSession?.profile?.name || targetSignup?.x_name || undefined,
      xProfileImageUrl: xSession?.profile?.profileImageUrl || targetSignup?.x_profile_image_url || undefined,
      walletAddress,
      walletChainId: walletProof.walletChainId,
      signedMessage: walletProof.signedMessage,
      signature: walletProof.signature,
      displayName: targetSignup?.display_name || "",
      email: targetSignup?.email || "",
      country: targetSignup?.country || "",
      interest: targetSignup?.interest || "",
      discordUsername: getOptionalSummaryValue(
        socialSessions.discord?.profile?.legacyTag || socialSessions.discord?.profile?.username,
        targetSignup?.discord_username || ""
      ),
      telegramUsername: getOptionalSummaryValue(
        socialSessions.telegram?.profile?.username || socialSessions.telegram?.profile?.displayName,
        targetSignup?.telegram_username || ""
      ),
      linkedinUrl: getOptionalSummaryValue(socialSessions.linkedin?.profile?.displayName, targetSignup?.linkedin_url || ""),
      notes: targetSignup?.notes || "",
      verificationJson: JSON.stringify(verification),
      status: targetSignup?.status || "received",
      userAgent: normalizeText(request.headers["user-agent"], 500),
      ipAddress: normalizeText(getClientIp(request), 80),
      submittedAt: now,
      createdAt: targetSignup?.created_at || now,
      updatedAt: now,
      socialAccounts: socialAccountsWithManualClaims,
      accountReplacements: buildReplacementAuditEvents({
        replacements: pendingReplacements,
        walletAddress,
        authenticatedWalletAddress: browserSession.authenticatedWalletAddress,
        request,
        now
      })
    };

    try {
      const row = targetSignup ? signupStore.updateSignup(signupInput) : signupStore.saveSignup({
        ...signupInput,
        xUserId: signupInput.xUserId || null,
        xUsername: signupInput.xUsername || "",
        xName: signupInput.xName || "",
        xProfileImageUrl: signupInput.xProfileImageUrl || "",
        discordUsername: signupInput.discordUsername || "",
        telegramUsername: signupInput.telegramUsername || "",
        linkedinUrl: signupInput.linkedinUrl || ""
      });
      if (row?.id) {
        browserSession.authenticatedSignupId = row.id;
        browserSession.authenticatedWalletAddress = walletAddress;
        browserSession.updatedAt = now;
      }
      writeJson(response, 200, { signup: row, created: !targetSignup, updated: Boolean(targetSignup) });
    } catch (error) {
      if (String(error?.code || "") === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new HttpError(409, "This wallet or connected social account has already been used for a signup.");
      }
      throw error;
    }
  }

  return {
    pruneExpired,
    handleChallenge,
    handleWalletVerify,
    handleComplete
  };
}

module.exports = {
  createSignupController
};
