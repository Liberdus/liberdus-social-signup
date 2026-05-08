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
import {
  completeDiscordLoginIfPresent,
  fetchDiscordSession,
  isDiscordAuthConfigured,
  logoutDiscordSession,
  startDiscordLogin
} from "../shared/discord-auth.js";
import {
  completeTelegramLoginIfPresent,
  fetchTelegramSession,
  isTelegramAuthConfigured,
  logoutTelegramSession,
  startTelegramLogin
} from "../shared/telegram-auth.js";
import {
  completeLinkedInLoginIfPresent,
  fetchLinkedInSession,
  isLinkedInAuthConfigured,
  logoutLinkedInSession,
  startLinkedInLogin
} from "../shared/linkedin-auth.js";

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
  isSubmitting: false,
  xSession: null,
  discordSession: null,
  telegramSession: null,
  linkedinSession: null,
  walletProof: null,
  existingSignup: null,
  conflictMessage: "",
  coinMarketCapOpened: false
};

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
  discordStatusRow: document.getElementById("discordStatusRow"),
  discordStatusText: document.getElementById("discordStatusText"),
  discordAuthButton: document.getElementById("discordAuthButton"),
  discordDisconnectButton: document.getElementById("discordDisconnectButton"),
  telegramStatusRow: document.getElementById("telegramStatusRow"),
  telegramStatusText: document.getElementById("telegramStatusText"),
  telegramAuthButton: document.getElementById("telegramAuthButton"),
  telegramDisconnectButton: document.getElementById("telegramDisconnectButton"),
  linkedinStatusRow: document.getElementById("linkedinStatusRow"),
  linkedinStatusText: document.getElementById("linkedinStatusText"),
  linkedinAuthButton: document.getElementById("linkedinAuthButton"),
  linkedinDisconnectButton: document.getElementById("linkedinDisconnectButton"),
  coinMarketCapStatusRow: document.getElementById("coinMarketCapStatusRow"),
  coinMarketCapStatusText: document.getElementById("coinMarketCapStatusText"),
  xChecklistLink: document.getElementById("xChecklistLink"),
  discordChecklistLink: document.getElementById("discordChecklistLink"),
  telegramChecklistLink: document.getElementById("telegramChecklistLink"),
  linkedinChecklistLink: document.getElementById("linkedinChecklistLink"),
  coinMarketCapLink: document.getElementById("coinMarketCapLink"),
  submitButton: document.getElementById("submitButton"),
  proofHint: document.getElementById("proofHint"),
  submissionStatus: document.getElementById("submissionStatus"),
  existingSignupPanel: document.getElementById("existingSignupPanel"),
  existingSignupText: document.getElementById("existingSignupText"),
  signupToast: document.getElementById("signupToast"),
  signupToastMessage: document.getElementById("signupToastMessage"),
  signupToastClose: document.getElementById("signupToastClose"),
  xLink: document.getElementById("xLink"),
  telegramLink: document.getElementById("telegramLink"),
  discordLink: document.getElementById("discordLink"),
  linkedinLink: document.getElementById("linkedinLink")
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

function hasVerifiedWallet() {
  return Boolean(runtime.account && getVerifiedWalletAddress() === normalizeAddress(runtime.account));
}

function hasXSession() {
  return Boolean(runtime.xSession?.profile?.username && runtime.xSession?.csrfToken);
}

function hasDiscordSession() {
  return Boolean(runtime.discordSession?.profile?.username);
}

function hasTelegramSession() {
  return Boolean(runtime.telegramSession?.profile?.id);
}

function hasLinkedInSession() {
  return Boolean(runtime.linkedinSession?.profile?.id);
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
  els.xStatusText.textContent = signedIn ? `@${profile.username}` : configured ? "Not signed in" : "X sign-in is not configured";
  els.xAuthButton.hidden = signedIn;
  els.xAuthButton.disabled = runtime.isConnectingX || !configured;
  els.xAuthButton.textContent = runtime.isConnectingX ? "Opening X..." : "Sign in with X";
  els.xDisconnectButton.hidden = !signedIn;
}

