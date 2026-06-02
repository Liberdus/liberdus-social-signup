# Liberdus Wallet Core

`liberdus-wallet-core` is a small browser ESM wallet connection package. It is meant
to be imported into other projects without bringing along the old claim page,
contracts, Hardhat setup, Playwright tests, or app-specific Liberdus reward logic.

The package contains:

- `index.js`: public wallet core factory and UI exports
- `core/`: neutral wallet discovery and session state
- `adapters/`: optional helpers for chain switching and ethers v6
- `ui/`: a minimal connect button and wallet picker dropdown
- `demo.html`: repo-only browser demo for testing the UI

The wallet core supports injected EIP-1193 wallets, including EIP-6963 wallet
discovery when wallets provide it. It is not tied to MetaMask only.

## Import Paths

```js
import { createWalletCore } from "liberdus-wallet-core";
import { switchOrAddEthereumChain } from "liberdus-wallet-core/adapters/chain";
import { createBrowserProvider } from "liberdus-wallet-core/adapters/ethers";
import { createWalletConnectButton } from "liberdus-wallet-core/ui/wallet-connect";
```

For local browser testing from this repo, import from relative files instead:

```js
import { createWalletCore } from "./index.js";
import { createWalletConnectButton } from "./ui/wallet-connect.js";
```

## Core Only

Use the core when your app already has its own button, modal, state store, and
network policy.

```js
import { createWalletCore } from "liberdus-wallet-core";

const walletCore = createWalletCore({
  storage: window.localStorage,
  walletSessionKey: "my-app:wallet-session",
  discoveryWaitMs: 250,
});

const wallets = await walletCore.discoverWallets();
const selectedWallet = wallets[0];

if (!selectedWallet) {
  throw new Error("No compatible wallet was found.");
}

await walletCore.connect({ walletId: selectedWallet.id });

const state = walletCore.getState();
console.log(state.account, state.chainId);
```

Useful core methods:

- `discoverWallets()`: refresh and return available wallet descriptors
- `getAvailableWallets()`: return the current wallet list without waiting
- `connect({ walletId })`: prompt the selected wallet and store the session
- `disconnect()`: clear session state
- `sync()`: restore a previous wallet session with `eth_accounts`
- `getState()`: read account, chain, selected wallet, and provider state
- `getEip1193Provider()`: get the active raw injected provider
- `subscribe(handler)`: listen for wallet lifecycle events

## Chain Adapter

Use the chain adapter when your app wants to switch or add a configured EVM
network. The wallet core does not make network decisions for you.

```js
import { createWalletCore } from "liberdus-wallet-core";
import { switchOrAddEthereumChain } from "liberdus-wallet-core/adapters/chain";

const walletCore = createWalletCore();
const wallets = await walletCore.discoverWallets();

await walletCore.connect({ walletId: wallets[0].id });

await switchOrAddEthereumChain(walletCore.getEip1193Provider(), {
  chainId: 56,
  chainName: "BNB Smart Chain",
  rpcUrls: ["https://bsc-dataseed.binance.org"],
  nativeCurrency: {
    name: "BNB",
    symbol: "BNB",
    decimals: 18,
  },
  blockExplorerUrls: ["https://bscscan.com"],
});
```

The chain adapter exports:

- `toChainIdHex(chainId)`
- `addEthereumChain(provider, config)`
- `switchEthereumChain(provider, chainId)`
- `switchOrAddEthereumChain(provider, config)`

## Ethers Adapter

Use the ethers adapter if the consuming project uses ethers v6 and wants a
`BrowserProvider` after connecting.

```js
import { ethers } from "ethers";
import { createWalletCore } from "liberdus-wallet-core";
import { createBrowserProvider } from "liberdus-wallet-core/adapters/ethers";

const walletCore = createWalletCore();
const wallets = await walletCore.discoverWallets();

await walletCore.connect({ walletId: wallets[0].id });

const provider = createBrowserProvider(walletCore.getEip1193Provider(), ethers);
const signer = await provider.getSigner();
```

If `ethers` is loaded globally in a browser, the second argument is optional.

## Minimal UI

Use the UI when you want a ready-to-drop-in connect button with a small wallet
selection dropdown.

```html
<div id="walletButton"></div>

<script type="module">
  import { createWalletConnectButton } from "liberdus-wallet-core/ui/wallet-connect";

  createWalletConnectButton({
    target: document.getElementById("walletButton"),
    buttonLabel: "Connect Wallet",
    onConnect({ account, state }) {
      console.log("connected", account, state.chainId);
    },
    onDisconnect() {
      console.log("disconnected");
    },
    onError(error) {
      console.error(error);
    },
  });
</script>
```

The UI renders:

- a `Connect Wallet` button
- a dropdown of discovered wallets
- the wallet prompt after selection
- the shortened connected address only, such as `0x24f5...CDD4`
- a disconnect menu while connected

The UI accepts an existing core if your app wants to configure storage or share
wallet state with other code:

```js
import {
  createWalletCore,
  createWalletConnectButton,
} from "liberdus-wallet-core";

const walletCore = createWalletCore({
  walletSessionKey: "my-app:wallet-session",
});

createWalletConnectButton({
  target: document.querySelector("#walletButton"),
  walletCore,
});
```

## Modify the UI CSS

The UI injects a small style tag into the page. You can override it with a later
inline `<style>` block in the consuming app.

```html
<style>
  .liberdus-wallet-connect__button {
    min-height: 40px;
    padding: 0 14px;
    border-radius: 6px;
    background: #0f766e;
    box-shadow: none;
  }

  .liberdus-wallet-connect__button:hover {
    background: #115e59;
  }

  .liberdus-wallet-connect__menu {
    width: 280px;
    border-color: #99f6e4;
  }

  .liberdus-wallet-connect__icon {
    border-radius: 6px;
    background: #ccfbf1;
    color: #134e4a;
  }
</style>
```

You can also scope overrides to a wrapper:

```html
<div class="header-wallet">
  <div id="walletButton"></div>
</div>

<style>
  .header-wallet .liberdus-wallet-connect__button {
    background: #111827;
    font-size: 13px;
  }

  .header-wallet .liberdus-wallet-connect__menu {
    right: 0;
    left: auto;
  }
</style>
```

## Custom Element Option

If a project prefers declarative markup, register the provided custom element:

```html
<liberdus-wallet-connect button-label="Connect Wallet"></liberdus-wallet-connect>

<script type="module">
  import { defineWalletConnectElement } from "liberdus-wallet-core/ui/wallet-connect";

  defineWalletConnectElement();
</script>
```

## Local Demo

From this repo, serve the directory and open `demo.html`:

```bash
python3 -m http.server 4174 --bind 127.0.0.1
```

Then visit:

```text
http://127.0.0.1:4174/demo.html
```

The demo is intentionally tiny. It only shows the wallet button/dropdown and logs
connect/disconnect events.
