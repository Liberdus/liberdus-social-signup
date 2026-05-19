import { loadUiConfig } from "../shared/config.js";
import { apiFetch } from "../shared/api.js";
import { createToastController } from "../shared/toast.js";
import { formatAddressShort, formatDateTime } from "../shared/format.js";

const ADMIN_TOKEN_KEY = "liberdus-social-signup-admin-token";
const PROVIDER_LABELS = {
  x: "X",
  discord: "Discord",
  telegram: "Telegram",
  linkedin: "LinkedIn",
  github: "GitHub",
  youtube: "YouTube",
  coinmarketcap: "CMC"
};
const CHECK_DEFINITIONS = [
  {
    provider: "x",
    checkType: "x_verified",
    label: "X verification badge",
    passedLabel: "Verified",
    failedLabel: "Not verified",
    unknownLabel: "Could not verify"
  },
  {
    provider: "discord",
    checkType: "discord_guild_member",
    label: "Discord server",
    passedLabel: "Joined",
    failedLabel: "Not joined",
    unknownLabel: "Could not verify"
  },
  {
    provider: "telegram",
    checkType: "telegram_group_member",
    label: "Telegram group",
    passedLabel: "Joined",
    failedLabel: "Not joined",
    unknownLabel: "Could not verify"
  },
  {
    provider: "github",
    checkType: "github_repo_starred",
    label: "GitHub repo",
    passedLabel: "Starred",
    failedLabel: "Not starred",
    unknownLabel: "Could not verify"
  },
  {
    provider: "youtube",
    checkType: "youtube_channel_subscribed",
    label: "YouTube",
    passedLabel: "Subscribed",
    failedLabel: "Not subscribed",
    unknownLabel: "Could not verify"
  }
];
const MANUAL_CLAIM_LABELS = {
  x_follow_manual: "X follow",
  linkedin_follow_manual: "LinkedIn follow",
  coinmarketcap_follow_manual: "CMC follow"
};
const CHECK_DEFINITION_BY_TYPE = Object.fromEntries(CHECK_DEFINITIONS.map((definition) => [definition.checkType, definition]));

const runtime = {
  config: {},
  adminToken: window.sessionStorage.getItem(ADMIN_TOKEN_KEY) || "",
  limit: 50,
  offset: 0,
  search: ""
};

const els = {
  loginPanel: document.getElementById("loginPanel"),
  adminPanel: document.getElementById("adminPanel"),
  loginForm: document.getElementById("loginForm"),
  usernameInput: document.getElementById("usernameInput"),
  passwordInput: document.getElementById("passwordInput"),
  logoutButton: document.getElementById("logoutButton"),
  refreshButton: document.getElementById("refreshButton"),
  exportButton: document.getElementById("exportButton"),
  filterForm: document.getElementById("filterForm"),
  searchInput: document.getElementById("searchInput"),
  providerFilter: document.getElementById("providerFilter"),
  checkTypeFilter: document.getElementById("checkTypeFilter"),
  checkStatusFilter: document.getElementById("checkStatusFilter"),
  manualClaimFilter: document.getElementById("manualClaimFilter"),
  changedFilter: document.getElementById("changedFilter"),
  statusFilter: document.getElementById("statusFilter"),
  submittedFromInput: document.getElementById("submittedFromInput"),
  submittedToInput: document.getElementById("submittedToInput"),
  clearSearchButton: document.getElementById("clearSearchButton"),
  pageSizeSelect: document.getElementById("pageSizeSelect"),
  summaryText: document.getElementById("summaryText"),
  submissionsBody: document.getElementById("submissionsBody"),
  adminToast: document.getElementById("adminToast"),
  adminToastMessage: document.getElementById("adminToastMessage"),
  adminToastClose: document.getElementById("adminToastClose")
};

const toast = createToastController({
  element: els.adminToast,
  messageElement: els.adminToastMessage,
  closeButton: els.adminToastClose
});

function showMessage(message, tone = "info") {
  toast.show(message, tone);
}

function reportError(error, context) {
  console.error(`[${context}]`, error);
  showMessage(`${context}: ${error?.message || error}`, "error");
}

function getAdminHeaders() {
  return runtime.adminToken ? { "X-Admin-Token": runtime.adminToken } : {};
}

function syncAuthUi() {
  const authed = Boolean(runtime.adminToken);
  els.loginPanel.hidden = authed;
  els.adminPanel.hidden = !authed;
  els.logoutButton.hidden = !authed;
}

function appendCell(row, ...children) {
  const cell = document.createElement("td");
  cell.append(...children);
  row.append(cell);
  return cell;
}

