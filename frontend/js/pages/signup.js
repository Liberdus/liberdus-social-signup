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

function hasVerifiedWallet() {
  return Boolean(runtime.account && getVerifiedWalletAddress() === normalizeAddress(runtime.account));
}

function hasRequiredSocialSession() {
  return Boolean(
    runtime.telegramSession?.profile?.id
    || runtime.discordSession?.profile?.id
    || runtime.linkedinSession?.profile?.id
  );
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
  if (provider.onLinkClick) {
    anchor.addEventListener("click", () => {
      provider.onLinkClick({ runtime, link });
      syncUi();
    });
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
      actions.append(authButton);
    }
    if (provider.disconnect) {
      disconnectButton = document.createElement("button");
      disconnectButton.id = `${provider.id}DisconnectButton`;
      disconnectButton.type = "button";
      disconnectButton.className = "ghost";
      disconnectButton.textContent = "Sign out";
      disconnectButton.hidden = true;
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
  }

  const footerAnchor = els.footerSocialLinks.querySelector(`[data-provider-id="${provider.id}"]`);
  if (footerAnchor && provider.footerLink) {
    footerAnchor.href = getConfiguredHref(provider.footerLink);
  }
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
  const verifiedWallet = hasVerifiedWallet();

  if (runtime.isConnectingWallet) {
    els.connectButton.textContent = "Connecting...";
  } else if (runtime.isVerifyingWallet) {
    els.connectButton.textContent = "Signing...";
  } else if (!hasWallet) {
    els.connectButton.textContent = "Connect Wallet";
  } else if (!verifiedWallet) {
    els.connectButton.textContent = "Sign Wallet";
  } else {
    els.connectButton.textContent = "Wallet Options";
  }

  els.connectButton.disabled = runtime.isConnectingWallet || runtime.isVerifyingWallet;
  els.walletMenuAddress.textContent = hasWallet ? formatAddressShort(runtime.account) : "-";
  els.walletMenuAddress.title = runtime.account || "";
  els.walletMenuChainId.textContent = runtime.chainName || (runtime.chainId ? String(runtime.chainId) : "-");
  els.walletStatusRow.dataset.ready = verifiedWallet ? "true" : "false";
  els.walletStatusText.textContent = verifiedWallet
    ? `${formatAddressShort(runtime.account)} verified`
    : hasWallet
      ? `${formatAddressShort(runtime.account)} connected; signature needed`
      : "Not connected";

  if (!hasWallet || !verifiedWallet) {
    setWalletMenuOpen(false);
  }
}

function syncXSessionFromStorage() {
  const session = getXSession();
  runtime.xSession = session && !isXSessionExpired(session) ? session : null;
  if (session && !runtime.xSession) clearXSession();
  if (runtime.xSession?.existingSignup) {
    applyExistingSignup(runtime.xSession.existingSignup, "X account");
  }
}

function syncXUi() {
  const configured = isXAuthConfigured(runtime.config);
  const profile = runtime.xSession?.profile || null;
  const signedIn = Boolean(profile?.username);
  els.xStatusRow.dataset.ready = signedIn ? "true" : "false";
  els.xStatusText.textContent = signedIn ? `@${profile.username}` : configured ? "Optional X sign-in" : "X sign-in is not configured";
  els.xAuthButton.hidden = signedIn;
  els.xAuthButton.disabled = runtime.isConnectingX || !configured;
  els.xAuthButton.textContent = runtime.isConnectingX ? "Opening X..." : "Sign in with X";
  els.xDisconnectButton.hidden = !signedIn;
}

