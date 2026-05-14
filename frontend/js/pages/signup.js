import { loadUiConfig } from "../shared/config.js";
import { apiFetch } from "../shared/api.js";
import { createToastController } from "../shared/toast.js";
import { formatAddressShort, normalizeAddress } from "../shared/format.js";
import {
  connectWallet,
  disconnectWallet,
  syncWalletState,
  bindWalletEvents,
  getAvailableWallets
} from "../shared/wallet.js";
import { promptForWalletSelection } from "../shared/wallet-picker.js";
import {
  getXSession,
  clearXSession,
  saveXSession,
  isXAuthConfigured,
  isXSessionExpired,
  startXLogin,
  logoutXSession,
  completeXLoginIfPresent
} from "../shared/x-auth.js";
import { checklistProviders } from "../checklist-providers/index.js";

const runtime = {
  config: {},
  account: null,
  chainId: null,
  chainName: null,
  provider: null,
  providerSource: null,
  signer: null,
  injectedProvider: null,
  selectedWalletId: null,
  selectedWalletName: null,
  selectedWalletRdns: null,
  isConnectingWallet: false,
  isVerifyingWallet: false,
  isConnectingX: false,
  isConnectingDiscord: false,
  isConnectingTelegram: false,
  isConnectingLinkedIn: false,
  isConnectingGitHub: false,
  isLoadingSignup: false,
  isSubmitting: false,
  xSession: null,
  discordSession: null,
  telegramSession: null,
  linkedinSession: null,
  githubSession: null,
  walletProof: null,
  existingSignup: null,
  conflictMessage: "",
  coinMarketCapOpened: false
};

for (const provider of checklistProviders) {
  if (provider.sessionKey && !(provider.sessionKey in runtime)) runtime[provider.sessionKey] = null;
  if (provider.connectingKey && !(provider.connectingKey in runtime)) runtime[provider.connectingKey] = false;
  if (provider.trackKey && !(provider.trackKey in runtime)) runtime[provider.trackKey] = false;
}

const els = {
  connectButton: document.getElementById("connectButton"),
  walletMenu: document.getElementById("walletMenu"),
  walletMenuAddress: document.getElementById("walletMenuAddress"),
  walletMenuChainId: document.getElementById("walletMenuChainId"),
  loadSignupButton: document.getElementById("loadSignupButton"),
  copyWalletAddressButton: document.getElementById("copyWalletAddressButton"),
  disconnectButton: document.getElementById("disconnectButton"),
  walletStatusRow: document.getElementById("walletStatusRow"),
  walletStatusText: document.getElementById("walletStatusText"),
  xStatusRow: document.getElementById("xStatusRow"),
  xStatusText: document.getElementById("xStatusText"),
  xAuthButton: document.getElementById("xAuthButton"),
  xDisconnectButton: document.getElementById("xDisconnectButton"),
  optionalChecklist: document.getElementById("optionalChecklist"),
  xChecklistLink: document.getElementById("xChecklistLink"),
  submitButton: document.getElementById("submitButton"),
  proofHint: document.getElementById("proofHint"),
  submissionStatus: document.getElementById("submissionStatus"),
  existingSignupPanel: document.getElementById("existingSignupPanel"),
  existingSignupText: document.getElementById("existingSignupText"),
  signupToast: document.getElementById("signupToast"),
  signupToastMessage: document.getElementById("signupToastMessage"),
  signupToastClose: document.getElementById("signupToastClose"),
  xLink: document.getElementById("xLink"),
  footerSocialLinks: document.getElementById("footerSocialLinks")
};

const providerElements = new Map();
const REQUIRED_SOCIAL_PROVIDER_IDS = new Set(["x", "discord", "telegram", "linkedin"]);
const PROVIDER_LABELS = {
  x: "X",
  discord: "Discord",
  telegram: "Telegram",
  linkedin: "LinkedIn",
  github: "GitHub",
  youtube: "YouTube"
};

const toast = createToastController({
  element: els.signupToast,
  messageElement: els.signupToastMessage,
  closeButton: els.signupToastClose
});

function showMessage(message, tone = "info") {
  toast.show(message, tone);
}

function reportError(error, context) {
  console.error(`[${context}]`, error);
  showMessage(`${context}: ${error?.message || error}`, "error");
}

