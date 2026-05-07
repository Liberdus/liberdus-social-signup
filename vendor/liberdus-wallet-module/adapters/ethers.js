export function createBrowserProvider(injectedProvider, ethersModule = globalThis.ethers) {
  if (!injectedProvider) {
    throw new Error("No injected provider was available to create an ethers provider.");
  }
  if (!ethersModule?.BrowserProvider) {
    throw new Error("An ethers v6 module with BrowserProvider is required.");
  }

  return new ethersModule.BrowserProvider(injectedProvider);
}
