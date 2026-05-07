import { createWalletDiscovery } from "./core/discovery.js";
import { createWalletSession } from "./core/session.js";

export const DEFAULT_WALLET_SESSION_KEY = "liberdus-wallet-module:walletSession";

export function createWalletCore({
  storage = typeof window !== "undefined" ? window.localStorage : null,
  walletSessionKey = DEFAULT_WALLET_SESSION_KEY,
  discoveryWaitMs = 250,
} = {}) {
  const discovery = createWalletDiscovery({ discoveryWaitMs });
  const session = createWalletSession({
    discovery,
    storage,
    walletSessionKey,
  });

  return {
    discoverWallets: discovery.discoverWallets,
    getAvailableWallets: discovery.getAvailableWallets,
    resolveWalletById: discovery.resolveWalletById,
    getEip1193Provider: discovery.getInjectedProvider,
    applyActiveWallet: discovery.applyActiveWallet,
    connect: session.connect,
    disconnect: session.disconnect,
    sync: session.sync,
    getState: session.getState,
    hasWalletSession: session.hasWalletSession,
    subscribe: session.subscribe,
  };
}

export {
  createWalletConnectButton,
  defineWalletConnectElement,
} from "./ui/wallet-connect.js";