function getVerifiedWalletAddress() {
  return normalizeAddress(runtime.walletProof?.walletAddress || runtime.walletProof?.address || "");
}

function hasConnectedWallet() {
  return Boolean(runtime.account);
}

function getSavedSocialAccount(providerId) {
  const normalizedProvider = String(providerId || "").trim().toLowerCase();
  const signup = runtime.existingSignup;
  if (!normalizedProvider || !signup?.id) return null;

  const account = (signup.socialAccounts || [])
    .find((socialAccount) => socialAccount?.provider === normalizedProvider && socialAccount.providerUserId);
  if (account) return account;

  if (normalizedProvider === "x" && signup.xUserId) {
    return {
      provider: "x",
      providerUserId: signup.xUserId,
      username: signup.xUsername,
      displayName: signup.xName || signup.xUsername
    };
  }

  return null;
}

function hasSavedSocialProvider(providerId) {
  return Boolean(getSavedSocialAccount(providerId));
}

function hasPassedSavedVerification(account, checkType) {
  return (account?.verifications || []).some((verification) => (
    verification?.checkType === checkType && verification.status === "passed"
  ));
}

function isSavedProviderReady(providerId, account) {
  if (!account) return false;
  if (REQUIRED_SOCIAL_PROVIDER_IDS.has(providerId)) return true;
  if (providerId === "github") return hasPassedSavedVerification(account, "github_repo_starred");
  if (providerId === "youtube") return hasPassedSavedVerification(account, "youtube_channel_subscribed");
  return true;
}

function hasRequiredSocialSession() {
  return Boolean(
    runtime.xSession?.profile?.id
    || runtime.telegramSession?.profile?.id
    || runtime.discordSession?.profile?.id
    || runtime.linkedinSession?.profile?.id
    || [...REQUIRED_SOCIAL_PROVIDER_IDS].some(hasSavedSocialProvider)
  );
}

function isExistingSignupForCurrentWallet() {
  if (!runtime.existingSignup?.walletAddress || !runtime.account) return false;
  return normalizeAddress(runtime.existingSignup.walletAddress) === normalizeAddress(runtime.account);
}

function clearLoadedSignupIfWalletChanged() {
  if (!runtime.existingSignup || isExistingSignupForCurrentWallet()) return;
  runtime.existingSignup = null;
  runtime.walletProof = null;
}

function setConflict(message) {
  runtime.conflictMessage = message;
  if (message) {
    showMessage(message, "error");
  }
}

function applyExistingSignup(signup, source) {
  if (!signup?.id) return;

  if (runtime.existingSignup?.id && runtime.existingSignup.id !== signup.id) {
    setConflict(`The ${source} is linked to a different existing signup. Account replacement needs an explicit workflow.`);
    return;
  }

  runtime.existingSignup = signup;
  runtime.conflictMessage = "";
}

function getConfiguredHref(link) {
  const links = runtime.config.socialLinks || {};
  return links[link.hrefKey] || links[link.fallbackHrefKey] || link.defaultHref || "#";
}

function setActionLinkDisabled(anchor, disabled) {
  if (!anchor) return;
  anchor.setAttribute("aria-disabled", disabled ? "true" : "false");
  anchor.tabIndex = disabled ? -1 : 0;
}

function createProviderLink(provider, link) {
  const anchor = document.createElement("a");
  anchor.className = "secondary nav-button checklist-link";
  anchor.href = getConfiguredHref(link);
  anchor.target = "_blank";
  anchor.rel = "noreferrer noopener";
  anchor.textContent = link.label;
  anchor.dataset.providerId = provider.id;
  anchor.dataset.hrefKey = link.hrefKey || "";
  anchor.dataset.fallbackHrefKey = link.fallbackHrefKey || "";
  setActionLinkDisabled(anchor, true);
  anchor.addEventListener("click", (event) => {
    if (anchor.getAttribute("aria-disabled") === "true") {
      event.preventDefault();
      showMessage("Connect a wallet first.", "error");
      return;
    }

    if (provider.onLinkClick) {
      provider.onLinkClick({ runtime, link });
      syncUi();
    }
  });
  if (provider.onLinkClick) {
    anchor.dataset.tracksClick = "true";
  }
  return anchor;
}

