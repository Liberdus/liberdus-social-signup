import { createWalletCore } from "../../../vendor/liberdus-wallet-module/index.js";
import {
  addEthereumChain,
  switchOrAddEthereumChain,
} from "../../../vendor/liberdus-wallet-module/adapters/chain.js";
import { ethers } from "./ethers.js";
import { CHAIN_NAME_BY_ID, WALLET_SESSION_KEY } from "./constants.js";
import { normalizeAddress } from "./format.js";

const walletCore = createWalletCore({
  storage: getBrowserStorage(),
  walletSessionKey: WALLET_SESSION_KEY,
});

function getBrowserStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalizeChainId(rawChainId) {
  if (typeof rawChainId === "bigint") return Number(rawChainId);
  if (typeof rawChainId === "number" && Number.isFinite(rawChainId)) return Number(rawChainId);
  if (typeof rawChainId === "string" && rawChainId.trim()) {
    return rawChainId.startsWith("0x")
      ? Number.parseInt(rawChainId, 16)
      : Number(rawChainId);
  }
  return null;
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

function applyNetworkToRuntime(runtime, networkOrChainId) {
  const rawChainId = typeof networkOrChainId === "object"
    ? networkOrChainId?.chainId
    : networkOrChainId;
  const chainId = normalizeChainId(rawChainId);

  runtime.chainId = chainId;
  runtime.chainName = resolveChainName(runtime, chainId, networkOrChainId?.name);
}

function isBnbChainConfig(config) {
  const chainId = Number(config?.chainId);
  return chainId === 56 || chainId === 97;
}

function getConfiguredNetworkLabel(config) {
  return String(config?.networkName || "").trim() || "the configured network";
}

function getWalletIdentityValue(value) {
  return String(value || "").trim().toLowerCase();
}

function isPhantomWallet(wallet) {
  if (!wallet) return false;

  const name = getWalletIdentityValue(wallet.info?.name);
  const rdns = getWalletIdentityValue(wallet.info?.rdns);
  const phantomProvider = typeof window === "undefined" ? null : window.phantom?.ethereum;
  return name.includes("phantom")
    || rdns.includes("phantom")
    || Boolean(wallet.provider?.isPhantom)
    || Boolean(phantomProvider && phantomProvider === wallet.provider);
}

function getWalletCompatibility(config, wallet) {
  if (!wallet || !isBnbChainConfig(config) || !isPhantomWallet(wallet)) {
    return {
      isSupported: true,
      isDisabled: false,
      disabledReason: "",
      errorMessage: "",
    };
  }

  const networkLabel = getConfiguredNetworkLabel(config);
  const walletName = wallet.info?.name || "This wallet";
  return {
    isSupported: false,
    isDisabled: true,
    disabledReason: `Doesn't support ${networkLabel}.`,
    errorMessage: `${walletName} does not support ${networkLabel}.`,
  };
}

function assertWalletSupported(config, wallet) {
  const compatibility = getWalletCompatibility(config, wallet);
  if (!compatibility.isSupported) {
    throw new Error(compatibility.errorMessage);
  }
}

function getInjectedProvider() {
  return walletCore.getEip1193Provider?.() || null;
}

function applyCoreStateToRuntime(runtime, state = walletCore.getState()) {
  const injectedProvider = getInjectedProvider();

  runtime.injectedProvider = injectedProvider;
  runtime.selectedWalletId = state.selectedWalletId || state.sessionWalletId || null;
  runtime.selectedWalletName = state.selectedWalletName || null;
  runtime.selectedWalletRdns = state.selectedWalletRdns || null;

  const account = normalizeAddress(state.account || "");
  runtime.account = account || null;
  runtime.chainId = normalizeChainId(state.chainId);
  runtime.chainName = resolveChainName(runtime, runtime.chainId, state.chainName);

  if (runtime.providerSource !== injectedProvider) {
    runtime.provider = null;
    runtime.providerSource = null;
    runtime.signer = null;
  }
}

async function resolveWalletById(walletId) {
  const wallet = walletId
    ? await walletCore.resolveWalletById(walletId)
    : null;
  return wallet || null;
}

export function hasWalletSession() {
  return walletCore.hasWalletSession();
}

export async function getAvailableWallets(config = null) {
  const wallets = await walletCore.discoverWallets();
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
  await walletCore.discoverWallets();
  const injected = getInjectedProvider();
  if (!injected) throw new Error("No compatible wallet was detected in this browser.");

  runtime.injectedProvider = injected;
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

  await walletCore.connect({ walletId: wallet.id });
  applyCoreStateToRuntime(runtime);

  const provider = await ensureProvider(runtime);
  runtime.signer = await provider.getSigner();
  runtime.account = normalizeAddress(await runtime.signer.getAddress()) || runtime.account;
  const network = await provider.getNetwork();
  applyNetworkToRuntime(runtime, network);

  return runtime.account;
}

export async function disconnectWallet(runtime) {
  await walletCore.disconnect();
  applyCoreStateToRuntime(runtime);

  runtime.account = null;
  runtime.signer = null;

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
  let state = await walletCore.sync();
  let selectedWallet = state.selectedWalletId
    ? await resolveWalletById(state.selectedWalletId)
    : null;

  if (selectedWallet) {
    try {
      assertWalletSupported(runtime?.config, selectedWallet);
    } catch {
      await walletCore.disconnect();
      state = walletCore.getState();
      selectedWallet = null;
    }
  }

  applyCoreStateToRuntime(runtime, state);

  const injected = getInjectedProvider();
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

  if (!hasWalletSession() || !runtime.account) {
    runtime.account = null;
    runtime.signer = null;
    return;
  }

  runtime.signer = await provider.getSigner();
  runtime.account = normalizeAddress(await runtime.signer.getAddress()) || runtime.account;
}

function getRequestCapableProvider() {
  return getInjectedProvider();
}

export async function addConfiguredNetwork(config) {
  const injected = getRequestCapableProvider();
  if (!injected) throw new Error("No compatible wallet was detected.");
  if (!Number.isInteger(Number(config.chainId))) throw new Error("Configured chainId is required.");
  if (!config.networkName || !config.rpcUrl || !config.nativeCurrency) {
    throw new Error("Configured networkName, rpcUrl, and nativeCurrency are required.");
  }

  await addEthereumChain(injected, config);
}

export async function switchConfiguredNetwork(config) {
  const injected = getRequestCapableProvider();
  if (!injected) throw new Error("No compatible wallet was detected.");
  if (!Number.isInteger(Number(config.chainId))) throw new Error("Configured chainId is required.");

  await switchOrAddEthereumChain(injected, config);
}

export function bindWalletEvents({ onAccountsChanged, onChainChanged }) {
  return walletCore.subscribe(async (event) => {
    if (event === "accountChanged" || event === "disconnected") {
      if (onAccountsChanged) await onAccountsChanged();
      return;
    }

    if (event === "chainChanged") {
      if (onChainChanged) await onChainChanged();
    }
  });
}
