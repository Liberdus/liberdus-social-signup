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
  isAuthRedirecting: false,
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
  xTaskList: document.querySelector('[aria-label="X tasks"]'),
  optionalChecklist: document.getElementById("optionalChecklist"),
  xChecklistLink: document.getElementById("xChecklistLink"),
  submitButton: document.getElementById("submitButton"),
  profileTaskText: document.getElementById("profileTaskText"),
  profileBarFill: document.getElementById("profileBarFill"),
  profileGateText: document.getElementById("profileGateText"),
  minimumWallet: document.getElementById("minimumWallet"),
  minimumSocial: document.getElementById("minimumSocial"),
  minimumSubmit: document.getElementById("minimumSubmit"),
  walletConnectTaskRow: document.getElementById("walletConnectTaskRow"),
  walletConnectTaskTitle: document.getElementById("walletConnectTaskTitle"),
  walletConnectTaskDetail: document.getElementById("walletConnectTaskDetail"),
  walletSignTaskRow: document.getElementById("walletSignTaskRow"),
  walletSignTaskTitle: document.getElementById("walletSignTaskTitle"),
  walletSignTaskDetail: document.getElementById("walletSignTaskDetail"),
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

const PROVIDER_MARKS = {
  discord: "D",
  telegram: "T",
  linkedin: "in",
  github: "GH",
  youtube: "YT",
  coinMarketCap: "CMC"
};