function renderProviderRows() {
  const fragment = document.createDocumentFragment();

  for (const provider of checklistProviders) {
    const row = document.createElement("article");
    row.className = "checklist-item";
    row.id = `${provider.id}StatusRow`;

    const dot = document.createElement("span");
    dot.className = "status-dot";
    dot.setAttribute("aria-hidden", "true");

    const copy = document.createElement("div");
    copy.className = "checklist-copy";

    const titleRow = document.createElement("div");
    titleRow.className = "checklist-title-row";

    const title = document.createElement("h3");
    title.textContent = provider.title;

    const optional = document.createElement("span");
    optional.className = provider.requirementLabel ? "choice-pill" : "optional-pill";
    optional.textContent = provider.requirementLabel || "Optional";

    const statusText = document.createElement("p");
    statusText.id = `${provider.id}StatusText`;
    statusText.textContent = "Connect a wallet first.";

    titleRow.append(title, optional);
    copy.append(titleRow, statusText);

    const actions = document.createElement("div");
    actions.className = "checklist-actions button-row";
    const links = (provider.links || []).map((link) => createProviderLink(provider, link));
    actions.append(...links);

    let authButton = null;
    let disconnectButton = null;
    if (provider.start) {
      authButton = document.createElement("button");
      authButton.id = `${provider.id}AuthButton`;
      authButton.type = "button";
      authButton.className = "secondary";
      authButton.textContent = "Sign in";
      authButton.disabled = true;
      actions.append(authButton);
    }
    if (provider.disconnect) {
      disconnectButton = document.createElement("button");
      disconnectButton.id = `${provider.id}DisconnectButton`;
      disconnectButton.type = "button";
      disconnectButton.className = "ghost";
      disconnectButton.textContent = "Sign out";
      disconnectButton.hidden = true;
      disconnectButton.disabled = true;
      actions.append(disconnectButton);
    }

    providerElements.set(provider.id, {
      row,
      statusText,
      links,
      authButton,
      disconnectButton
    });
    row.append(dot, copy, actions);
    fragment.append(row);
  }

  els.optionalChecklist.replaceChildren(fragment);
}

function renderFooterLinks() {
  const adminLink = els.footerSocialLinks.querySelector('a[href="./admin/"]');
  const anchors = [];
  for (const provider of checklistProviders) {
    if (!provider.footerLink) continue;
    const anchor = document.createElement("a");
    anchor.className = "footer-link-anchor";
    anchor.href = getConfiguredHref(provider.footerLink);
    anchor.target = "_blank";
    anchor.rel = "noreferrer noopener";
    anchor.textContent = provider.footerLink.label;
    anchor.dataset.providerId = provider.id;
    anchor.dataset.hrefKey = provider.footerLink.hrefKey || "";
    anchor.dataset.fallbackHrefKey = provider.footerLink.fallbackHrefKey || "";
    anchors.push(anchor);
  }
  els.footerSocialLinks.replaceChildren(...[els.xLink, ...anchors, adminLink].filter(Boolean));
}

function updateProviderLinks(provider, elements) {
  for (const anchor of elements.links || []) {
    anchor.href = getConfiguredHref({
      hrefKey: anchor.dataset.hrefKey,
      fallbackHrefKey: anchor.dataset.fallbackHrefKey,
      defaultHref: anchor.href
    });
    setActionLinkDisabled(anchor, !hasConnectedWallet());
  }

  const footerAnchor = els.footerSocialLinks.querySelector(`[data-provider-id="${provider.id}"]`);
  if (footerAnchor && provider.footerLink) {
    footerAnchor.href = getConfiguredHref(provider.footerLink);
  }
}

function getSavedAccountName(account, fallback = "account") {
  if (!account) return fallback;
  if (account.provider === "x" && account.username) return `@${account.username}`;
  if (account.provider === "telegram" && account.username) return `@${account.username}`;
  if (account.provider === "github" && account.username) return `@${account.username}`;
  return account.displayName || account.username || fallback;
}

