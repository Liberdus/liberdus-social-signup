import { ethers } from "./ethers.js";
import { CHAIN_NAME_BY_ID, WALLET_SESSION_KEY, toChainIdHex } from "./constants.js";

const EIP6963_ANNOUNCE_EVENT = "eip6963:announceProvider";
const EIP6963_REQUEST_EVENT = "eip6963:requestProvider";
const LEGACY_WALLET_PREFIX = "legacy";
const LEGACY_DEFAULT_WALLET_ID = `${LEGACY_WALLET_PREFIX}:default`;
const AMBIGUOUS_WALLET_ID = Symbol("ambiguous-wallet-id");

const discoveredWallets = new Map();
const walletAliasIds = new Map();
const walletEventSubscribers = new Set();

let providerIds = new WeakMap();
let walletIdsByUuid = new Map();
let walletIdsByRdns = new Map();
let discoveryInitialized = false;
let activeInjectedProvider = null;
let boundWalletEventProvider = null;
let boundAccountsChanged = null;
let boundChainChanged = null;
let nextEip6963SortIndex = 0;

function createWalletId(source, name, fallback = "wallet") {
  return `${source}:${String(name || fallback).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || fallback}`;
}

function normalizeWalletSession(rawSession) {
  if (!rawSession) return null;

  if (rawSession === "injected") {
    return { walletId: LEGACY_DEFAULT_WALLET_ID };
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

  return typeof rawSession === "string" && rawSession ? { walletId: rawSession } : null;
}

function saveWalletSession(walletId) {
  if (!walletId) {
    clearWalletSession();
    return;
  }

  window.localStorage.setItem(WALLET_SESSION_KEY, JSON.stringify({ walletId }));
}

function clearWalletSession() {
  window.localStorage.removeItem(WALLET_SESSION_KEY);
}

function getWalletSession() {
  return normalizeWalletSession(window.localStorage.getItem(WALLET_SESSION_KEY));
}

export function hasWalletSession() {
  return Boolean(getWalletSession()?.walletId);
}

function resolveChainName(runtime, chainId, networkName) {
  const numericChainId = Number(chainId);
  if (!Number.isFinite(numericChainId)) return null;
  if (runtime?.config?.chainId === numericChainId && runtime?.config?.networkName) {
    return runtime.config.networkName;
  }

  if (typeof networkName === "string" && networkName && networkName !== "unknown") {
    return networkName;
  }

  return CHAIN_NAME_BY_ID[numericChainId] || null;
}

function applyNetworkToRuntime(runtime, network) {
  runtime.chainId = Number(network.chainId);
  runtime.chainName = resolveChainName(runtime, runtime.chainId, network.name);
}

function matchesWalletNamespaceProvider(namespaceProvider, provider) {
  if (!namespaceProvider || !provider) return false;
  if (namespaceProvider === provider) return true;

  const namespaceProviders = Array.isArray(namespaceProvider.providers)
    ? namespaceProvider.providers
    : [];
  const candidateProviders = Array.isArray(provider.providers)
    ? provider.providers
    : [];

  return namespaceProviders.includes(provider) || candidateProviders.includes(namespaceProvider);
}

function isPhantomNamespaceProvider(provider) {
  if (typeof window === "undefined") return false;
  return matchesWalletNamespaceProvider(window.phantom?.ethereum, provider);
}

function guessLegacyWalletName(provider) {
  if (provider?.isPhantom || isPhantomNamespaceProvider(provider)) return "Phantom";
  if (provider?.isRabby) return "Rabby";
  if (provider?.isCoinbaseWallet) return "Coinbase Wallet";
  if (provider?.isBraveWallet) return "Brave Wallet";
  if (provider?.isFrame) return "Frame";
  if (provider?.isTally) return "Taho";
  if (provider?.isMetaMask) return "MetaMask";
  return "Injected Wallet";
}

function guessLegacyWalletRdns(provider) {
  if (provider?.isPhantom || isPhantomNamespaceProvider(provider)) return "com.phantom.browser";
  if (provider?.isRabby) return "io.rabby";
  if (provider?.isCoinbaseWallet) return "com.coinbase.wallet";
  if (provider?.isBraveWallet) return "com.brave.wallet";
  if (provider?.isFrame) return "sh.frame";
  if (provider?.isTally) return "so.tally";
  if (provider?.isMetaMask) return "io.metamask";
  return "";
}

function normalizeWalletIdentityValue(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeWalletInfo(info = {}) {
  return {
    uuid: normalizeWalletIdentityValue(info.uuid),
    name: String(info.name || "").trim(),
    icon: String(info.icon || "").trim(),
    rdns: normalizeWalletIdentityValue(info.rdns),
  };
}

function isBnbChainConfig(config) {
  const chainId = Number(config?.chainId);
  return chainId === 56 || chainId === 97;
}

function getConfiguredNetworkLabel(config) {
  return String(config?.networkName || "").trim() || "the configured network";
}

function isPhantomWallet(wallet) {
  if (!wallet) return false;

  const name = normalizeWalletIdentityValue(wallet.info?.name);
  const rdns = normalizeWalletIdentityValue(wallet.info?.rdns);
  return name.includes("phantom")
    || rdns.includes("phantom")
    || Boolean(wallet.provider?.isPhantom)
    || isPhantomNamespaceProvider(wallet.provider);
}

function getWalletCompatibility(config, wallet) {
  if (!wallet) {
    return {
      isSupported: true,
      isDisabled: false,
      disabledReason: "",
      errorMessage: "",
    };
  }

  if (isBnbChainConfig(config) && isPhantomWallet(wallet)) {
    const networkLabel = getConfiguredNetworkLabel(config);
    const walletName = wallet.info?.name || "This wallet";
    return {
      isSupported: false,
      isDisabled: true,
      disabledReason: `Doesn't support ${networkLabel}.`,
      errorMessage: `${walletName} does not support ${networkLabel}.`,
    };
  }

  return {
    isSupported: true,
    isDisabled: false,
    disabledReason: "",
    errorMessage: "",
  };
}

function assertWalletSupported(config, wallet) {
  const compatibility = getWalletCompatibility(config, wallet);
  if (!compatibility.isSupported) {
    throw new Error(compatibility.errorMessage);
  }

  return compatibility;
}

function mergeWalletInfo(primary = {}, secondary = {}) {
  return {
    uuid: String(primary.uuid || secondary.uuid || ""),
    name: String(primary.name || secondary.name || "Injected Wallet"),
    icon: String(primary.icon || secondary.icon || ""),
    rdns: String(primary.rdns || secondary.rdns || ""),
  };
}

function mergeLinkedProviders(...providers) {
  return [...new Set(providers.filter(Boolean))];
}

function getWalletSourcePriority(source) {
  return source === "eip6963" ? 0 : 1;
}

function createWalletDescriptor(candidate, previous = null) {
  const candidateSource = candidate.source || previous?.source || LEGACY_WALLET_PREFIX;
  const candidatePriority = getWalletSourcePriority(candidateSource);
  const previousPriority = previous?.sourcePriority ?? Number.POSITIVE_INFINITY;
  const isFreshEip6963Announcement = previous
    && candidateSource === "eip6963"
    && previous.source === "eip6963";
  const preferCandidate = !previous || candidatePriority < previousPriority || isFreshEip6963Announcement;

  return {
    id: candidate.id,
    provider: preferCandidate ? candidate.provider : (previous?.provider || candidate.provider),
    linkedProviders: mergeLinkedProviders(previous?.provider, candidate.provider),
    source: preferCandidate ? candidateSource : (previous?.source || candidateSource),
    sourcePriority: preferCandidate ? candidatePriority : (previous?.sourcePriority ?? candidatePriority),
    sortIndex: previous
      ? (preferCandidate ? (candidate.sortIndex ?? previous.sortIndex) : previous.sortIndex)
      : (candidate.sortIndex ?? 0),
    info: mergeWalletInfo(
      preferCandidate ? candidate.info : previous?.info,
      preferCandidate ? previous?.info : candidate.info,
    ),
  };
}

function getWalletSortLabel(wallet) {
  return `${wallet.info?.name || ""}|${wallet.info?.rdns || ""}|${wallet.id || ""}`.toLowerCase();
}

function listWalletsSnapshot() {
  return [...discoveredWallets.values()]
    .sort((left, right) => {
      if (left.sourcePriority !== right.sourcePriority) {
        return left.sourcePriority - right.sourcePriority;
      }
      if (left.sortIndex !== right.sortIndex) {
        return left.sortIndex - right.sortIndex;
      }
      return getWalletSortLabel(left).localeCompare(getWalletSortLabel(right));
    });
}

function rebuildWalletLookups() {
  providerIds = new WeakMap();
  walletIdsByUuid = new Map();
  walletIdsByRdns = new Map();

  for (const wallet of discoveredWallets.values()) {
    for (const provider of mergeLinkedProviders(wallet.provider, ...(wallet.linkedProviders || []))) {
      providerIds.set(provider, wallet.id);
    }
    if (wallet.info?.uuid) {
      walletIdsByUuid.set(wallet.info.uuid, wallet.id);
    }
    if (wallet.info?.rdns) {
      const existingWalletId = walletIdsByRdns.get(wallet.info.rdns);
      if (!existingWalletId) {
        walletIdsByRdns.set(wallet.info.rdns, wallet.id);
      } else if (existingWalletId !== wallet.id) {
        walletIdsByRdns.set(wallet.info.rdns, AMBIGUOUS_WALLET_ID);
      }
    }
  }
}

function resolveWalletAlias(walletId) {
  let resolvedWalletId = String(walletId || "");
  const visited = new Set();

  while (walletAliasIds.has(resolvedWalletId) && !visited.has(resolvedWalletId)) {
    visited.add(resolvedWalletId);
    resolvedWalletId = walletAliasIds.get(resolvedWalletId);
  }

  return resolvedWalletId;
}

function findWalletById(walletId) {
  if (!walletId) return null;
  return discoveredWallets.get(resolveWalletAlias(walletId)) || null;
}

function findWalletId(provider, info = {}, source = LEGACY_WALLET_PREFIX) {
  const existingProviderId = providerIds.get(provider);
  if (existingProviderId) return existingProviderId;

  if (info.uuid && walletIdsByUuid.has(info.uuid)) {
    return walletIdsByUuid.get(info.uuid);
  }

  if (info.rdns) {
    const rdnsWalletId = walletIdsByRdns.get(info.rdns);
    if (rdnsWalletId && rdnsWalletId !== AMBIGUOUS_WALLET_ID) {
      const rdnsWallet = discoveredWallets.get(rdnsWalletId) || null;
      if (source === "eip6963" && info.uuid && rdnsWallet?.source !== LEGACY_WALLET_PREFIX) {
        return null;
      }
      return rdnsWalletId;
    }
  }

  if (source === "eip6963" && info.uuid) {
    return null;
  }

  return null;
}

function hasDiscoveredEip6963Wallets() {
  return [...discoveredWallets.values()].some((wallet) => wallet.source === "eip6963");
}

function pruneLegacyShimWallets(latestWallet) {
  if (!latestWallet || typeof window === "undefined") return false;

  const ethereum = window?.ethereum;
  if (!ethereum || Array.isArray(ethereum.providers)) return false;

  let changed = false;
  for (const wallet of [...discoveredWallets.values()]) {
    if (wallet.id === latestWallet.id) continue;
    if (wallet.source !== LEGACY_WALLET_PREFIX) continue;
    if (wallet.provider !== ethereum) continue;

    discoveredWallets.delete(wallet.id);
    changed = true;
  }

  if (changed) {
    rebuildWalletLookups();
  }

  return changed;
}

function unbindWalletEventProvider() {
  if (boundWalletEventProvider?.removeListener && boundAccountsChanged && boundChainChanged) {
    boundWalletEventProvider.removeListener("accountsChanged", boundAccountsChanged);
    boundWalletEventProvider.removeListener("chainChanged", boundChainChanged);
  }

  boundWalletEventProvider = null;
  boundAccountsChanged = null;
  boundChainChanged = null;
}

async function notifyAccountsChanged() {
  for (const subscriber of walletEventSubscribers) {
    if (subscriber.onAccountsChanged) {
      await subscriber.onAccountsChanged();
    }
  }
}

async function notifyChainChanged(chainId) {
  for (const subscriber of walletEventSubscribers) {
    if (subscriber.onChainChanged) {
      await subscriber.onChainChanged(chainId);
    }
  }
}

function getReadOnlyInjectedProvider() {
  const discoveredProvider = listWalletsSnapshot()[0]?.provider || null;
  if (discoveredProvider) return discoveredProvider;
  if (window.ethereum) return window.ethereum;
  return null;
}

function getCurrentInjectedProvider() {
  return activeInjectedProvider || getReadOnlyInjectedProvider();
}

function syncWalletEventProvider() {
  const nextProvider = walletEventSubscribers.size ? getCurrentInjectedProvider() : null;

  if (!nextProvider?.on) {
    unbindWalletEventProvider();
    return;
  }

  if (boundWalletEventProvider === nextProvider) {
    return;
  }

  unbindWalletEventProvider();

  boundAccountsChanged = async () => {
    await notifyAccountsChanged();
  };

  boundChainChanged = async (chainId) => {
    await notifyChainChanged(chainId);
  };

  nextProvider.on("accountsChanged", boundAccountsChanged);
  nextProvider.on("chainChanged", boundChainChanged);
  boundWalletEventProvider = nextProvider;
}

function registerWallet(candidate) {
  const provider = candidate?.provider;
  if (!provider || typeof provider.request !== "function") return null;

  const normalizedInfo = normalizeWalletInfo(candidate.info);
  const walletId = findWalletId(provider, normalizedInfo, candidate?.source || LEGACY_WALLET_PREFIX)
    || candidate?.id
    || createWalletId(
      candidate?.source || LEGACY_WALLET_PREFIX,
      normalizedInfo.name || guessLegacyWalletName(provider),
      "wallet",
    );
  const previousWallet = discoveredWallets.get(walletId) || null;
  const nextWallet = createWalletDescriptor({
    id: walletId,
    provider,
    source: candidate?.source || LEGACY_WALLET_PREFIX,
    sortIndex: candidate?.sortIndex ?? previousWallet?.sortIndex ?? 0,
    info: normalizedInfo,
  }, previousWallet);

  discoveredWallets.set(walletId, nextWallet);
  if (candidate?.id && candidate.id !== walletId) {
    walletAliasIds.set(candidate.id, walletId);
  }

  rebuildWalletLookups();
  if (activeInjectedProvider === previousWallet?.provider && previousWallet?.provider !== nextWallet.provider) {
    activeInjectedProvider = nextWallet.provider;
  }
  syncWalletEventProvider();
  return nextWallet;
}

function registerLegacyWallet(provider, index = 0) {
  return registerWallet({
    id: index === 0 ? LEGACY_DEFAULT_WALLET_ID : createWalletId(LEGACY_WALLET_PREFIX, `${guessLegacyWalletName(provider)}-${index + 1}`),
    provider,
    source: LEGACY_WALLET_PREFIX,
    sortIndex: index,
    info: {
      name: guessLegacyWalletName(provider),
      rdns: guessLegacyWalletRdns(provider),
      icon: "",
      uuid: "",
    },
  });
}

function collectLegacyWallets() {
  if (!window.ethereum) return [];

  const namespaceProviders = [...new Set([window.phantom?.ethereum].filter(Boolean))];
  const rawProviders = Array.isArray(window.ethereum.providers) && window.ethereum.providers.length
    ? window.ethereum.providers
    : [];
  const uniqueProviders = [...new Set(rawProviders.filter(Boolean))]
    .filter((provider) => !(namespaceProviders.length && provider === window.ethereum && !namespaceProviders.includes(provider)));
  const candidateProviders = [...new Set([...namespaceProviders, ...uniqueProviders])];

  if (candidateProviders.length) {
    return candidateProviders
      .map((provider, index) => registerLegacyWallet(provider, index))
      .filter(Boolean);
  }

  if (hasDiscoveredEip6963Wallets()) {
    return [];
  }

  if (namespaceProviders.length) {
    return [];
  }

  if (providerIds.get(window.ethereum)) {
    return [];
  }

  const wallet = registerLegacyWallet(window.ethereum, 0);
  return wallet ? [wallet] : [];
}

function requestWalletAnnouncements() {
  try {
    window.dispatchEvent(new Event(EIP6963_REQUEST_EVENT));
  } catch {
    // Some browsers may reject synthetic events during teardown.
  }
}

function initWalletDiscovery() {
  if (discoveryInitialized || typeof window === "undefined") return;

  discoveryInitialized = true;
  window.addEventListener(EIP6963_ANNOUNCE_EVENT, (event) => {
    const detail = event?.detail;
    if (!detail?.provider) return;

    const wallet = registerWallet({
      id: detail.info?.uuid || detail.info?.rdns || createWalletId("eip6963", detail.info?.name, "wallet"),
      provider: detail.provider,
      source: "eip6963",
      sortIndex: nextEip6963SortIndex++,
      info: detail.info || {},
    });

    if (pruneLegacyShimWallets(wallet)) {
      syncWalletEventProvider();
    }
  });

  collectLegacyWallets();
  requestWalletAnnouncements();
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function discoverWallets(waitMs = 250) {
  initWalletDiscovery();
  collectLegacyWallets();
  requestWalletAnnouncements();

  if (waitMs > 0) {
    await wait(waitMs);
    collectLegacyWallets();
  }

  return listWalletsSnapshot();
}

function applyActiveWallet(runtime, wallet) {
  const nextInjectedProvider = wallet?.provider || null;

  activeInjectedProvider = nextInjectedProvider;
  runtime.selectedWalletId = wallet?.id || null;
  runtime.selectedWalletName = wallet?.info?.name || null;
  runtime.selectedWalletRdns = wallet?.info?.rdns || null;
  runtime.injectedProvider = nextInjectedProvider;

  if (runtime.providerSource !== nextInjectedProvider) {
    runtime.provider = null;
    runtime.providerSource = null;
    runtime.signer = null;
  }

  syncWalletEventProvider();
}

function getInjectedProviderForRuntime(runtime) {
  const selectedWallet = runtime?.selectedWalletId ? findWalletById(runtime.selectedWalletId) : null;
  if (selectedWallet) {
    runtime.selectedWalletName = selectedWallet.info?.name || null;
    runtime.selectedWalletRdns = selectedWallet.info?.rdns || null;
    runtime.injectedProvider = selectedWallet.provider || null;
    return runtime.injectedProvider;
  }

  return runtime?.injectedProvider || getReadOnlyInjectedProvider();
}

async function resolveWalletById(walletId) {
  if (!walletId) return null;
  const cachedWallet = findWalletById(walletId);
  if (cachedWallet) return cachedWallet;
  const wallets = await discoverWallets();
  return wallets.find((wallet) => wallet.id === resolveWalletAlias(walletId)) || null;
}

export async function getAvailableWallets(config = null) {
  const wallets = await discoverWallets();
  return wallets.map((wallet) => {
    const compatibility = getWalletCompatibility(config, wallet);
    return {
      id: wallet.id,
      source: wallet.source,
      info: { ...wallet.info },
      isDisabled: compatibility.isDisabled,
      disabledReason: compatibility.disabledReason,
    };
  });
}

export async function ensureProvider(runtime) {
  await discoverWallets();
  const injected = getInjectedProviderForRuntime(runtime);
  if (!injected) throw new Error("No compatible wallet was detected in this browser.");

  if (!runtime.provider || runtime.providerSource !== injected) {
    runtime.provider = new ethers.BrowserProvider(injected);
    runtime.providerSource = injected;
  }

  return runtime.provider;
}

export function resetProvider(runtime, nextChainId = null) {
  runtime.provider = null;
  runtime.providerSource = null;
  runtime.signer = null;
  if (nextChainId !== null && nextChainId !== undefined) {
    runtime.chainId = Number(nextChainId);
    runtime.chainName = resolveChainName(runtime, runtime.chainId, null);
    return;
  }
  runtime.chainName = null;
}

export async function connectWallet(runtime, walletId) {
  const wallet = await resolveWalletById(walletId);
  if (!wallet) {
    throw new Error("The selected wallet is no longer available. Refresh the page and try again.");
  }

  assertWalletSupported(runtime?.config, wallet);

  applyActiveWallet(runtime, wallet);

  const provider = await ensureProvider(runtime);
  await provider.send("eth_requestAccounts", []);
  runtime.signer = await provider.getSigner();
  runtime.account = await runtime.signer.getAddress();
  const network = await provider.getNetwork();
  applyNetworkToRuntime(runtime, network);
  saveWalletSession(wallet.id);
  return runtime.account;
}

export async function disconnectWallet(runtime) {
  clearWalletSession();
  runtime.account = null;
  runtime.signer = null;
  applyActiveWallet(runtime, null);

  try {
    const provider = await ensureProvider(runtime);
    const network = await provider.getNetwork();
    applyNetworkToRuntime(runtime, network);
  } catch {
    runtime.chainId = null;
    runtime.chainName = null;
  }
}

export async function syncWalletState(runtime) {
  const session = getWalletSession();
  let selectedWallet = session?.walletId ? await resolveWalletById(session.walletId) : null;

  if (selectedWallet) {
    try {
      assertWalletSupported(runtime?.config, selectedWallet);
    } catch {
      selectedWallet = null;
    }
  }

  if (session?.walletId && !selectedWallet) {
    clearWalletSession();
  }

  applyActiveWallet(runtime, selectedWallet);

  const injected = getInjectedProviderForRuntime(runtime);
  if (!injected) {
    runtime.account = null;
    runtime.signer = null;
    runtime.chainId = null;
    runtime.chainName = null;
    runtime.provider = null;
    runtime.providerSource = null;
    return;
  }

  const provider = await ensureProvider(runtime);
  const network = await provider.getNetwork();

  applyNetworkToRuntime(runtime, network);

  if (!hasWalletSession()) {
    runtime.account = null;
    runtime.signer = null;
    return;
  }

  const accounts = await provider.send("eth_accounts", []);
  runtime.account = accounts[0] ? ethers.getAddress(accounts[0]) : null;
  runtime.signer = runtime.account ? await provider.getSigner() : null;

  if (!runtime.account) {
    clearWalletSession();
  }
}

function getRequestCapableProvider() {
  return getCurrentInjectedProvider();
}

export async function addConfiguredNetwork(config) {
  const injected = getRequestCapableProvider();
  if (!injected) throw new Error("No compatible wallet was detected.");
  if (!Number.isInteger(Number(config.chainId))) throw new Error("Configured chainId is required.");
  if (!config.networkName || !config.rpcUrl || !config.nativeCurrency) {
    throw new Error("Configured networkName, rpcUrl, and nativeCurrency are required.");
  }

  const chainIdHex = toChainIdHex(config.chainId);

  await injected.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: chainIdHex,
        chainName: config.networkName,
        rpcUrls: [config.rpcUrl],
        nativeCurrency: config.nativeCurrency,
      },
    ],
  });
}

export async function switchConfiguredNetwork(config) {
  const injected = getRequestCapableProvider();
  if (!injected) throw new Error("No compatible wallet was detected.");
  if (!Number.isInteger(Number(config.chainId))) throw new Error("Configured chainId is required.");

  const chainIdHex = toChainIdHex(config.chainId);

  try {
    await injected.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (error) {
    if (error?.code === 4902) {
      await addConfiguredNetwork(config);
      await switchConfiguredNetwork(config);
      return;
    }

    throw error;
  }
}

export function bindWalletEvents({ onAccountsChanged, onChainChanged }) {
  const subscriber = { onAccountsChanged, onChainChanged };
  walletEventSubscribers.add(subscriber);
  initWalletDiscovery();
  syncWalletEventProvider();

  return () => {
    walletEventSubscribers.delete(subscriber);
    syncWalletEventProvider();
  };
}
