export function toChainIdHex(chainId) {
  const numericChainId = Number(chainId);
  if (!Number.isInteger(numericChainId) || numericChainId < 0) {
    throw new Error("chainId must be a non-negative integer.");
  }

  return `0x${numericChainId.toString(16)}`;
}

export const STORAGE_KEY = "liberdus-social-signup-ui-config";
export const WALLET_SESSION_KEY = "liberdus-social-signup-wallet-session";
export const X_AUTH_SESSION_KEY = "liberdus-social-signup-x-auth-session";
export const UI_ROOT = new URL("../../", import.meta.url);
export const CHAIN_NAME_BY_ID = {
  1: "Ethereum",
  10: "OP Mainnet",
  56: "BNB Smart Chain",
  97: "BNB Smart Chain Testnet",
  137: "Polygon",
  42161: "Arbitrum One",
  43114: "Avalanche C-Chain",
  8453: "Base",
  11155111: "Sepolia",
  1337: "Localhost 8545",
  31337: "Hardhat Local"
};