function getCurrentSocialAccount(providerId) {
  const provider = String(providerId || "").trim();
  if (provider === "x" && runtime.xSession?.profile?.id) {
    const profile = runtime.xSession.profile;
    return {
      accountType: "social",
      provider,
      providerLabel: PROVIDER_LABELS[provider] || provider,
      providerUserId: String(profile.id),
      label: profile.username ? `@${profile.username}` : profile.name || String(profile.id)
    };
  }

  const checklistProvider = checklistProviders.find((item) => item.id === provider);
  const session = checklistProvider?.sessionKey ? runtime[checklistProvider.sessionKey] : null;
  const profile = session?.profile || null;
  if (!profile?.id) return null;

  const youtubeChannel = provider === "youtube" ? profile.youtubeChannel : null;
  const providerUserId = youtubeChannel?.id || profile.id;
  const label = provider === "telegram" && profile.username
    ? `@${profile.username}`
    : provider === "github" && profile.username
      ? `@${profile.username}`
      : provider === "youtube" && youtubeChannel?.handle
        ? `@${youtubeChannel.handle}`
        : youtubeChannel?.title
          || profile.displayName
          || profile.name
          || profile.username
          || providerUserId;

  return {
    accountType: "social",
    provider,
    providerLabel: PROVIDER_LABELS[provider] || checklistProvider?.title || provider,
    providerUserId: String(providerUserId),
    label
  };
}

function getPendingSocialReplacements() {
  if (!runtime.existingSignup?.id) return [];
  const providerIds = ["x", ...checklistProviders.map((provider) => provider.id)];
  return providerIds
    .map((providerId) => {
      const savedAccount = getSavedSocialAccount(providerId);
      const currentAccount = getCurrentSocialAccount(providerId);
      if (!savedAccount || !currentAccount || savedAccount.providerUserId === currentAccount.providerUserId) return null;
      return {
        accountType: "social",
        provider: providerId,
        providerLabel: currentAccount.providerLabel,
        oldProviderUserId: savedAccount.providerUserId,
        newProviderUserId: currentAccount.providerUserId,
        oldLabel: getSavedAccountName(savedAccount, savedAccount.providerUserId),
        newLabel: currentAccount.label
      };
    })
    .filter(Boolean);
}

function confirmPendingSocialReplacements() {
  const replacements = getPendingSocialReplacements();
  if (replacements.length === 0) return [];

  const lines = replacements.map((replacement) => (
    `${replacement.providerLabel}: ${replacement.oldLabel} -> ${replacement.newLabel}`
  ));
  const confirmed = window.confirm([
    "Update this saved signup with the newly connected account?",
    "",
    ...lines,
    "",
    "This will replace the saved account after you sign with your wallet."
  ].join("\n"));
  if (!confirmed) {
    showMessage("Account replacement canceled.");
    return null;
  }

  return replacements.map((replacement) => ({
    accountType: replacement.accountType,
    provider: replacement.provider,
    oldProviderUserId: replacement.oldProviderUserId,
    newProviderUserId: replacement.newProviderUserId
  }));
}

function getSavedProviderStatusText(provider, account) {
  const name = getSavedAccountName(account, provider.title);
  return `${name} saved from this wallet's existing signup`;
}

function setWalletMenuOpen(isOpen) {
  if (!els.walletMenu) return;
  els.walletMenu.hidden = !isOpen;
  els.connectButton?.setAttribute("aria-expanded", isOpen ? "true" : "false");
}

function toggleWalletMenu() {
  setWalletMenuOpen(Boolean(els.walletMenu?.hidden));
}

function syncWalletUi() {
  const hasWallet = Boolean(runtime.account);
  clearLoadedSignupIfWalletChanged();
  const loadedForWallet = isExistingSignupForCurrentWallet();

  if (runtime.isConnectingWallet) {
    els.connectButton.textContent = "Connecting...";
  } else if (!hasWallet) {
    els.connectButton.textContent = "Connect Wallet";
  } else {
    els.connectButton.textContent = "Wallet Options";
  }

  els.connectButton.disabled = runtime.isConnectingWallet || runtime.isSubmitting;
  els.loadSignupButton.hidden = !hasWallet || loadedForWallet;
  els.loadSignupButton.disabled = runtime.isLoadingSignup || runtime.isSubmitting;
  els.loadSignupButton.textContent = runtime.isLoadingSignup ? "Loading..." : "Load saved";
  els.walletMenuAddress.textContent = hasWallet ? formatAddressShort(runtime.account) : "-";
  els.walletMenuAddress.title = runtime.account || "";
  els.walletMenuChainId.textContent = runtime.chainName || (runtime.chainId ? String(runtime.chainId) : "-");
  els.walletStatusRow.dataset.ready = hasWallet ? "true" : "false";
  if (!hasWallet) {
    els.walletStatusText.textContent = "Not connected";
  } else if (loadedForWallet) {
    els.walletStatusText.textContent = `${formatAddressShort(runtime.account)} connected; saved signup loaded`;
  } else {
    els.walletStatusText.textContent = `${formatAddressShort(runtime.account)} connected; load saved accounts or submit with a social sign-in`;
  }

  if (!hasWallet) {
    setWalletMenuOpen(false);
  }
}