function syncOptionalRows() {
  const discordReady = hasDiscordSession();
  const discordConfigured = isDiscordAuthConfigured(runtime.config);
  const discordProfile = runtime.discordSession?.profile || null;
  const discordMembership = runtime.discordSession?.membership || null;

  els.discordStatusRow.dataset.ready = discordReady ? "true" : "false";
  if (discordReady) {
    const name = discordProfile.displayName || discordProfile.username;
    els.discordStatusText.textContent = discordMembership?.isMember
      ? `${name} connected and server membership confirmed`
      : `${name} connected; join the server to complete this optional check`;
  } else {
    els.discordStatusText.textContent = "Join the Liberdus server and connect your Discord account.";
  }
  els.discordAuthButton.hidden = discordReady;
  els.discordAuthButton.disabled = runtime.isConnectingDiscord || !discordConfigured;
  els.discordAuthButton.textContent = runtime.isConnectingDiscord ? "Opening..." : "Sign in";
  els.discordDisconnectButton.hidden = !discordReady;

  const telegramReady = hasTelegramSession();
  const telegramConfigured = isTelegramAuthConfigured(runtime.config);
  const telegramProfile = runtime.telegramSession?.profile || null;
  const telegramMembership = runtime.telegramSession?.membership || null;

  els.telegramStatusRow.dataset.ready = telegramReady ? "true" : "false";
  if (telegramReady) {
    const name = telegramProfile.username ? `@${telegramProfile.username}` : telegramProfile.displayName;
    els.telegramStatusText.textContent = telegramMembership?.isMember
      ? `${name} connected and group membership confirmed`
      : `${name} connected; join the group to complete this optional check`;
  } else if (telegramConfigured) {
    els.telegramStatusText.textContent = "Join the Liberdus Telegram and connect your account.";
  } else {
    els.telegramStatusText.textContent = "Telegram sign-in is not configured.";
  }
  els.telegramAuthButton.hidden = telegramReady;
  els.telegramAuthButton.disabled = runtime.isConnectingTelegram || !telegramConfigured;
  els.telegramAuthButton.textContent = runtime.isConnectingTelegram ? "Opening..." : "Sign in";
  els.telegramDisconnectButton.hidden = !telegramReady;

  const linkedinReady = hasLinkedInSession();
  const linkedinConfigured = isLinkedInAuthConfigured(runtime.config);
  const linkedinProfile = runtime.linkedinSession?.profile || null;

  els.linkedinStatusRow.dataset.ready = linkedinReady ? "true" : "false";
  if (linkedinReady) {
    els.linkedinStatusText.textContent = `${linkedinProfile.displayName || linkedinProfile.name || "LinkedIn account"} connected`;
  } else if (linkedinConfigured) {
    els.linkedinStatusText.textContent = "Follow Liberdus on LinkedIn and connect your account.";
  } else {
    els.linkedinStatusText.textContent = "LinkedIn sign-in is not configured.";
  }
  els.linkedinAuthButton.hidden = linkedinReady;
  els.linkedinAuthButton.disabled = runtime.isConnectingLinkedIn || !linkedinConfigured;
  els.linkedinAuthButton.textContent = runtime.isConnectingLinkedIn ? "Opening..." : "Sign in";
  els.linkedinDisconnectButton.hidden = !linkedinReady;

  els.coinMarketCapStatusRow.dataset.ready = runtime.coinMarketCapOpened ? "true" : "false";
  if (runtime.coinMarketCapOpened) {
    els.coinMarketCapStatusText.textContent = "Opened this session.";
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
  const xReady = hasXSession();
  const ready = walletReady && xReady && !runtime.conflictMessage;
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
  } else {
    els.proofHint.textContent = "Connect wallet and X before submitting.";
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
  if (!runtime.xSession?.csrfToken) {
    throw new Error("Sign in with X first.");
  }

  runtime.isSubmitting = true;
  syncUi();

  try {
    const result = await apiFetch(runtime.config, "/api/signup/complete", {
      method: "POST",
      headers: { "X-CSRF-Token": runtime.xSession.csrfToken },
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
  setHref(els.telegramLink, links.telegram);
  setHref(els.telegramChecklistLink, links.telegram);
  setHref(els.discordLink, links.discord);
  setHref(els.discordChecklistLink, links.discord);
  setHref(els.linkedinLink, links.linkedin);
  setHref(els.linkedinChecklistLink, links.linkedin);
  setHref(els.coinMarketCapLink, links.coinMarketCap || links.cmc);
}

async function loadPublicBackendConfig() {
  try {
    const publicConfig = await apiFetch(runtime.config, "/api/public/config");
    runtime.config.socialLinks = {
      ...(runtime.config.socialLinks || {}),
      ...(publicConfig.socialLinks || {})
    };
    runtime.config.telegramAuth = {
      ...(runtime.config.telegramAuth || {}),
      ...(publicConfig.telegramAuth || {})
    };
    runtime.config.linkedinAuth = {
      ...(runtime.config.linkedinAuth || {}),
      ...(publicConfig.linkedinAuth || {})
    };
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

  els.discordAuthButton.addEventListener("click", async () => {
    try {
      runtime.isConnectingDiscord = true;
      syncUi();
      await startDiscordLogin(runtime.config);
    } catch (error) {
      runtime.isConnectingDiscord = false;
      syncUi();
      reportError(error, "Start Discord sign-in");
    }
  });

  els.discordDisconnectButton.addEventListener("click", async () => {
    try {
      await logoutDiscordSession(runtime.config);
      runtime.discordSession = null;
      syncUi();
      showMessage("Discord account disconnected.");
    } catch (error) {
      reportError(error, "Disconnect Discord");
    }
  });

  els.telegramAuthButton.addEventListener("click", async () => {
    try {
      runtime.isConnectingTelegram = true;
      syncUi();
      runtime.telegramSession = await startTelegramLogin(runtime.config);
      showMessage("Telegram account connected.", "success");
    } catch (error) {
      reportError(error, "Start Telegram sign-in");
    } finally {
      runtime.isConnectingTelegram = false;
      syncUi();
    }
  });

  els.telegramDisconnectButton.addEventListener("click", async () => {
    try {
      await logoutTelegramSession(runtime.config);
      runtime.telegramSession = null;
      syncUi();
      showMessage("Telegram account disconnected.");
    } catch (error) {
      reportError(error, "Disconnect Telegram");
    }
  });

  els.linkedinAuthButton.addEventListener("click", async () => {
    try {
      runtime.isConnectingLinkedIn = true;
      syncUi();
      await startLinkedInLogin(runtime.config);
    } catch (error) {
      runtime.isConnectingLinkedIn = false;
      syncUi();
      reportError(error, "Start LinkedIn sign-in");
    }
  });

  els.linkedinDisconnectButton.addEventListener("click", async () => {
    try {
      await logoutLinkedInSession(runtime.config);
      runtime.linkedinSession = null;
      syncUi();
      showMessage("LinkedIn account disconnected.");
    } catch (error) {
      reportError(error, "Disconnect LinkedIn");
    }
  });

  els.submitButton.addEventListener("click", () => {
    submitSignup().catch((error) => reportError(error, "Submit signup"));
  });

  els.coinMarketCapLink.addEventListener("click", () => {
    runtime.coinMarketCapOpened = true;
    syncUi();
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

  try {
    const result = await completeDiscordLoginIfPresent(runtime.config);
    runtime.discordSession = result.session || runtime.discordSession;
    if (result.handled && runtime.discordSession) {
      showMessage("Discord account connected.", "success");
    }
  } catch (error) {
    runtime.discordSession = null;
    reportError(error, "Complete Discord sign-in");
  }

  if (!runtime.discordSession) {
    runtime.discordSession = await fetchDiscordSession(runtime.config).catch(() => null);
  }

  try {
    const result = await completeTelegramLoginIfPresent(runtime.config);
    runtime.telegramSession = result.session || runtime.telegramSession;
    if (result.handled && runtime.telegramSession) {
      showMessage("Telegram account connected.", "success");
    }
  } catch (error) {
    runtime.telegramSession = null;
    reportError(error, "Complete Telegram sign-in");
  }

  if (!runtime.telegramSession) {
    runtime.telegramSession = await fetchTelegramSession(runtime.config).catch(() => null);
  }

  try {
    const result = await completeLinkedInLoginIfPresent(runtime.config);
    runtime.linkedinSession = result.session || runtime.linkedinSession;
    if (result.handled && runtime.linkedinSession) {
      showMessage("LinkedIn account connected.", "success");
    }
  } catch (error) {
    runtime.linkedinSession = null;
    reportError(error, "Complete LinkedIn sign-in");
  }

  if (!runtime.linkedinSession) {
    runtime.linkedinSession = await fetchLinkedInSession(runtime.config).catch(() => null);
  }

  await syncWalletState(runtime).catch(() => null);
  syncUi();
}

init().catch((error) => reportError(error, "Initialize"));