function createText(value) {
  return document.createTextNode(String(value ?? ""));
}

function createCode(value, title = "") {
  const code = document.createElement("code");
  code.textContent = String(value ?? "");
  if (title) code.title = title;
  return code;
}

function createEmptyRow(message) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 5;
  cell.className = "empty-row";
  cell.textContent = message;
  row.append(cell);
  return row;
}

function getSocialAccount(signup, provider) {
  const account = (signup.socialAccounts || []).find((candidate) => candidate.provider === provider);
  if (account) return account;
  if (provider === "x" && signup.xUserId) {
    return {
      provider: "x",
      providerUserId: signup.xUserId,
      username: signup.xUsername || "",
      displayName: signup.xName || signup.xUsername || "",
      profileUrl: signup.xUsername ? `https://x.com/${signup.xUsername}` : "",
      verifications: []
    };
  }
  return null;
}

function getCoinMarketCapClaim(signup) {
  const coinMarketCap = signup.verification?.coinMarketCap;
  if (!coinMarketCap?.followClaim?.claimed && !coinMarketCap?.opened) return null;
  return {
    checkType: "coinmarketcap_follow_manual",
    status: "claimed",
    checkedAt: coinMarketCap.followClaim?.claimedAt || signup.updatedAt || signup.submittedAt
  };
}

function getAllVerifications(signup) {
  const verifications = (signup.socialAccounts || []).flatMap((account) => account.verifications || []);
  const coinMarketCapClaim = getCoinMarketCapClaim(signup);
  return coinMarketCapClaim ? [...verifications, coinMarketCapClaim] : verifications;
}

function getAccountLabel(account) {
  return account?.username || account?.displayName || account?.providerUserId || "";
}

function getDisplayAccountLabel(account) {
  const label = getAccountLabel(account);
  if (!label) return "";
  if ((account.provider === "x" || account.provider === "telegram") && !label.startsWith("@")) return `@${label}`;
  return label;
}

function createBadge(label, tone = "neutral", title = "") {
  const badge = document.createElement("span");
  badge.className = "admin-badge";
  badge.dataset.tone = tone;
  badge.textContent = label;
  if (title) badge.title = title;
  return badge;
}

function createStack(items, emptyText = "-") {
  const stack = document.createElement("div");
  stack.className = "admin-cell-stack";
  if (!items.length) {
    stack.textContent = emptyText;
    stack.classList.add("admin-cell-empty");
    return stack;
  }
  stack.append(...items);
  return stack;
}

function getStatusTone(status) {
  return ({
    passed: "positive",
    failed: "warning",
    claimed: "claimed",
    unknown: "muted",
    missing: "muted"
  })[status] || "neutral";
}

function createAccountChip(account) {
  const chip = document.createElement(account.profileUrl ? "a" : "span");
  chip.className = "admin-account-chip";
  chip.dataset.provider = account.provider;
  if (account.profileUrl) {
    chip.href = account.profileUrl;
    chip.target = "_blank";
    chip.rel = "noreferrer";
  }

  const provider = document.createElement("span");
  provider.className = "admin-account-chip-provider";
  provider.textContent = PROVIDER_LABELS[account.provider] || account.provider;

  const label = document.createElement("span");
  label.className = "admin-account-chip-label";
  label.textContent = getDisplayAccountLabel(account);

  chip.append(provider, label);
  return chip;
}

function getVerificationStatusLabel(definition, status) {
  if (status === "passed") return definition.passedLabel;
  if (status === "failed") return definition.failedLabel;
  if (status === "unknown") return definition.unknownLabel;
  return "Not checked";
}

function getProviderCheckItems(signup, account) {
  const verifications = getAllVerifications(signup);
  const items = CHECK_DEFINITIONS
    .filter((definition) => definition.provider === account.provider)
    .map((definition) => {
      const verification = verifications.find((candidate) => candidate.checkType === definition.checkType);
      if (!verification) return null;
      return createBadge(
        getVerificationStatusLabel(definition, verification.status),
        getStatusTone(verification.status),
        verification.checkedAt ? `Checked ${formatDateTime(verification.checkedAt)}` : ""
      );
    })
    .filter(Boolean);

  for (const [checkType, label] of Object.entries(MANUAL_CLAIM_LABELS)) {
    const claimProvider = checkType.startsWith("x_")
      ? "x"
      : checkType.startsWith("linkedin_")
        ? "linkedin"
        : "coinmarketcap";
    if (claimProvider !== account.provider) continue;
    const verification = checkType === "coinmarketcap_follow_manual"
      ? getCoinMarketCapClaim(signup)
      : verifications.find((candidate) => candidate.checkType === checkType);
    if (verification?.status !== "claimed" && verification?.status !== "passed") continue;
    items.push(createBadge("Follow claimed", "claimed", verification.checkedAt ? `Claimed ${formatDateTime(verification.checkedAt)}` : label));
  }

  return items;
}