function syncOptionalRows() {
  for (const provider of checklistProviders) {
    const elements = providerElements.get(provider.id);
    if (!elements) continue;

    const session = provider.sessionKey ? runtime[provider.sessionKey] : null;
    const configured = provider.isConfigured ? provider.isConfigured(runtime.config) : true;
    const ready = provider.isReady ? provider.isReady(session, runtime) : false;
    const connecting = provider.connectingKey ? Boolean(runtime[provider.connectingKey]) : false;

    elements.row.dataset.ready = ready ? "true" : "false";
    elements.statusText.textContent = provider.getStatusText({
      session,
      runtime,
      config: runtime.config,
      configured
    });

    updateProviderLinks(provider, elements);

    if (elements.authButton) {
      elements.authButton.hidden = ready;
      elements.authButton.disabled = connecting || !configured;
      elements.authButton.textContent = provider.getAuthButtonText
        ? provider.getAuthButtonText({ connecting, session, runtime, config: runtime.config })
        : connecting ? "Opening..." : "Sign in";
    }
    if (elements.disconnectButton) {
      elements.disconnectButton.hidden = !session;
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
  const username = signup.xUsername ? `@${signup.xUsername}` : "unknown X";
  const status = signup.status || "received";
  const summary = `${username} with ${wallet}, status ${status}`;
  els.existingSignupText.textContent = summary;
}

function syncSubmitUi() {
  const walletReady = hasVerifiedWallet();
  const requiredSocialReady = hasRequiredSocialSession();
  const ready = walletReady && requiredSocialReady && !runtime.conflictMessage;
  els.submitButton.disabled = !ready || runtime.isSubmitting;
  els.submitButton.textContent = runtime.isSubmitting ? "Submitting..." : runtime.existingSignup ? "Save Signup" : "Submit Signup";

  if (runtime.conflictMessage) {
    els.proofHint.textContent = runtime.conflictMessage;
    els.submissionStatus.textContent = "Conflict";
    els.submissionStatus.dataset.tone = "error";
  } else if (runtime.existingSignup) {
    els.proofHint.textContent = "Existing signup loaded. Account replacement will require an explicit confirmation flow.";
    els.submissionStatus.textContent = "Loaded";
    els.submissionStatus.dataset.tone = "ready";
  } else if (ready) {
    els.proofHint.textContent = "Required checks complete. Submit to save this signup.";
    els.submissionStatus.textContent = "Ready";
    els.submissionStatus.dataset.tone = "ready";
  } else if (!walletReady) {
    els.proofHint.textContent = "Verify wallet ownership before submitting.";
    els.submissionStatus.textContent = "Draft";
    els.submissionStatus.dataset.tone = "neutral";
  } else if (!requiredSocialReady) {
    els.proofHint.textContent = "Connect Telegram, Discord, or LinkedIn before submitting.";
    els.submissionStatus.textContent = "Draft";
    els.submissionStatus.dataset.tone = "neutral";
  } else {
    els.proofHint.textContent = "Verify wallet and connect one required social account before submitting.";
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

async function verifyWalletOwnership() {
  if (!runtime.account || !runtime.signer) {
    throw new Error("Connect a wallet first.");
  }

  runtime.isVerifyingWallet = true;
  syncUi();

  try {
    const challenge = await apiFetch(runtime.config, "/api/signup/challenge", {
      method: "POST",
      body: JSON.stringify({
        walletAddress: runtime.account,
        chainId: runtime.chainId
      })
    });
    const signature = await runtime.signer.signMessage(challenge.message);
    const result = await apiFetch(runtime.config, "/api/signup/wallet/verify", {
      method: "POST",
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        walletAddress: runtime.account,
        signature
      })
    });

    runtime.walletProof = {
      walletAddress: result.wallet.address,
      chainId: result.wallet.chainId,
      verifiedAt: result.wallet.verifiedAt
    };
    applyExistingSignup(result.existingSignup, "wallet");
    showMessage("Wallet ownership verified.", "success");
  } finally {
    runtime.isVerifyingWallet = false;
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

  await verifyWalletOwnership();
}

async function submitSignup() {
  if (!hasVerifiedWallet()) {
    throw new Error("Verify wallet ownership first.");
  }
  if (!hasRequiredSocialSession()) {
    throw new Error("Connect Telegram, Discord, or LinkedIn first.");
  }

  runtime.isSubmitting = true;
  syncUi();

  try {
    const headers = runtime.xSession?.csrfToken
      ? { "X-CSRF-Token": runtime.xSession.csrfToken }
      : {};
    const result = await apiFetch(runtime.config, "/api/signup/complete", {
      method: "POST",
      headers,
      body: JSON.stringify({
        walletAddress: getVerifiedWalletAddress(),
        coinMarketCapOpened: runtime.coinMarketCapOpened
      })
    });

    applyExistingSignup(result.signup, "submitted signup");
    showMessage(result.existing ? "Existing signup loaded." : `Signup received for @${result.signup.xUsername}.`, "success");
  } finally {
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
      if (!hasVerifiedWallet()) {
        await verifyWalletOwnership();
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
      syncUi();
      showMessage("Wallet disconnected.");
    } catch (error) {
      reportError(error, "Disconnect wallet");
    }
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
      await syncWalletState(runtime);
      if (previousProofAddress !== normalizeAddress(runtime.account)) {
        runtime.walletProof = null;
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
  const loaded = await loadUiConfig();
  runtime.config = loaded.config;
  renderProviderRows();
  renderFooterLinks();
  applySocialLinks();
  await loadPublicBackendConfig();
  syncXSessionFromStorage();
  bindEvents();

  try {
    const result = await completeXLoginIfPresent(runtime.config);
    runtime.xSession = result.session || runtime.xSession;
    if (runtime.xSession?.existingSignup) {
      applyExistingSignup(runtime.xSession.existingSignup, "X account");
    }
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
