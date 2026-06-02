function parseChainId(rawChainId) {
  if (typeof rawChainId === "number" && Number.isFinite(rawChainId)) {
    return Number(rawChainId);
  }
  if (typeof rawChainId === "string" && rawChainId.trim().length) {
    if (rawChainId.startsWith("0x")) {
      return Number.parseInt(rawChainId, 16);
    }
    return Number(rawChainId);
  }
  return null;
}

function resolveChainName(chainId, networkName) {
  const numericChainId = Number(chainId);
  if (!Number.isFinite(numericChainId)) return null;
  if (typeof networkName === "string" && networkName && networkName !== "unknown") {
    return networkName;
  }
  return null;
}

function normalizeAddress(address) {
  if (!address || typeof address !== "string") return null;
  const trimmed = address.trim();
  if (!trimmed.startsWith("0x") || trimmed.length !== 42) return null;
  return trimmed.toLowerCase();
}

function normalizeWalletSession(rawSession) {
  if (!rawSession) return null;
  if (typeof rawSession !== "string") return null;
  if (rawSession === "injected") {
    return { walletId: "legacy:default" };
  }
  if (rawSession.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(rawSession);
      if (typeof parsed?.walletId === "string" && parsed.walletId) {
        return { walletId: parsed.walletId };
      }
    } catch {
      return null;
    }
  }
  return rawSession ? { walletId: rawSession } : null;
}

function isStorageUsable(storage) {
  return storage && typeof storage.getItem === "function" && typeof storage.setItem === "function" && typeof storage.removeItem === "function";
}