function createProviderLine(signup, account) {
  const line = document.createElement("div");
  line.className = "admin-profile-provider";

  const chip = createAccountChip(account);
  const states = document.createElement("div");
  states.className = "admin-provider-states";
  states.append(createBadge("Signed in", "positive"), ...getProviderCheckItems(signup, account));

  line.append(chip, states);
  return line;
}

function createCoinMarketCapLine(signup) {
  const claim = getCoinMarketCapClaim(signup);
  if (!claim) return null;
  const line = document.createElement("div");
  line.className = "admin-profile-provider";
  line.append(
    createAccountChip({
      provider: "coinmarketcap",
      username: "",
      displayName: "",
      profileUrl: "https://coinmarketcap.com/community/profile/Liberdus/"
    })
  );
  const states = document.createElement("div");
  states.className = "admin-provider-states";
  states.append(createBadge("Follow claimed", "claimed", claim.checkedAt ? `Claimed ${formatDateTime(claim.checkedAt)}` : ""));
  line.append(states);
  return line;
}

function createProfileCell(signup, accounts) {
  const lines = accounts.map((account) => createProviderLine(signup, account));
  const coinMarketCapLine = createCoinMarketCapLine(signup);
  if (coinMarketCapLine) lines.push(coinMarketCapLine);
  return createStack(lines, "No linked profile");
}

function createDetailField(label, ...children) {
  const item = document.createElement("div");
  item.className = "admin-detail-field";

  const term = document.createElement("dt");
  term.textContent = label;

  const description = document.createElement("dd");
  description.append(...children);

  item.append(term, description);
  return item;
}

function createDetailSection(title, children, emptyText = "-") {
  const section = document.createElement("section");
  section.className = "admin-detail-section";

  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading);

  if (!children.length) {
    const empty = document.createElement("p");
    empty.className = "admin-detail-empty";
    empty.textContent = emptyText;
    section.append(empty);
    return section;
  }

  section.append(...children);
  return section;
}

function createVerificationDetail(verification) {
  const checked = verification.checkedAt ? `Checked ${formatDateTime(verification.checkedAt)}` : "No timestamp";
  const definition = CHECK_DEFINITION_BY_TYPE[verification.checkType];
  const claimLabel = MANUAL_CLAIM_LABELS[verification.checkType];
  const label = definition?.label || claimLabel || verification.checkType;
  const statusLabel = definition
    ? getVerificationStatusLabel(definition, verification.status)
    : claimLabel
      ? "Claimed"
      : verification.status;
  const tone = claimLabel ? "claimed" : getStatusTone(verification.status);
  const item = document.createElement("div");
  item.className = "admin-detail-check";
  item.append(
    createBadge(statusLabel, tone),
    createText(label),
    createDetailTimestamp(checked)
  );
  return item;
}

function createReplacementDetail(replacement) {
  const changedAt = replacement.createdAt ? `Changed ${formatDateTime(replacement.createdAt)}` : "No timestamp";
  const item = document.createElement("div");
  item.className = "admin-detail-check";
  item.append(
    createBadge(replacement.accountType, replacement.accountType === "wallet" ? "claimed" : "neutral"),
    createText(`${replacement.oldLabel || replacement.oldProviderUserId || "-"} -> ${replacement.newLabel || replacement.newProviderUserId || "-"}`),
    createDetailTimestamp(changedAt)
  );
  return item;
}

function createDetailTimestamp(value) {
  const stamp = document.createElement("span");
  stamp.className = "admin-detail-timestamp";
  stamp.textContent = `| ${value}`;
  return stamp;
}

function getWalletReplacements(signup) {
  return (signup.replacementHistory || []).filter((replacement) => replacement.accountType === "wallet");
}

function getSocialReplacements(signup, provider) {
  return (signup.replacementHistory || []).filter((replacement) => (
    replacement.accountType === "social" && replacement.provider === provider
  ));
}

function getAccountVerifications(account) {
  return account.verifications || [];
}

function createWalletDetail(signup) {
  const card = document.createElement("div");
  card.className = "admin-account-detail";

  const title = document.createElement("h4");
  title.textContent = "Wallet";

  const fields = document.createElement("dl");
  fields.className = "admin-detail-grid";
  fields.append(
    createDetailField("Address", createCode(signup.walletAddress, signup.walletAddress)),
    createDetailField("Chain", createText(signup.walletChainId || "-")),
    createDetailField("Submitted", createText(formatDateTime(signup.submittedAt))),
    createDetailField("Updated", createText(formatDateTime(signup.updatedAt)))
  );

  card.append(
    title,
    fields,
    createDetailSection("Changes", getWalletReplacements(signup).map(createReplacementDetail), "No wallet changes.")
  );
  return card;
}

