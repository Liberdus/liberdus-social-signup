const EIP6963_ANNOUNCE_EVENT = "eip6963:announceProvider";
const EIP6963_REQUEST_EVENT = "eip6963:requestProvider";
const LEGACY_WALLET_PREFIX = "legacy";
const LEGACY_DEFAULT_WALLET_ID = `${LEGACY_WALLET_PREFIX}:default`;
const AMBIGUOUS_WALLET_ID = Symbol("ambiguous-wallet-id");

function createWalletId(source, name, fallback = "wallet") {
  return `${source}:${String(name || fallback).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || fallback}`;
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

export function createWalletDiscovery({ discoveryWaitMs = 250 } = {}) {
  const discoveredWallets = new Map();
  const walletAliasIds = new Map();
  let providerIds = new WeakMap();
  let walletIdsByUuid = new Map();
  let walletIdsByRdns = new Map();
  let discoveryInitialized = false;
  let activeInjectedProvider = null;
  let boundWalletEventProvider = null;
  let boundAccountsChanged = null;
  let boundChainChanged = null;
  let nextEip6963SortIndex = 0;
  const walletEventSubscribers = new Set();

  function emitEvent(event, data) {
    walletEventSubscribers.forEach((subscriber) => {
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

  function listWalletsSnapshot() {
    return [...discoveredWallets.values()].sort((left, right) => {
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

    const ethereum = window.ethereum;
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

  function syncWalletEventProvider() {
    const nextProvider = walletEventSubscribers.size ? activeInjectedProvider || getReadOnlyInjectedProvider() : null;

    if (!nextProvider?.on) {
      if (boundWalletEventProvider) {
        try {
          boundWalletEventProvider.removeListener("accountsChanged", boundAccountsChanged);
          boundWalletEventProvider.removeListener("chainChanged", boundChainChanged);
        } catch {
          // ignore
        }
      }
      boundWalletEventProvider = null;
      boundAccountsChanged = null;
      boundChainChanged = null;
      return;
    }

    if (boundWalletEventProvider === nextProvider) {
      return;
    }

    if (boundWalletEventProvider && boundAccountsChanged && boundChainChanged) {
      try {
        boundWalletEventProvider.removeListener("accountsChanged", boundAccountsChanged);
        boundWalletEventProvider.removeListener("chainChanged", boundChainChanged);
      } catch {
        // ignore
      }
    }

    boundAccountsChanged = async (accounts) => {
      emitEvent("accountChanged", accounts);
    };

    boundChainChanged = async (chainId) => {
      emitEvent("chainChanged", chainId);
    };

    nextProvider.on("accountsChanged", boundAccountsChanged);
    nextProvider.on("chainChanged", boundChainChanged);
    boundWalletEventProvider = nextProvider;
  }

  function getReadOnlyInjectedProvider() {
    const discoveredProvider = listWalletsSnapshot()[0]?.provider || null;
    if (discoveredProvider) return discoveredProvider;
    if (typeof window !== "undefined" && window.ethereum) return window.ethereum;
    return null;
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
    emitEvent("providersChanged", listWalletsSnapshot());
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
    if (typeof window === "undefined" || !window.ethereum) return [];

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
    if (typeof window === "undefined") return;
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

  async function discoverWallets(waitMs = discoveryWaitMs) {
    initWalletDiscovery();
    collectLegacyWallets();
    requestWalletAnnouncements();

    if (waitMs > 0) {
      await wait(waitMs);
      collectLegacyWallets();
    }

    return listWalletsSnapshot();
  }

  function applyActiveWallet(wallet) {
    activeInjectedProvider = wallet?.provider || null;
    syncWalletEventProvider();
    emitEvent("providersChanged", listWalletsSnapshot());
  }

  function getInjectedProvider() {
    return activeInjectedProvider || getReadOnlyInjectedProvider();
  }

  async function resolveWalletById(walletId) {
    if (!walletId) return null;
    await discoverWallets();
    return findWalletById(walletId);
  }

  function getAvailableWallets() {
    return listWalletsSnapshot().map((wallet) => ({
      id: wallet.id,
      source: wallet.source,
      info: { ...wallet.info },
    }));
  }

  return {
    discoverWallets,
    getAvailableWallets,
    resolveWalletById,
    applyActiveWallet,
    getInjectedProvider,
    subscribe: (handler) => {
      walletEventSubscribers.add(handler);
      initWalletDiscovery();
      syncWalletEventProvider();
      return () => {
        walletEventSubscribers.delete(handler);
        syncWalletEventProvider();
      };
    },
  };
}