function syncXSessionFromStorage() {
  const session = getXSession();
  runtime.xSession = session && !isXSessionExpired(session) ? session : null;
  if (session && !runtime.xSession) clearXSession();
}

function syncXUi() {
  const configured = isXAuthConfigured(runtime.config);
  const walletReady = hasConnectedWallet();
  const profile = runtime.xSession?.profile || null;
  const savedAccount = getSavedSocialAccount("x");
  const signedIn = Boolean(profile?.username);
  const ready = signedIn || Boolean(savedAccount);
  els.xStatusRow.dataset.ready = ready ? "true" : "false";
  els.xStatusText.textContent = signedIn
    ? `@${profile.username} connected`
    : savedAccount
      ? getSavedProviderStatusText({ title: "X" }, savedAccount)
      : configured ? "Connect your X account." : "X sign-in is not configured";
  els.xAuthButton.hidden = signedIn;
  els.xAuthButton.disabled = !walletReady || runtime.isConnectingX || !configured;
  els.xAuthButton.textContent = runtime.isConnectingX ? "Opening X..." : savedAccount ? "Change" : "Sign in with X";
  els.xDisconnectButton.hidden = !signedIn;
  els.xDisconnectButton.disabled = !walletReady;
  setActionLinkDisabled(els.xChecklistLink, !walletReady);
}

function syncOptionalRows() {
  for (const provider of checklistProviders) {
    const elements = providerElements.get(provider.id);
    if (!elements) continue;

    const walletReady = hasConnectedWallet();
    const session = provider.sessionKey ? runtime[provider.sessionKey] : null;
    const savedAccount = getSavedSocialAccount(provider.id);
    const configured = provider.isConfigured ? provider.isConfigured(runtime.config) : true;
    const ready = provider.isReady
      ? provider.isReady(session, runtime) || isSavedProviderReady(provider.id, savedAccount)
      : isSavedProviderReady(provider.id, savedAccount);
    const connecting = provider.connectingKey ? Boolean(runtime[provider.connectingKey]) : false;

    elements.row.dataset.ready = ready ? "true" : "false";
    elements.statusText.textContent = session
      ? provider.getStatusText({
          session,
          runtime,
          config: runtime.config,
          configured
        })
      : savedAccount
        ? getSavedProviderStatusText(provider, savedAccount)
        : provider.getStatusText({
            session,
            runtime,
            config: runtime.config,
            configured
          });

    updateProviderLinks(provider, elements);

    if (elements.authButton) {
      const activeReady = session && provider.isReady ? provider.isReady(session, runtime) : false;
      elements.authButton.hidden = Boolean(activeReady);
      elements.authButton.disabled = !walletReady || connecting || !configured;
      elements.authButton.textContent = !session && savedAccount
        ? "Change"
        : provider.getAuthButtonText
          ? provider.getAuthButtonText({ connecting, session, runtime, config: runtime.config })
          : connecting ? "Opening..." : "Sign in";
    }
    if (elements.disconnectButton) {
      elements.disconnectButton.hidden = !session;
      elements.disconnectButton.disabled = !walletReady;
    }
  }
}

function syncExistingSignupUi() {
  const signup = runtime.existingSignup;
  els.existingSignupPanel.hidden = !signup;

  if (!signup) {
    return;
  }

  const wallet = signup.walletAddress ? formatAddressShort(signup.walletAddress) : "no wallet";
  const requiredProvider = ["x", "discord", "telegram", "linkedin"]
    .map((providerId) => getSavedSocialAccount(providerId))
    .find(Boolean);
  const username = requiredProvider
    ? `${requiredProvider.provider}: ${getSavedAccountName(requiredProvider)}`
    : "no required social";
  const status = signup.status || "received";
  const summary = `${username} with ${wallet}, status ${status}`;
  els.existingSignupText.textContent = summary;
}

