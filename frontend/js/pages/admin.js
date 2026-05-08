import { loadUiConfig } from "../shared/config.js";
import { apiFetch } from "../shared/api.js";
import { createToastController } from "../shared/toast.js";
import { formatAddressShort, formatDateTime } from "../shared/format.js";

const ADMIN_TOKEN_KEY = "liberdus-social-signup-admin-token";

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

function createLineBreak() {
  return document.createElement("br");
}

function createEmptyRow(message) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 6;
  cell.className = "empty-row";
  cell.textContent = message;
  row.append(cell);
  return row;
}

function renderRows(signups) {
  els.submissionsBody.replaceChildren();

  if (!signups.length) {
    els.submissionsBody.append(createEmptyRow("No submissions found."));
    return;
  }

  for (const signup of signups) {
    const socialByProvider = Object.fromEntries((signup.socialAccounts || []).map((account) => [account.provider, account]));
    const discordName = signup.discordUsername || socialByProvider.discord?.displayName || socialByProvider.discord?.username || "";
    const telegramName = signup.telegramUsername || socialByProvider.telegram?.username || socialByProvider.telegram?.displayName || "";
    const linkedinName = signup.linkedinUrl || socialByProvider.linkedin?.displayName || signup.verification?.linkedin?.name || "";
    const githubName = socialByProvider.github?.username || socialByProvider.github?.displayName || signup.verification?.github?.username || "";
    const socials = [
      discordName ? `Discord: ${discordName}` : "",
      telegramName ? `Telegram: ${telegramName}` : "",
      linkedinName ? `LinkedIn: ${linkedinName}` : "",
      githubName ? `GitHub: ${githubName}` : ""
    ].filter(Boolean);

    const row = document.createElement("tr");
    appendCell(row, createText(formatDateTime(signup.submittedAt)));

    const xName = document.createElement("strong");
    xName.textContent = `@${signup.xUsername}`;
    appendCell(row, xName, createLineBreak(), createCode(signup.xUserId));

    appendCell(row, createCode(formatAddressShort(signup.walletAddress), signup.walletAddress));
    appendCell(row, createText(signup.email || "-"));

    const socialsCell = document.createElement("td");
    if (socials.length) {
      socials.forEach((social, index) => {
        if (index) socialsCell.append(createLineBreak());
        socialsCell.append(createText(social));
      });
    } else {
      socialsCell.textContent = "-";
    }
    row.append(socialsCell);

    const status = document.createElement("span");
    status.className = "table-flag";
    status.dataset.tone = "positive";
    status.textContent = signup.status;
    appendCell(row, status);

    els.submissionsBody.append(row);
  }
}

async function loadSubmissions() {
  const params = new URLSearchParams({
    limit: String(runtime.limit),
    offset: String(runtime.offset)
  });
  if (runtime.search) params.set("search", runtime.search);

  const payload = await apiFetch(runtime.config, `/api/admin/signups?${params}`, {
    headers: getAdminHeaders()
  });
  els.summaryText.textContent = `${payload.total} submission${payload.total === 1 ? "" : "s"} total. Latest: ${formatDateTime(payload.summary.latestSignupAt)}.`;
  renderRows(payload.signups || []);
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