export function createWalletSession({ discovery, storage, walletSessionKey = "liberdus-wallet-module:walletSession" } = {}) {
  const sessionSubscribers = new Set();
  const state = {
    account: null,
    chainId: null,
    chainName: null,
    selectedWalletId: null,
    selectedWalletName: null,
    selectedWalletRdns: null,
    sessionWalletId: null,
    injectedProvider: null,
    providerSource: null,
    isConnecting: false,
  };

  let discoveryUnsubscribe = null;

  function updateInjectedProviderState() {
    const provider = discovery.getInjectedProvider();
    state.injectedProvider = provider;
    state.providerSource = provider;
  }

  function saveWalletSession(walletId) {
    if (!isStorageUsable(storage)) return;
    if (!walletId) {
      storage.removeItem(walletSessionKey);
      return;
    }
    storage.setItem(walletSessionKey, JSON.stringify({ walletId }));
  }

  function clearWalletSession() {
    if (isStorageUsable(storage)) {
      storage.removeItem(walletSessionKey);
    }
    state.sessionWalletId = null;
  }

  function getWalletSession() {
    if (!isStorageUsable(storage)) return null;
    return normalizeWalletSession(storage.getItem(walletSessionKey));
  }

  function emitEvent(event, data) {
    sessionSubscribers.forEach((subscriber) => {
      try {
        if (typeof subscriber === "function") {
          subscriber(event, data);
        } else if (subscriber && typeof subscriber.handleEvent === "function") {
          subscriber.handleEvent(event, data);
        }
      } catch {
        // ignore subscriber errors
      }
    });
  }

  function handleDiscoveryEvent(event, data) {
    if (event === "accountChanged") {
      const nextAddress = normalizeAddress(Array.isArray(data) ? data[0] : data);
      if (state.account !== nextAddress) {
        state.account = nextAddress;
        if (!nextAddress) {
          clearWalletSession();
        }
        emitEvent("accountChanged", nextAddress);
      }
      return;
    }

    if (event === "chainChanged") {
      const nextChainId = parseChainId(data);
      state.chainId = nextChainId;
      state.chainName = resolveChainName(nextChainId, null);
      emitEvent("chainChanged", data);
      return;
    }

    if (event === "providersChanged") {
      emitEvent("providersChanged", data);
      return;
    }
  }

  function bindDiscoveryEvents() {
    if (discoveryUnsubscribe) return;
    discoveryUnsubscribe = discovery.subscribe(handleDiscoveryEvent);
  }

  async function initializeDiscoveryEvents() {
    bindDiscoveryEvents();
  }

  function getState() {
    return { ...state };
  }

  function hasWalletSession() {
    return Boolean(getWalletSession()?.walletId);
  }

  async function connect({ walletId } = {}) {
    const wallet = await discovery.resolveWalletById(walletId);
    if (!wallet) {
      throw new Error("The selected wallet is no longer available. Refresh the page and try again.");
    }

    state.isConnecting = true;
    try {
      discovery.applyActiveWallet(wallet);
      updateInjectedProviderState();
      await initializeDiscoveryEvents();

      const provider = discovery.getInjectedProvider();
      if (!provider) {
        throw new Error("No compatible wallet was detected in this browser.");
      }

      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const account = normalizeAddress(Array.isArray(accounts) ? accounts[0] : accounts);
      if (!account) {
        throw new Error("Wallet did not return an account.");
      }

      const chainId = parseChainId(await provider.request({ method: "eth_chainId" }));
      state.account = account;
      state.chainId = chainId;
      state.chainName = resolveChainName(chainId, null);
      state.selectedWalletId = wallet.id;
      state.selectedWalletName = wallet.info?.name || null;
      state.selectedWalletRdns = wallet.info?.rdns || null;
      state.sessionWalletId = wallet.id;
      saveWalletSession(wallet.id);

      emitEvent("connected", {
        walletId: wallet.id,
        account: state.account,
        chainId: state.chainId,
      });

      return state.account;
    } finally {
      state.isConnecting = false;
    }
  }

  async function disconnect() {
    clearWalletSession();
    state.account = null;
    state.chainId = null;
    state.chainName = null;
    state.selectedWalletId = null;
    state.selectedWalletName = null;
    state.selectedWalletRdns = null;
    state.sessionWalletId = null;
    state.injectedProvider = null;
    state.providerSource = null;
    state.isConnecting = false;
    discovery.applyActiveWallet(null);
    emitEvent("disconnected", null);
  }

  async function sync() {
    await initializeDiscoveryEvents();
    const session = getWalletSession();
    const selectedWallet = session?.walletId ? await discovery.resolveWalletById(session.walletId) : null;

    if (session?.walletId && !selectedWallet) {
      clearWalletSession();
    }

    discovery.applyActiveWallet(selectedWallet);
    updateInjectedProviderState();
    state.selectedWalletId = selectedWallet?.id || null;
    state.selectedWalletName = selectedWallet?.info?.name || null;
    state.selectedWalletRdns = selectedWallet?.info?.rdns || null;
    state.sessionWalletId = session?.walletId || null;

    const injected = discovery.getInjectedProvider();
    if (!injected) {
      state.account = null;
      state.chainId = null;
      state.chainName = null;
      state.sessionWalletId = null;
      return state;
    }

    try {
      const chainId = parseChainId(await injected.request({ method: "eth_chainId" }));
      state.chainId = chainId;
      state.chainName = resolveChainName(chainId, null);
    } catch {
      state.chainId = null;
      state.chainName = null;
    }

    if (!session?.walletId) {
      state.account = null;
      state.sessionWalletId = null;
      return state;
    }

    try {
      const accounts = await injected.request({ method: "eth_accounts" });
      const account = normalizeAddress(Array.isArray(accounts) ? accounts[0] : accounts);
      state.account = account;
      if (!account) {
        clearWalletSession();
      }
    } catch {
      state.account = null;
      clearWalletSession();
    }

    return state;
  }

  function subscribe(handler) {
    sessionSubscribers.add(handler);
    initializeDiscoveryEvents();
    return () => {
      sessionSubscribers.delete(handler);
    };
  }

  return {
    connect,
    disconnect,
    sync,
    getState,
    hasWalletSession,
    subscribe,
  };
}
