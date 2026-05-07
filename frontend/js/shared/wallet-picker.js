let walletPickerElements = null;
let activeResolver = null;
let activeCloseHandler = null;

function createWalletInitials(name) {
  const parts = String(name || "Wallet")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  if (!parts.length) return "W";
  return parts.map((part) => part[0]?.toUpperCase() || "").join("");
}

function createWalletReasonId(walletId) {
  return `walletPickerReason-${String(walletId || "wallet").replace(/[^a-z0-9_-]+/gi, "-")}`;
}

function ensureWalletPicker() {
  if (walletPickerElements) return walletPickerElements;

  const overlay = document.createElement("div");
  overlay.className = "wallet-picker";
  overlay.hidden = true;

  const dialog = document.createElement("div");
  dialog.className = "wallet-picker-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "walletPickerTitle");

  const header = document.createElement("div");
  header.className = "wallet-picker-header";

  const headingWrap = document.createElement("div");
  const title = document.createElement("h2");
  title.id = "walletPickerTitle";
  title.textContent = "Select Wallet";
  headingWrap.append(title);

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "ghost wallet-picker-close";
  closeButton.setAttribute("aria-label", "Close wallet picker");
  closeButton.textContent = "x";

  header.append(headingWrap, closeButton);

  const list = document.createElement("div");
  list.className = "wallet-picker-list";

  const footer = document.createElement("div");
  footer.className = "wallet-picker-footer";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "ghost wallet-picker-cancel";
  cancelButton.textContent = "Cancel";
  footer.append(cancelButton);

  dialog.append(header, list, footer);
  overlay.append(dialog);
  document.body.append(overlay);

  walletPickerElements = {
    overlay,
    dialog,
    title,
    list,
    closeButton,
    cancelButton,
  };

  return walletPickerElements;
}

function closeWalletPicker(selectedWalletId = null) {
  if (!walletPickerElements?.overlay) return;

  walletPickerElements.overlay.hidden = true;
  document.body.classList.remove("wallet-picker-open");
  document.removeEventListener("keydown", activeCloseHandler);
  activeCloseHandler = null;

  if (activeResolver) {
    const resolve = activeResolver;
    activeResolver = null;
    resolve(selectedWalletId);
  }
}

function createWalletOption(wallet, selectedWalletId) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "wallet-picker-option";
  button.dataset.walletId = wallet.id;
  button.disabled = Boolean(wallet.isDisabled);

  const iconShell = document.createElement("span");
  iconShell.className = "wallet-picker-icon-shell";

  const fallback = document.createElement("span");
  fallback.className = "wallet-picker-icon-fallback";
  fallback.textContent = createWalletInitials(wallet.info?.name);
  iconShell.append(fallback);

  if (wallet.info?.icon) {
    const img = document.createElement("img");
    img.className = "wallet-picker-icon";
    img.src = wallet.info.icon;
    img.alt = "";
    img.addEventListener("load", () => {
      fallback.hidden = true;
    });
    img.addEventListener("error", () => {
      img.remove();
    });
    iconShell.prepend(img);
  }

  const copy = document.createElement("span");
  copy.className = "wallet-picker-copy";

  const label = document.createElement("span");
  label.className = "wallet-picker-name";
  label.textContent = wallet.info?.name || "Injected Wallet";
  copy.append(label);

  if (wallet.disabledReason) {
    const reason = document.createElement("span");
    reason.className = "wallet-picker-reason";
    reason.id = createWalletReasonId(wallet.id);
    reason.textContent = wallet.disabledReason;
    copy.append(reason);
    button.setAttribute("aria-describedby", reason.id);
    button.title = wallet.disabledReason;
  }

  if (wallet.id === selectedWalletId) {
    const badge = document.createElement("span");
    badge.className = "wallet-picker-badge";
    badge.textContent = "Last used";
    button.append(iconShell, copy, badge);
  } else {
    button.append(iconShell, copy);
  }

  return button;
}

function renderWalletOptions(wallets, selectedWalletId) {
  const { list } = ensureWalletPicker();
  list.replaceChildren();

  if (!wallets.length) {
    const empty = document.createElement("div");
    empty.className = "wallet-picker-empty";
    empty.innerHTML = `
      <p>No compatible browser wallet was detected.</p>
      <p>Install a wallet that supports injected Ethereum providers, then refresh this page.</p>
    `;
    list.append(empty);
    return;
  }

  for (const wallet of wallets) {
    list.append(createWalletOption(wallet, selectedWalletId));
  }
}

export function promptForWalletSelection({
  wallets,
  selectedWalletId = null,
  title = "Select Wallet",
} = {}) {
  const elements = ensureWalletPicker();

  if (activeResolver) {
    closeWalletPicker(null);
  }

  elements.title.textContent = title;
  renderWalletOptions(wallets || [], selectedWalletId);

  elements.list.onclick = (event) => {
    const button = event.target instanceof Element
      ? event.target.closest("[data-wallet-id]")
      : null;
    if (!button || button.disabled) return;

    closeWalletPicker(button.dataset.walletId || null);
  };

  const requestClose = () => {
    closeWalletPicker(null);
  };

  elements.closeButton.onclick = requestClose;
  elements.cancelButton.onclick = requestClose;
  elements.overlay.onclick = (event) => {
    if (event.target === elements.overlay) {
      requestClose();
    }
  };

  activeCloseHandler = (event) => {
    if (event.key === "Escape") {
      requestClose();
    }
  };

  document.addEventListener("keydown", activeCloseHandler);
  document.body.classList.add("wallet-picker-open");
  elements.overlay.hidden = false;

  const firstOption = elements.list.querySelector("[data-wallet-id]:not(:disabled)");
  window.setTimeout(() => {
    if (firstOption instanceof HTMLElement) {
      firstOption.focus();
      return;
    }

    elements.closeButton.focus();
  }, 0);

  return new Promise((resolve) => {
    activeResolver = resolve;
  });
}