function syncSubmitUi() {
  const walletReady = hasConnectedWallet();
  const requiredSocialReady = hasRequiredSocialSession();
  const ready = walletReady && requiredSocialReady && !runtime.conflictMessage;
  els.submitButton.disabled = !ready || runtime.isSubmitting;
  els.submitButton.textContent = runtime.isSubmitting ? "Signing..." : runtime.existingSignup ? "Update & Sign" : "Submit & Sign";

  if (runtime.conflictMessage) {
    els.proofHint.textContent = runtime.conflictMessage;
    els.submissionStatus.textContent = "Conflict";
    els.submissionStatus.dataset.tone = "error";
  } else if (runtime.existingSignup) {
    els.proofHint.textContent = "Existing signup loaded. Submit and sign to save updates.";
    els.submissionStatus.textContent = "Loaded";
    els.submissionStatus.dataset.tone = "ready";
  } else if (ready) {
    els.proofHint.textContent = "Ready to submit. Nothing is saved until you click Submit & Sign.";
    els.submissionStatus.textContent = "Ready";
    els.submissionStatus.dataset.tone = "ready";
  } else if (!walletReady) {
    els.proofHint.textContent = "Nothing is saved yet. Connect a wallet before submitting.";
    els.submissionStatus.textContent = "Draft";
    els.submissionStatus.dataset.tone = "neutral";
  } else if (!requiredSocialReady) {
    els.proofHint.textContent = "Nothing is saved yet. Connect X, Telegram, Discord, or LinkedIn, or load a saved signup for this wallet.";
    els.submissionStatus.textContent = "Draft";
    els.submissionStatus.dataset.tone = "neutral";
  } else {
    els.proofHint.textContent = "Nothing is saved yet. Complete the required checklist items before submitting.";
    els.submissionStatus.textContent = "Draft";
    els.submissionStatus.dataset.tone = "neutral";
  }
}

function syncUi() {
  syncWalletUi();
  syncXUi();
  syncOptionalRows();
  syncExistingSignupUi();
  syncSubmitUi();
}

async function createWalletSignature() {
  if (!runtime.account || !runtime.signer) {
    throw new Error("Connect a wallet first.");
  }

  const walletAddress = normalizeAddress(runtime.account);
  const challenge = await apiFetch(runtime.config, "/api/signup/challenge", {
    method: "POST",
    body: JSON.stringify({
      walletAddress,
      chainId: runtime.chainId
    })
  });
  const signature = await runtime.signer.signMessage(challenge.message);
  return {
    challengeId: challenge.challengeId,
    walletAddress,
    signature
  };
}

async function loadExistingSignupForWallet() {
  if (!hasConnectedWallet()) {
    throw new Error("Connect a wallet first.");
  }

  runtime.isLoadingSignup = true;
  runtime.isVerifyingWallet = true;
  syncUi();

  try {
    const walletSignature = await createWalletSignature();
    const result = await apiFetch(runtime.config, "/api/signup/wallet/verify", {
      method: "POST",
      body: JSON.stringify({
        walletAddress: walletSignature.walletAddress,
        challengeId: walletSignature.challengeId,
        signature: walletSignature.signature
      })
    });

    runtime.walletProof = {
      walletAddress: result.wallet?.address || walletSignature.walletAddress,
      chainId: result.wallet?.chainId || runtime.chainId,
      verifiedAt: result.wallet?.verifiedAt || new Date().toISOString()
    };

    if (result.existingSignup?.id) {
      applyExistingSignup(result.existingSignup, "wallet");
      showMessage("Saved signup loaded.", "success");
    } else {
      runtime.existingSignup = null;
      showMessage("No saved signup exists for this wallet yet.");
    }
  } finally {
    runtime.isVerifyingWallet = false;
    runtime.isLoadingSignup = false;
    syncUi();
  }
}

async function connectSelectedWallet() {
  runtime.isConnectingWallet = true;
  syncUi();
  try {
    const wallets = await getAvailableWallets(runtime.config);
    const selectedWalletId = await promptForWalletSelection({
      wallets,
      selectedWalletId: runtime.selectedWalletId,
      title: "Select Wallet"
    });
    if (!selectedWalletId) return;
    await connectWallet(runtime, selectedWalletId);
    runtime.walletProof = null;
    showMessage("Wallet connected.", "success");
  } finally {
    runtime.isConnectingWallet = false;
    syncUi();
  }
}