function createAccountDetail(signup, account) {
  const card = document.createElement("div");
  card.className = "admin-account-detail";

  const title = document.createElement("h4");
  title.textContent = PROVIDER_LABELS[account.provider] || account.provider;

  const fields = document.createElement("dl");
  fields.className = "admin-detail-grid";
  fields.append(
    createDetailField("Name", createText(account.displayName || "-")),
    createDetailField("Username", createText(account.username || "-")),
    createDetailField("Provider ID", account.providerUserId ? createCode(account.providerUserId, account.providerUserId) : createText("-")),
    createDetailField("Connected", createText(formatDateTime(account.connectedAt))),
    createDetailField("Profile", account.profileUrl ? createProfileLink(account.profileUrl) : createText("-"))
  );

  const verifications = getAccountVerifications(account).map(createVerificationDetail);
  card.append(
    title,
    fields,
    createDetailSection("Checks", verifications, "No checks for this account."),
    createDetailSection("Changes", getSocialReplacements(signup, account.provider).map(createReplacementDetail), `No ${PROVIDER_LABELS[account.provider] || account.provider} changes.`)
  );
  return card;
}

function createCoinMarketCapDetail(signup) {
  const claim = getCoinMarketCapClaim(signup);
  if (!claim) return null;
  const card = document.createElement("div");
  card.className = "admin-account-detail";

  const title = document.createElement("h4");
  title.textContent = "CoinMarketCap";

  const fields = document.createElement("dl");
  fields.className = "admin-detail-grid";
  fields.append(
    createDetailField("Profile", createProfileLink("https://coinmarketcap.com/community/profile/Liberdus/")),
    createDetailField("Claimed", createText(formatDateTime(claim.checkedAt)))
  );

  card.append(
    title,
    fields,
    createDetailSection("Checks", [createVerificationDetail(claim)], "No checks for this account.")
  );
  return card;
}

function createProfileLink(href) {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = href;
  return link;
}

function createDetailsRow(signup, accounts, detailsId) {
  const detailRow = document.createElement("tr");
  detailRow.id = detailsId;
  detailRow.className = "admin-detail-row";
  detailRow.hidden = true;

  const cell = document.createElement("td");
  cell.colSpan = 5;

  const detail = document.createElement("div");
  detail.className = "admin-detail-panel";
  const coinMarketCapDetail = createCoinMarketCapDetail(signup);
  const accountDetails = [
    createWalletDetail(signup),
    ...accounts.map((account) => createAccountDetail(signup, account)),
    ...(coinMarketCapDetail ? [coinMarketCapDetail] : [])
  ];
  detail.append(
    createDetailSection("Accounts", accountDetails, "No account details.")
  );

  cell.append(detail);
  detailRow.append(cell);
  return detailRow;
}

function createDetailsButton(detailsRow) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost admin-detail-toggle";
  button.textContent = "Details";
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => {
    const nextHidden = !detailsRow.hidden;
    detailsRow.hidden = nextHidden;
    button.textContent = nextHidden ? "Details" : "Hide";
    button.setAttribute("aria-expanded", nextHidden ? "false" : "true");
  });
  return button;
}

function renderRows(signups) {
  els.submissionsBody.replaceChildren();

  if (!signups.length) {
    els.submissionsBody.append(createEmptyRow("No submissions found."));
    return;
  }

  for (const signup of signups) {
    const row = document.createElement("tr");
    row.className = "admin-summary-row";
    const detailsId = `signupDetails-${String(signup.id || crypto.randomUUID()).replace(/[^a-z0-9_-]+/gi, "-")}`;
    appendCell(row, createText(formatDateTime(signup.submittedAt)));

    appendCell(row, createCode(formatAddressShort(signup.walletAddress), signup.walletAddress));

    const accounts = ["x", "discord", "telegram", "linkedin", "github", "youtube"]
      .map((provider) => getSocialAccount(signup, provider))
      .filter(Boolean);
    const detailsRow = createDetailsRow(signup, accounts, detailsId);
    appendCell(row, createProfileCell(signup, accounts));

    const replacements = signup.replacementHistory || [];
    appendCell(row, createBadge(replacements.length ? `${replacements.length} change${replacements.length === 1 ? "" : "s"}` : "No changes", replacements.length ? "claimed" : "muted"));

    appendCell(row, createDetailsButton(detailsRow));

    els.submissionsBody.append(row, detailsRow);
  }
}