const STATUS_TEXT = {
  wallet: "Connect and sign with your wallet.",
  x: "Follow @Liberdus on X.com.",
  discord: "Join the Liberdus Discord.",
  telegram: "Join the Liberdus group on Telegram.",
  linkedin: "Follow Liberdus on LinkedIn.",
  github: "Star and follow Liberdus on GitHub.",
  youtube: "Subscribe to Liberdus on YouTube.",
  coinMarketCap: "Follow Liberdus on CoinMarketCap."
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

function hasPendingWalletReplacement() {
  return Boolean(
    runtime.existingSignup?.walletAddress
    && runtime.account
    && !isExistingSignupForCurrentWallet()
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

function setActionLinkDisabled(anchor, disabled) {
  if (!anchor) return;
  anchor.setAttribute("aria-disabled", disabled ? "true" : "false");
  anchor.tabIndex = disabled ? -1 : 0;
}

function setTaskState(element, state) {
  if (!element) return;
  element.dataset.state = state || "pending";
}

function setStatusNote(element, message = "", tone = "info") {
  if (!element) return;
  const hasMessage = Boolean(String(message || "").trim());
  element.hidden = !hasMessage;
  element.textContent = hasMessage ? message : "";
  element.dataset.tone = tone;
}

function syncChecklistPill(row, isComplete) {
  const pill = row?.querySelector(".required-pill, .choice-pill, .optional-pill");
  if (!pill) return;
  if (!pill.dataset.defaultLabel) {
    pill.dataset.defaultLabel = pill.textContent;
  }
  if (isComplete) {
    pill.dataset.state = "done";
    pill.textContent = "Complete";
    return;
  }
  delete pill.dataset.state;
  pill.textContent = pill.dataset.defaultLabel;
}

function setTaskControlLabel(button, label) {
  if (!button) return;
  button.dataset.icon = "";
  button.classList.remove("task-icon-button");
  delete button.dataset.state;
  button.textContent = label;
  button.removeAttribute("aria-label");
  button.removeAttribute("title");
}

function configureTaskAction(action, { label, hidden = false, disabled = false, icon = "" } = {}) {
  if (!action) return null;
  action.hidden = hidden;
  action.disabled = disabled;
  action.dataset.icon = icon;
  action.classList.toggle("task-icon-button", Boolean(icon));
  action.textContent = icon ? "" : label;
  if (icon) {
    action.setAttribute("aria-label", label);
    action.title = label;
  } else {
    action.removeAttribute("aria-label");
    action.removeAttribute("title");
  }
  return action;
}

function createTaskRow({ label, detail = "", state = "pending", actions = [], actionOnly = false, inlineActions = false }) {
  const row = document.createElement("div");
  row.className = "task-row";
  row.dataset.state = state;
  row.classList.toggle("task-row-action-only", actionOnly);
  row.classList.toggle("task-row-inline-actions", inlineActions);

  const check = document.createElement("span");
  check.className = "task-check";
  check.setAttribute("aria-hidden", "true");

  const copy = document.createElement("span");
  copy.className = "task-row-copy";

  const actionGroup = document.createElement("span");
  actionGroup.className = "task-row-actions";
  actionGroup.append(...actions.filter(Boolean));

  if (actionOnly) {
    actionGroup.classList.add("task-row-primary-actions");
    copy.append(actionGroup);
    row.append(check, copy);
    return row;
  }

  const titleLine = document.createElement("span");
  titleLine.className = "task-row-title-line";
  const title = document.createElement("span");
  title.className = "task-row-title";
  title.textContent = label;
  titleLine.append(title);

  if (inlineActions) {
    actionGroup.classList.add("task-row-inline-action-group");
    titleLine.append(actionGroup);
  }

  copy.append(titleLine);
  if (detail) {
    const detailElement = document.createElement("span");
    detailElement.className = "task-row-detail";
    detailElement.textContent = detail;
    copy.append(detailElement);
  }

  row.append(check, copy);
  if (!inlineActions) row.append(actionGroup);
  return row;
}

function createProviderLink(provider, link) {
  const anchor = document.createElement("a");
  anchor.className = "task-control task-link";
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

    const mark = document.createElement("span");
    mark.className = `provider-mark provider-mark-${provider.id}`;
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = PROVIDER_MARKS[provider.id] || provider.title.slice(0, 2);

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
    statusText.className = "status-note";
    statusText.hidden = true;

    const taskList = document.createElement("div");
    taskList.className = "task-list";
    taskList.setAttribute("aria-label", `${provider.title} tasks`);

    titleRow.append(title, optional);
    copy.append(titleRow, statusText, taskList);

    const links = (provider.links || []).map((link) => createProviderLink(provider, link));

    let authButton = null;
    let verifyButton = null;
    if (provider.start) {
      authButton = document.createElement("button");
      authButton.id = `${provider.id}AuthButton`;
      authButton.type = "button";
      authButton.className = "task-control";
      authButton.textContent = "Sign in";
      authButton.disabled = true;
    }
    if (provider.id === "github" || provider.id === "youtube") {
      verifyButton = document.createElement("button");
      verifyButton.id = `${provider.id}VerifyButton`;
      verifyButton.type = "button";
      verifyButton.className = "task-control task-icon-button";
      verifyButton.dataset.icon = "refresh";
      verifyButton.setAttribute("aria-label", `Recheck ${provider.title}`);
      verifyButton.title = `Recheck ${provider.title}`;
      verifyButton.hidden = true;
      verifyButton.disabled = true;
    }

    providerElements.set(provider.id, {
      row,
      statusText,
      taskList,
      links,
      authButton,
      verifyButton
    });
    row.append(mark, copy);
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

function getPendingWalletReplacement() {
  if (!hasPendingWalletReplacement()) return null;
  const oldWalletAddress = normalizeAddress(runtime.existingSignup.walletAddress);
  const newWalletAddress = normalizeAddress(runtime.account);
  return {
    accountType: "wallet",
    provider: "wallet",
    providerLabel: "Wallet",
    oldProviderUserId: oldWalletAddress,
    newProviderUserId: newWalletAddress,
    oldLabel: formatAddressShort(oldWalletAddress),
    newLabel: formatAddressShort(newWalletAddress)
  };
}

function getPendingReplacements() {
  return [
    getPendingWalletReplacement(),
    ...getPendingSocialReplacements()
  ].filter(Boolean);
}

function hasUnsavedSocialChanges() {
  if (!runtime.existingSignup?.id) return false;
  const providerIds = ["x", ...checklistProviders.map((provider) => provider.id)];
  for (const providerId of providerIds) {
    const currentAccount = getCurrentSocialAccount(providerId);
    if (!currentAccount?.providerUserId) continue;
    const savedAccount = getSavedSocialAccount(providerId);
    if (!savedAccount?.providerUserId || savedAccount.providerUserId !== currentAccount.providerUserId) {
      return true;
    }
  }

  const githubAccount = getSavedSocialAccount("github");
  if (runtime.githubSession?.star?.starred && !hasPassedSavedVerification(githubAccount, "github_repo_starred")) {
    return true;
  }

  const youtubeAccount = getSavedSocialAccount("youtube");
  if (runtime.youtubeSession?.subscription?.subscribed && !hasPassedSavedVerification(youtubeAccount, "youtube_channel_subscribed")) {
    return true;
  }

  if (runtime.coinMarketCapOpened && !runtime.existingSignup?.verification?.coinMarketCap?.opened) {
    return true;
  }

  return false;
}

function hasUnsavedSignupChanges() {
  if (!runtime.existingSignup?.id) return false;
  return hasPendingWalletReplacement() || hasUnsavedSocialChanges();
}

function hasUnsavedNewSignupProgress() {
  if (runtime.existingSignup?.id) return false;
  return getProfileCompletionTasks().some((task) => task.id !== "wallet" && task.done);
}

function shouldWarnBeforeUnload() {
  if (runtime.isSubmitting || runtime.isAuthRedirecting) return false;
  return hasUnsavedSignupChanges() || hasUnsavedNewSignupProgress();
}

function confirmPendingReplacements() {
  const replacements = getPendingReplacements();
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

function getProviderStatusNote(provider, { session, configured }) {
  if (provider.start && !configured) {
    return { message: `${provider.title} sign-in is not configured.`, tone: "warning" };
  }
  if (provider.id === "github" && session?.profile?.id && session?.star?.error) {
    return { message: "GitHub star check is unavailable right now.", tone: "warning" };
  }
  if (provider.id === "youtube" && session?.profile?.id && session?.subscription?.error) {
    return { message: "YouTube subscription check is unavailable right now.", tone: "warning" };
  }
  return { message: STATUS_TEXT[provider.id] || "", tone: "info" };
}

function getProviderIdentityLabel(provider, { session, savedAccount }) {
  if (session?.profile?.id) {
    const current = getCurrentSocialAccount(provider.id);
    return current?.label || provider.title;
  }
  if (savedAccount?.providerUserId) {
    return getSavedAccountName(savedAccount, provider.title);
  }
  return "";
}

function getProviderTaskStates(provider, { session, savedAccount }) {
  const connected = Boolean(session?.profile?.id || savedAccount?.providerUserId);

  if (provider.id === "discord") {
    return {
      connected,
      linkDone: Boolean(session?.membership?.isMember || hasPassedSavedVerification(savedAccount, "discord_guild_member"))
    };
  }

  if (provider.id === "telegram") {
    return {
      connected,
      linkDone: Boolean(session?.membership?.isMember || hasPassedSavedVerification(savedAccount, "telegram_group_member"))
    };
  }

  if (provider.id === "linkedin") {
    return { connected, linkDone: false };
  }

  if (provider.id === "github") {
    return {
      connected,
      linkDone: Boolean(session?.star?.starred || hasPassedSavedVerification(savedAccount, "github_repo_starred"))
    };
  }

  if (provider.id === "youtube") {
    return {
      connected,
      linkDone: Boolean(session?.subscription?.subscribed || hasPassedSavedVerification(savedAccount, "youtube_channel_subscribed"))
    };
  }

  if (provider.id === "coinMarketCap") {
    return { connected: Boolean(runtime.coinMarketCapOpened), linkDone: Boolean(runtime.coinMarketCapOpened) };
  }

  return { connected, linkDone: false };
}

function syncProviderTaskControls(provider, elements, { session, savedAccount, configured, connecting }) {
  const states = getProviderTaskStates(provider, { session, savedAccount });
  const identityLabel = getProviderIdentityLabel(provider, { session, savedAccount });
  const nodes = [];
  const hasIdentity = Boolean(states.connected);

  if (provider.start && elements.authButton) {
    const authAction = configureTaskAction(elements.authButton, {
      label: hasIdentity ? `Change ${provider.title} account` : connecting ? "Opening..." : "Sign in",
      icon: hasIdentity ? "edit" : "",
      disabled: !hasConnectedWallet() || connecting || !configured
    });
    nodes.push(createTaskRow({
      label: hasIdentity ? "Signed in" : "Sign in",
      detail: hasIdentity ? identityLabel : "",
      state: hasIdentity ? "done" : "pending",
      actions: [authAction],
      actionOnly: !hasIdentity,
      inlineActions: hasIdentity
    }));
  }

  for (const link of elements.links || []) {
    const linkState = states.linkDone ? "done" : link.dataset.tracksClick === "true" ? "pending" : "manual";
    link.dataset.state = linkState;
    link.classList.toggle("is-complete", linkState === "done");
    const linkAction = link;
    nodes.push(createTaskRow({
      label: states.linkDone ? `${link.textContent} complete` : link.textContent,
      state: linkState,
      actions: states.linkDone ? [] : [linkAction],
      actionOnly: !states.linkDone
    }));
  }

  if (elements.verifyButton) {
    const canRecheck = Boolean(session?.profile?.id);
    const verifyAction = configureTaskAction(elements.verifyButton, {
      label: `Recheck ${provider.title}`,
      icon: "refresh",
      hidden: !canRecheck,
      disabled: !hasConnectedWallet() || connecting || !configured || !canRecheck
    });
    if (canRecheck) {
      const verifyDone = provider.id === "github"
        ? states.linkDone
        : provider.id === "youtube"
          ? states.linkDone
          : false;
      nodes.push(createTaskRow({
        label: "Recheck",
        state: verifyDone ? "done" : "pending",
        actions: [verifyAction],
        actionOnly: true
      }));
    }
  }

  elements.taskList.replaceChildren(...nodes);
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
  const walletReplacementPending = hasPendingWalletReplacement();
  const hasWalletProof = Boolean(runtime.walletProof);

  if (runtime.isConnectingWallet) {
    setTaskControlLabel(els.connectButton, "Connecting...");
  } else if (!hasWallet) {
    setTaskControlLabel(els.connectButton, "Connect Wallet");
  } else {
    configureTaskAction(els.connectButton, {
      label: `Wallet options for ${formatAddressShort(runtime.account)}`,
      icon: "edit"
    });
  }

  els.connectButton.disabled = runtime.isConnectingWallet || runtime.isSubmitting;
  els.loadSignupButton.hidden = hasWalletProof;
  els.loadSignupButton.disabled = !hasWallet || runtime.isLoadingSignup || runtime.isSubmitting;
  els.loadSignupButton.dataset.state = hasWalletProof ? "done" : "pending";
  els.loadSignupButton.textContent = runtime.isLoadingSignup
    ? "Signing..."
    : "Sign wallet";
  setTaskState(els.walletConnectTaskRow, hasWallet ? "done" : "pending");
  setTaskState(els.walletSignTaskRow, hasWalletProof ? "done" : "pending");
  els.walletConnectTaskRow.classList.toggle("task-row-action-only", !hasWallet);
  els.walletConnectTaskRow.classList.toggle("task-row-inline-actions", hasWallet);
  els.walletSignTaskRow.classList.toggle("task-row-action-only", !hasWalletProof);
  els.walletSignTaskRow.classList.toggle("task-row-inline-actions", false);
  els.walletConnectTaskTitle.textContent = "Connected wallet";
  els.walletSignTaskTitle.textContent = hasWalletProof ? "Signed wallet" : "Sign wallet";
  els.walletConnectTaskDetail.textContent = hasWallet ? formatAddressShort(runtime.account) : "";
  els.walletSignTaskDetail.textContent = hasWalletProof ? "Saved signup loaded." : "Loads saved signup.";
  els.walletMenuAddress.textContent = hasWallet ? formatAddressShort(runtime.account) : "-";
  els.walletMenuAddress.title = runtime.account || "";
  els.walletMenuChainId.textContent = runtime.chainName || (runtime.chainId ? String(runtime.chainId) : "-");
  els.walletStatusRow.dataset.ready = hasWalletProof ? "true" : "false";
  syncChecklistPill(els.walletStatusRow, hasWalletProof);
  setStatusNote(
    els.walletStatusText,
    walletReplacementPending
      ? `This update will replace saved wallet ${formatAddressShort(runtime.existingSignup.walletAddress)}.`
      : STATUS_TEXT.wallet,
    walletReplacementPending ? "warning" : "info"
  );

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
  syncChecklistPill(els.xStatusRow, ready);
  setStatusNote(
    els.xStatusText,
    configured ? STATUS_TEXT.x : "X sign-in is not configured.",
    configured ? "info" : "warning"
  );

  const xTaskNodes = [];
  const xAuthAction = configureTaskAction(els.xAuthButton, {
    label: ready ? "Change X account" : runtime.isConnectingX ? "Opening..." : "Sign in",
    icon: ready ? "edit" : "",
    disabled: !walletReady || runtime.isConnectingX || !configured
  });
  if (ready) {
    const label = signedIn
      ? `@${profile.username}`
      : getSavedAccountName(savedAccount, "X");
    xTaskNodes.push(createTaskRow({
      label: "Signed in",
      detail: label,
      state: "done",
      actions: [xAuthAction],
      inlineActions: true
    }));
  } else {
    xTaskNodes.push(createTaskRow({
      label: "Sign in",
      state: "pending",
      actions: [xAuthAction],
      actionOnly: true
    }));
  }

  els.xChecklistLink.dataset.state = "manual";
  xTaskNodes.push(createTaskRow({
    label: "Follow Liberdus",
    state: "manual",
    actions: [els.xChecklistLink],
    actionOnly: true
  }));
  els.xTaskList.replaceChildren(...xTaskNodes);

  els.xAuthButton.hidden = false;
  els.xDisconnectButton.hidden = true;
  els.xDisconnectButton.disabled = true;
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
    syncChecklistPill(elements.row, ready);
    const statusNote = getProviderStatusNote(provider, {
      session,
      configured,
      config: runtime.config
    });
    setStatusNote(elements.statusText, statusNote.message, statusNote.tone);

    updateProviderLinks(provider, elements);
    syncProviderTaskControls(provider, elements, {
      session,
      savedAccount,
      configured,
      connecting
    });
  }
}

function getProfileCompletionTasks() {
  const discordAccount = getSavedSocialAccount("discord");
  const telegramAccount = getSavedSocialAccount("telegram");
  const linkedinAccount = getSavedSocialAccount("linkedin");
  const githubAccount = getSavedSocialAccount("github");
  const youtubeAccount = getSavedSocialAccount("youtube");
  const cmcOpened = Boolean(runtime.coinMarketCapOpened || runtime.existingSignup?.verification?.coinMarketCap?.opened);

  return [
    { id: "wallet", done: hasConnectedWallet() },
    { id: "xSignin", done: Boolean(runtime.xSession?.profile?.id || getSavedSocialAccount("x")) },
    { id: "discordSignin", done: Boolean(runtime.discordSession?.profile?.id || discordAccount) },
    { id: "discordJoin", done: Boolean(runtime.discordSession?.membership?.isMember || hasPassedSavedVerification(discordAccount, "discord_guild_member")) },
    { id: "telegramSignin", done: Boolean(runtime.telegramSession?.profile?.id || telegramAccount) },
    { id: "telegramJoin", done: Boolean(runtime.telegramSession?.membership?.isMember || hasPassedSavedVerification(telegramAccount, "telegram_group_member")) },
    { id: "linkedinSignin", done: Boolean(runtime.linkedinSession?.profile?.id || linkedinAccount) },
    { id: "githubSignin", done: Boolean(runtime.githubSession?.profile?.id || githubAccount) },
    { id: "githubStar", done: Boolean(runtime.githubSession?.star?.starred || hasPassedSavedVerification(githubAccount, "github_repo_starred")) },
    { id: "youtubeSignin", done: Boolean(runtime.youtubeSession?.profile?.id || youtubeAccount) },
    { id: "youtubeSubscribe", done: Boolean(runtime.youtubeSession?.subscription?.subscribed || hasPassedSavedVerification(youtubeAccount, "youtube_channel_subscribed")) },
    { id: "coinMarketCap", done: cmcOpened }
  ];
}

function syncProfileMeter({ ready, walletReady, requiredSocialReady, savedCurrent }) {
  const tasks = getProfileCompletionTasks();
  const completeCount = tasks.filter((task) => task.done).length;
  const totalCount = tasks.length || 1;
  const percent = Math.round((completeCount / totalCount) * 100);
  els.profileTaskText.textContent = walletReady ? `${completeCount}/${totalCount} tasks complete` : "";
  els.profileBarFill.style.width = walletReady ? `${percent}%` : "0%";

  if (runtime.conflictMessage) {
    els.profileGateText.textContent = "Resolve the account conflict before updating.";
  } else if (ready) {
    els.profileGateText.textContent = "Minimum complete. More tasks may strengthen future reward eligibility.";
  } else if (!walletReady) {
    els.profileGateText.textContent = "Connect a wallet to start your reward profile.";
  } else if (!requiredSocialReady) {
    els.profileGateText.textContent = "Connect at least one required social account to submit.";
  } else {
    els.profileGateText.textContent = "Finish the required tasks, then submit and sign.";
  }

  setTaskState(els.minimumWallet, walletReady ? "done" : "pending");
  setTaskState(els.minimumSocial, requiredSocialReady ? "done" : "pending");
  setTaskState(els.minimumSubmit, runtime.conflictMessage ? "error" : savedCurrent ? "done" : ready ? "ready" : "pending");
}

function syncChecklistLockUi() {
  const walletReady = hasConnectedWallet();
  els.xStatusRow.hidden = !walletReady;
  els.optionalChecklist.hidden = !walletReady;
}

function syncSubmitUi() {
  const walletReady = hasConnectedWallet();
  const requiredSocialReady = hasRequiredSocialSession();
  const ready = walletReady && requiredSocialReady && !runtime.conflictMessage;
  const savedCurrent = Boolean(runtime.existingSignup?.id && !hasUnsavedSignupChanges());
  els.submitButton.disabled = !ready || runtime.isSubmitting;
  els.submitButton.textContent = runtime.isSubmitting ? "Signing..." : runtime.existingSignup ? "Update & Sign" : "Submit & Sign";

  syncProfileMeter({ ready, walletReady, requiredSocialReady, savedCurrent });
}

function syncUi() {
  syncChecklistLockUi();
  syncWalletUi();
  syncXUi();
  syncOptionalRows();
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

  const confirmedReplacements = confirmPendingReplacements();
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
  window.addEventListener("beforeunload", (event) => {
    if (!shouldWarnBeforeUnload()) return;
    event.preventDefault();
    event.returnValue = "";
  });

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
    loadExistingSignupForWallet().catch((error) => reportError(error, "Sign wallet"));
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
    let startedRedirect = false;
    try {
      runtime.isConnectingX = true;
      syncUi();
      if (runtime.xSession) {
        await logoutXSession(runtime.config, runtime.xSession);
        runtime.xSession = null;
        clearXSession();
      }
      runtime.isAuthRedirecting = true;
      await startXLogin(runtime.config);
      startedRedirect = true;
    } catch (error) {
      runtime.isConnectingX = false;
      runtime.isAuthRedirecting = false;
      syncUi();
      reportError(error, "Start X sign-in");
    } finally {
      if (!startedRedirect) {
        runtime.isAuthRedirecting = false;
      }
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
        let startedRedirect = false;
        try {
          if (provider.connectingKey) runtime[provider.connectingKey] = true;
          syncUi();
          const session = provider.sessionKey ? runtime[provider.sessionKey] : null;
          if (session?.profile?.id && provider.disconnect) {
            await provider.disconnect({ runtime });
            runtime[provider.sessionKey] = null;
            syncUi();
          }
          runtime.isAuthRedirecting = true;
          const result = await provider.start({ runtime, syncUi, showMessage });
          startedRedirect = Boolean(result?.redirecting);
          if (startedRedirect) return;
        } catch (error) {
          reportError(error, `Start ${provider.title} sign-in`);
        } finally {
          if (!startedRedirect) {
            runtime.isAuthRedirecting = false;
          }
          if (provider.connectingKey) runtime[provider.connectingKey] = false;
          syncUi();
        }
      });
    }

    if (elements?.verifyButton && provider.start) {
      elements.verifyButton.addEventListener("click", async () => {
        let startedRedirect = false;
        try {
          if (provider.connectingKey) runtime[provider.connectingKey] = true;
          syncUi();
          runtime.isAuthRedirecting = true;
          const result = await provider.start({ runtime, syncUi, showMessage });
          startedRedirect = Boolean(result?.redirecting);
          if (startedRedirect) return;
        } catch (error) {
          reportError(error, `Recheck ${provider.title}`);
        } finally {
          if (!startedRedirect) {
            runtime.isAuthRedirecting = false;
          }
          if (provider.connectingKey) runtime[provider.connectingKey] = false;
          syncUi();
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
        runtime.conflictMessage = "";
      }
      if (previousAccount && nextAccount && previousAccount !== nextAccount) {
        showMessage(hadLoadedSignup
          ? `Wallet changed to ${formatAddressShort(nextAccount)}. Submit and sign to replace the saved wallet.`
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