async function submitSignup() {
  if (!hasConnectedWallet()) {
    throw new Error("Connect a wallet first.");
  }
  if (!hasRequiredSocialSession()) {
    throw new Error("Connect X, Telegram, Discord, or LinkedIn first.");
  }

  const confirmedReplacements = confirmPendingSocialReplacements();
  if (confirmedReplacements === null) return;

  runtime.isSubmitting = true;
  runtime.isVerifyingWallet = true;
  syncUi();

  try {
    const walletSignature = await createWalletSignature();
    const headers = runtime.xSession?.csrfToken
      ? { "X-CSRF-Token": runtime.xSession.csrfToken }
      : {};
    const result = await apiFetch(runtime.config, "/api/signup/complete", {
      method: "POST",
      headers,
      body: JSON.stringify({
        walletAddress: walletSignature.walletAddress,
        challengeId: walletSignature.challengeId,
        signature: walletSignature.signature,
        coinMarketCapOpened: runtime.coinMarketCapOpened,
        confirmedReplacements
      })
    });

    applyExistingSignup(result.signup, "submitted signup");
    runtime.walletProof = {
      walletAddress: walletSignature.walletAddress,
      chainId: runtime.chainId,
      verifiedAt: new Date().toISOString()
    };
    const savedName = result.signup?.xUsername ? `@${result.signup.xUsername}` : formatAddressShort(result.signup?.walletAddress || walletSignature.walletAddress);
    showMessage(result.updated ? "Signup updated." : `Signup received for ${savedName}.`, "success");
  } catch (error) {
    if (error?.payload?.replacementRequired) {
      throw new Error("This update would replace a saved account. Load the saved signup first so you can review and confirm the change.");
    }
    throw error;
  } finally {
    runtime.isVerifyingWallet = false;
    runtime.isSubmitting = false;
    syncUi();
  }
}

function applySocialLinks() {
  const links = runtime.config.socialLinks || {};
  const setHref = (element, href) => {
    if (element && href) element.href = href;
  };
  setHref(els.xLink, links.x);
  setHref(els.xChecklistLink, links.x);
  for (const provider of checklistProviders) {
    const elements = providerElements.get(provider.id);
    if (elements) updateProviderLinks(provider, elements);
  }
}

async function loadPublicBackendConfig() {
  try {
    const publicConfig = await apiFetch(runtime.config, "/api/public/config");
    runtime.config.socialLinks = {
      ...(runtime.config.socialLinks || {}),
      ...(publicConfig.socialLinks || {})
    };
    for (const provider of checklistProviders) {
      for (const key of provider.configKeys || []) {
        runtime.config[key] = {
          ...(runtime.config[key] || {}),
          ...(publicConfig[key] || {})
        };
      }
    }
    applySocialLinks();
  } catch {
    // Static config links are still usable if the backend public config is unavailable.
  }
}