async function loadSubmissions() {
  const params = getFilterParams();

  const payload = await apiFetch(runtime.config, `/api/admin/signups?${params}`, {
    headers: getAdminHeaders()
  });
  els.summaryText.textContent = `${payload.total} submission${payload.total === 1 ? "" : "s"} total. Latest: ${formatDateTime(payload.summary.latestSignupAt)}.`;
  renderRows(payload.signups || []);
}

function appendParam(params, key, value) {
  const normalized = String(value || "").trim();
  if (normalized) params.set(key, normalized);
}

function getFilterParams() {
  const params = new URLSearchParams({
    limit: String(runtime.limit),
    offset: String(runtime.offset)
  });
  appendParam(params, "search", els.searchInput.value);
  appendParam(params, "provider", els.providerFilter.value);
  appendParam(params, "checkType", els.checkTypeFilter.value);
  appendParam(params, "checkStatus", els.checkStatusFilter.value);
  appendParam(params, "manualClaim", els.manualClaimFilter.value);
  appendParam(params, "changed", els.changedFilter.value);
  appendParam(params, "status", els.statusFilter.value);
  appendParam(params, "submittedFrom", els.submittedFromInput.value);
  appendParam(params, "submittedTo", els.submittedToInput.value);
  return params;
}

async function login(event) {
  event.preventDefault();
  const payload = await apiFetch(runtime.config, "/api/admin/login", {
    method: "POST",
    body: JSON.stringify({
      username: els.usernameInput.value,
      password: els.passwordInput.value
    })
  });
  runtime.adminToken = payload.adminToken;
  window.sessionStorage.setItem(ADMIN_TOKEN_KEY, runtime.adminToken);
  els.passwordInput.value = "";
  syncAuthUi();
  await loadSubmissions();
  showMessage("Admin session started.", "success");
}

async function logout() {
  await apiFetch(runtime.config, "/api/admin/logout", {
    method: "POST",
    headers: getAdminHeaders(),
    body: "{}"
  }).catch(() => null);
  runtime.adminToken = "";
  window.sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  syncAuthUi();
}

function exportCsv() {
  const baseUrl = String(runtime.config.apiBaseUrl || "").replace(/\/+$/u, "");
  const url = new URL(`${baseUrl}/api/admin/signups/export`);
  const params = getFilterParams();
  params.delete("limit");
  params.delete("offset");
  url.search = params.toString();
  fetch(url.toString(), {
    credentials: "include",
    cache: "no-store",
    headers: getAdminHeaders()
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Export failed: HTTP ${response.status}`);
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = "liberdus-social-signups.csv";
      anchor.click();
      URL.revokeObjectURL(href);
    })
    .catch((error) => reportError(error, "Export CSV"));
}

function bindEvents() {
  els.loginForm.addEventListener("submit", (event) => {
    login(event).catch((error) => reportError(error, "Login"));
  });
  els.logoutButton.addEventListener("click", () => {
    logout().catch((error) => reportError(error, "Logout"));
  });
  els.refreshButton.addEventListener("click", () => {
    loadSubmissions().catch((error) => reportError(error, "Refresh"));
  });
  els.exportButton.addEventListener("click", exportCsv);
  els.filterForm.addEventListener("submit", (event) => {
    event.preventDefault();
    runtime.search = els.searchInput.value.trim();
    runtime.limit = Number.parseInt(els.pageSizeSelect.value, 10) || 50;
    runtime.offset = 0;
    loadSubmissions().catch((error) => reportError(error, "Filter"));
  });
  els.clearSearchButton.addEventListener("click", () => {
    els.searchInput.value = "";
    els.providerFilter.value = "";
    els.checkTypeFilter.value = "";
    els.checkStatusFilter.value = "";
    els.manualClaimFilter.value = "";
    els.changedFilter.value = "";
    els.statusFilter.value = "";
    els.submittedFromInput.value = "";
    els.submittedToInput.value = "";
    runtime.search = "";
    runtime.offset = 0;
    loadSubmissions().catch((error) => reportError(error, "Clear filter"));
  });
}

async function init() {
  const loaded = await loadUiConfig();
  runtime.config = loaded.config;
  bindEvents();
  syncAuthUi();
  if (runtime.adminToken) {
    await loadSubmissions().catch((error) => {
      runtime.adminToken = "";
      window.sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      syncAuthUi();
      reportError(error, "Load admin session");
    });
  }
}

init().catch((error) => reportError(error, "Initialize admin"));
