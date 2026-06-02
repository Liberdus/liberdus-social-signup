export function toChainIdHex(chainId) {
  const numericChainId = Number(chainId);
  if (!Number.isInteger(numericChainId) || numericChainId < 0) {
    throw new Error("chainId must be a non-negative integer.");
  }

  return `0x${numericChainId.toString(16)}`;
}

function assertProvider(provider) {
  if (!provider || typeof provider.request !== "function") {
    throw new Error("An EIP-1193 provider with request() is required.");
  }
}

function normalizeChainConfig(config = {}) {
  const chainIdHex = toChainIdHex(config.chainId);
  const chainName = config.chainName || config.networkName;
  const rpcUrls = Array.isArray(config.rpcUrls)
    ? config.rpcUrls.filter(Boolean)
    : [config.rpcUrl].filter(Boolean);
  const blockExplorerUrls = Array.isArray(config.blockExplorerUrls)
    ? config.blockExplorerUrls.filter(Boolean)
    : [config.blockExplorerUrl].filter(Boolean);

  if (!chainName || rpcUrls.length === 0 || !config.nativeCurrency) {
    throw new Error("chainName, rpcUrls, and nativeCurrency are required to add a chain.");
  }

  return {
    chainId: chainIdHex,
    chainName,
    rpcUrls,
    nativeCurrency: config.nativeCurrency,
    ...(blockExplorerUrls.length > 0 ? { blockExplorerUrls } : {}),
  };
}

export async function addEthereumChain(provider, config) {
  assertProvider(provider);

  await provider.request({
    method: "wallet_addEthereumChain",
    params: [normalizeChainConfig(config)],
  });
}

export async function switchEthereumChain(provider, chainId) {
  assertProvider(provider);

  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: toChainIdHex(chainId) }],
  });
}

export async function switchOrAddEthereumChain(provider, config) {
  try {
    await switchEthereumChain(provider, config?.chainId);
  } catch (error) {
    if (error?.code !== 4902) {
      throw error;
    }

    await addEthereumChain(provider, config);
    await switchEthereumChain(provider, config.chainId);
  }
}