function bindEvents() {
  els.connectButton.addEventListener("click", async () => {
    try {
      if (!runtime.account) {
        await connectSelectedWallet();
        return;
      }
      toggleWalletMenu();
    } catch (error) {
      reportError(error, "Wallet");
    }
  });

  els.disconnectButton.addEventListener("click", async () => {
    try {
      await disconnectWallet(runtime);
      runtime.walletProof = null;
      runtime.existingSignup = null;
      runtime.conflictMessage = "";
      syncUi();
      showMessage("Wallet disconnected.");
    } catch (error) {
      reportError(error, "Disconnect wallet");
    }
  });

  els.loadSignupButton.addEventListener("click", () => {
    loadExistingSignupForWallet().catch((error) => reportError(error, "Load saved signup"));
  });

  els.copyWalletAddressButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(runtime.account || "");
      showMessage("Wallet address copied.", "success");
    } catch (error) {
      reportError(error, "Copy wallet");
    }
  });

  els.xAuthButton.addEventListener("click", async () => {
    try {
      runtime.isConnectingX = true;
      syncUi();
      await startXLogin(runtime.config);
    } catch (error) {
      runtime.isConnectingX = false;
      syncUi();
      reportError(error, "Start X sign-in");
    }
  });

  els.xChecklistLink.addEventListener("click", (event) => {
    if (els.xChecklistLink.getAttribute("aria-disabled") !== "true") return;
    event.preventDefault();
    showMessage("Connect a wallet first.", "error");
  });

  els.xDisconnectButton.addEventListener("click", async () => {
    try {
      await logoutXSession(runtime.config, runtime.xSession);
      runtime.xSession = null;
      syncUi();
      showMessage("X account disconnected.");
    } catch (error) {
      reportError(error, "Disconnect X");
    }
  });

  for (const provider of checklistProviders) {
    const elements = providerElements.get(provider.id);
    if (elements?.authButton && provider.start) {
      elements.authButton.addEventListener("click", async () => {
        try {
          if (provider.connectingKey) runtime[provider.connectingKey] = true;
          syncUi();
          const result = await provider.start({ runtime, syncUi, showMessage });
          if (result?.redirecting) return;
        } catch (error) {
          reportError(error, `Start ${provider.title} sign-in`);
        } finally {
          if (provider.connectingKey) runtime[provider.connectingKey] = false;
          syncUi();
        }
      });
    }

    if (elements?.disconnectButton && provider.disconnect) {
      elements.disconnectButton.addEventListener("click", async () => {
        try {
          await provider.disconnect({ runtime });
          if (provider.sessionKey) runtime[provider.sessionKey] = null;
          syncUi();
          showMessage(`${provider.title} account disconnected.`);
        } catch (error) {
          reportError(error, `Disconnect ${provider.title}`);
        }
      });
    }
  }

  els.submitButton.addEventListener("click", () => {
    submitSignup().catch((error) => reportError(error, "Submit signup"));
  });

  bindWalletEvents({
    onAccountsChanged: async () => {
      const previousProofAddress = getVerifiedWalletAddress();
      const previousAccount = normalizeAddress(runtime.account);
      const hadLoadedSignup = Boolean(runtime.existingSignup);
      await syncWalletState(runtime);
      const nextAccount = normalizeAddress(runtime.account);
      if (previousProofAddress !== nextAccount) {
        runtime.walletProof = null;
        runtime.existingSignup = null;
        runtime.conflictMessage = "";
      }
      if (previousAccount && nextAccount && previousAccount !== nextAccount) {
        showMessage(hadLoadedSignup
          ? `Wallet changed to ${formatAddressShort(nextAccount)}. Saved signup state cleared.`
          : `Wallet changed to ${formatAddressShort(nextAccount)}.`
        );
      }
      syncUi();
    },
    onChainChanged: async () => {
      await syncWalletState(runtime);
      syncUi();
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (els.walletMenu.contains(target) || els.connectButton.contains(target)) return;
    setWalletMenuOpen(false);
  });
}

async function init() {
  renderProviderRows();
  renderFooterLinks();

  const loaded = await loadUiConfig();
  runtime.config = loaded.config;
  applySocialLinks();
  await loadPublicBackendConfig();
  syncXSessionFromStorage();
  bindEvents();

  try {
    const result = await completeXLoginIfPresent(runtime.config);
    runtime.xSession = result.session || runtime.xSession;
    if (result.handled && runtime.xSession) {
      saveXSession(runtime.xSession);
      showMessage("X account connected.", "success");
    }
  } catch (error) {
    clearXSession();
    runtime.xSession = null;
    reportError(error, "Complete X sign-in");
  }

  for (const provider of checklistProviders) {
    if (!provider.sessionKey) continue;

    try {
      const result = provider.complete ? await provider.complete(runtime.config) : { handled: false, session: null };
      runtime[provider.sessionKey] = result.session || runtime[provider.sessionKey];
      if (result.handled && runtime[provider.sessionKey]) {
        showMessage(provider.getSuccessMessage?.(runtime[provider.sessionKey]) || `${provider.title} account connected.`, "success");
      }
    } catch (error) {
      runtime[provider.sessionKey] = null;
      reportError(error, `Complete ${provider.title} sign-in`);
    }

    if (!runtime[provider.sessionKey] && provider.fetchSession) {
      runtime[provider.sessionKey] = await provider.fetchSession(runtime.config).catch(() => null);
    }
  }

  await syncWalletState(runtime).catch(() => null);
  syncUi();
}

init().catch((error) => reportError(error, "Initialize"));
