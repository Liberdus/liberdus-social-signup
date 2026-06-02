import { createWalletCore } from "../index.js";

const STYLE_ID = "liberdus-wallet-connect-styles";

function assertDocument() {
  if (typeof document === "undefined") {
    throw new Error("Wallet connect UI requires a browser document.");
  }
}

function formatAddress(address) {
  if (!address || typeof address !== "string") return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getWalletName(wallet) {
  return wallet?.info?.name || "Injected Wallet";
}

function createWalletInitials(name) {
  const parts = String(name || "Wallet").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (!parts.length) return "W";
  return parts.map((part) => part[0]?.toUpperCase() || "").join("");
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .liberdus-wallet-connect {
      position: relative;
      display: inline-flex;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #111827;
    }

    .liberdus-wallet-connect * {
      box-sizing: border-box;
    }

    .liberdus-wallet-connect__button,
    .liberdus-wallet-connect__wallet,
    .liberdus-wallet-connect__disconnect {
      appearance: none;
      border: 0;
      font: inherit;
    }

    .liberdus-wallet-connect__button {
      min-height: 42px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 0 16px;
      border-radius: 8px;
      background: #111827;
      color: #ffffff;
      font-size: 14px;
      font-weight: 650;
      line-height: 1;
      cursor: pointer;
      box-shadow: 0 8px 20px rgba(17, 24, 39, 0.16);
    }

    .liberdus-wallet-connect__button:hover {
      background: #1f2937;
    }

    .liberdus-wallet-connect__button:focus-visible,
    .liberdus-wallet-connect__wallet:focus-visible,
    .liberdus-wallet-connect__disconnect:focus-visible {
      outline: 3px solid rgba(37, 99, 235, 0.34);
      outline-offset: 2px;
    }

    .liberdus-wallet-connect__chevron {
      width: 7px;
      height: 7px;
      border-right: 2px solid currentColor;
      border-bottom: 2px solid currentColor;
      transform: rotate(45deg) translateY(-1px);
      opacity: 0.85;
    }

    .liberdus-wallet-connect__menu {
      position: absolute;
      z-index: 2147483647;
      top: calc(100% + 8px);
      left: 0;
      width: min(320px, calc(100vw - 32px));
      padding: 8px;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      background: #ffffff;
      box-shadow: 0 18px 42px rgba(15, 23, 42, 0.18);
    }

    .liberdus-wallet-connect__title {
      padding: 8px 10px 10px;
      color: #4b5563;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .liberdus-wallet-connect__wallet,
    .liberdus-wallet-connect__disconnect {
      width: 100%;
      min-height: 48px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 8px;
      background: transparent;
      color: #111827;
      text-align: left;
      cursor: pointer;
    }

    .liberdus-wallet-connect__wallet:hover,
    .liberdus-wallet-connect__disconnect:hover {
      background: #f3f4f6;
    }

    .liberdus-wallet-connect__wallet:disabled {
      cursor: not-allowed;
      opacity: 0.58;
    }

    .liberdus-wallet-connect__icon {
      width: 30px;
      height: 30px;
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      border-radius: 8px;
      background: #eef2ff;
      color: #3730a3;
      font-size: 12px;
      font-weight: 800;
    }

    .liberdus-wallet-connect__icon img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .liberdus-wallet-connect__wallet-copy {
      min-width: 0;
      display: grid;
      gap: 2px;
    }

    .liberdus-wallet-connect__wallet-name {
      overflow: hidden;
      color: #111827;
      font-size: 14px;
      font-weight: 650;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .liberdus-wallet-connect__wallet-meta,
    .liberdus-wallet-connect__message {
      color: #6b7280;
      font-size: 12px;
      line-height: 1.35;
    }

    .liberdus-wallet-connect__message {
      padding: 10px;
    }
  `;
  document.head.append(style);
}

function createWalletIcon(wallet) {
  const icon = document.createElement("span");
  icon.className = "liberdus-wallet-connect__icon";
  icon.textContent = createWalletInitials(getWalletName(wallet));

  if (wallet?.info?.icon) {
    const image = document.createElement("img");
    image.src = wallet.info.icon;
    image.alt = "";
    image.addEventListener("load", () => {
      icon.textContent = "";
      icon.append(image);
    });
  }

  return icon;
}

export function createWalletConnectButton({
  target,
  walletCore = createWalletCore(),
  buttonLabel = "Connect Wallet",
  onConnect = null,
  onDisconnect = null,
  onError = null,
} = {}) {
  assertDocument();
  ensureStyles();

  const mount = target || document.body;
  const root = document.createElement("div");
  root.className = "liberdus-wallet-connect";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "liberdus-wallet-connect__button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");

  const menu = document.createElement("div");
  menu.className = "liberdus-wallet-connect__menu";
  menu.hidden = true;

  root.append(button, menu);
  mount.append(root);

  let isOpen = false;
  let isBusy = false;
  let wallets = [];

  function emitError(error) {
    if (typeof onError === "function") {
      onError(error);
      return;
    }
    console.error(error);
  }

  function getState() {
    return walletCore.getState();
  }

  function closeMenu() {
    isOpen = false;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }

  function renderButton() {
    const state = getState();
    const label = state.account
      ? formatAddress(state.account)
      : buttonLabel;

    button.replaceChildren(document.createTextNode(isBusy ? "Connecting..." : label));
    const chevron = document.createElement("span");
    chevron.className = "liberdus-wallet-connect__chevron";
    chevron.setAttribute("aria-hidden", "true");
    button.append(chevron);
    button.disabled = isBusy;
  }

  function renderConnectedMenu() {
    const state = getState();
    menu.replaceChildren();

    const title = document.createElement("div");
    title.className = "liberdus-wallet-connect__title";
    title.textContent = state.account ? formatAddress(state.account) : "Wallet";

    const disconnect = document.createElement("button");
    disconnect.type = "button";
    disconnect.className = "liberdus-wallet-connect__disconnect";
    disconnect.textContent = "Disconnect";
    disconnect.addEventListener("click", async () => {
      await walletCore.disconnect();
      closeMenu();
      renderButton();
      if (typeof onDisconnect === "function") onDisconnect();
    });

    menu.append(title, disconnect);
  }

  function renderWalletMenu() {
    menu.replaceChildren();

    const title = document.createElement("div");
    title.className = "liberdus-wallet-connect__title";
    title.textContent = "Select Wallet";
    menu.append(title);

    if (!wallets.length) {
      const message = document.createElement("div");
      message.className = "liberdus-wallet-connect__message";
      message.textContent = "No compatible browser wallet was detected.";
      menu.append(message);
      return;
    }

    for (const wallet of wallets) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "liberdus-wallet-connect__wallet";
      item.dataset.walletId = wallet.id;

      const copy = document.createElement("span");
      copy.className = "liberdus-wallet-connect__wallet-copy";

      const name = document.createElement("span");
      name.className = "liberdus-wallet-connect__wallet-name";
      name.textContent = getWalletName(wallet);

      const meta = document.createElement("span");
      meta.className = "liberdus-wallet-connect__wallet-meta";
      meta.textContent = wallet.info?.rdns || wallet.source || "Injected provider";

      copy.append(name, meta);
      item.append(createWalletIcon(wallet), copy);
      item.addEventListener("click", async () => {
        await connectWallet(wallet.id);
      });
      menu.append(item);
    }
  }

  async function openMenu() {
    isOpen = true;
    button.setAttribute("aria-expanded", "true");

    if (getState().account) {
      renderConnectedMenu();
    } else {
      wallets = await walletCore.discoverWallets();
      renderWalletMenu();
    }

    menu.hidden = false;
  }

  async function connectWallet(walletId) {
    isBusy = true;
    renderButton();
    try {
      const account = await walletCore.connect({ walletId });
      closeMenu();
      renderButton();
      if (typeof onConnect === "function") onConnect({ account, state: getState() });
    } catch (error) {
      emitError(error);
      renderWalletMenu();
    } finally {
      isBusy = false;
      renderButton();
    }
  }

  async function toggleMenu() {
    if (isBusy) return;
    if (isOpen) {
      closeMenu();
      return;
    }

    try {
      await openMenu();
    } catch (error) {
      emitError(error);
    }
  }

  function handleDocumentClick(event) {
    if (!root.contains(event.target)) {
      closeMenu();
    }
  }

  function handleKeydown(event) {
    if (event.key === "Escape") {
      closeMenu();
      button.focus();
    }
  }

  const unsubscribe = walletCore.subscribe(() => {
    renderButton();
  });

  button.addEventListener("click", toggleMenu);
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("keydown", handleKeydown);

  walletCore.sync().then(renderButton).catch(emitError);
  renderButton();

  return {
    element: root,
    walletCore,
    open: openMenu,
    close: closeMenu,
    destroy() {
      unsubscribe();
      document.removeEventListener("click", handleDocumentClick);
      document.removeEventListener("keydown", handleKeydown);
      root.remove();
    },
  };
}

export function defineWalletConnectElement(name = "liberdus-wallet-connect") {
  assertDocument();
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") {
    throw new Error("Wallet connect custom element requires Custom Elements support.");
  }
  if (customElements.get(name)) return customElements.get(name);

  class LiberdusWalletConnectElement extends HTMLElement {
    connectedCallback() {
      if (this.walletControl) return;
      this.walletControl = createWalletConnectButton({
        target: this,
        buttonLabel: this.getAttribute("button-label") || "Connect Wallet",
      });
    }

    disconnectedCallback() {
      this.walletControl?.destroy();
      this.walletControl = null;
    }
  }

  customElements.define(name, LiberdusWalletConnectElement);
  return LiberdusWalletConnectElement;
}
