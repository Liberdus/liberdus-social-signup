# Signup State Model

This document describes the signup state machine as implemented. It is meant to make wallet, social account, browser session, and saved signup behavior easier to reason about while the app is still evolving.

## Core Entities

The app tracks three different kinds of state:

- **Wallet connection**: frontend state from the injected wallet provider. This says which wallet address the browser currently has connected.
- **Signup browser session**: backend HttpOnly cookie plus server-side session state. This can hold a signed wallet proof for the current browser.
- **Saved signup**: database row created only after `Submit & Sign`.

No signup data is saved to the database until the final submit succeeds.

## Wallet And Browser Session States

| State | Backend / frontend facts | Expected UI |
| --- | --- | --- |
| No wallet connected | `runtime.account` is empty. | Only the wallet checklist item is actionable. Submit is disabled. |
| Wallet connected, not signed | Wallet address exists, but no `walletProof` exists in frontend state. | Wallet is checked, `Sign wallet to unlock checklist` is shown, socials are hidden. |
| Wallet signed | Backend signup session has `walletProof`; frontend has matching `runtime.walletProof`. | Social checklist is unlocked. |
| Reload or OAuth return after signing | Frontend memory was reset, but backend session still has wallet proof. | `/api/signup/session` restores the proof if the connected wallet matches the signed wallet. |
| Connected wallet changes | Current connected address no longer matches `walletProof.walletAddress`. | Wallet proof is cleared, social checklist is hidden, submit is disabled. |
| Signup browser session expires | Signup cookie is missing or unknown to the backend. | User must sign the wallet again. |

The frontend only accepts restored wallet proof when the connected wallet address matches the signed wallet proof address.

## Saved Signup States

| State | Meaning | Result |
| --- | --- | --- |
| No saved signup for wallet | The signed wallet has no DB row. | New signup flow. Button says `Submit & Sign`. |
| Saved signup exists for wallet | The signed wallet resolves to an existing signup. | Existing socials are loaded. Button says `Update & Sign`. |
| Saved signup loaded, same wallet | Current wallet matches the saved signup wallet. | User can add or change socials. |
| Saved signup loaded, different wallet | User entered the wallet replacement flow. | New wallet must be signed. Submit requires replacement confirmation. |
| Wallet points to one signup, session points to another | Existing accounts resolve to different signup ids. | Blocking conflict. Submit is disabled. |
| Social account belongs to another signup | Authenticated social account is already saved on a different signup. | Inline provider error. Submit is disabled. |

The database enforces uniqueness for wallet addresses and normalized social accounts. Frontend conflict checks are only early UX; final submit repeats the backend checks.

## Social Account States

Each first-class social provider can be in one of these states:

| State | Meaning | Result |
| --- | --- | --- |
| Not connected, not saved | No browser session and no saved account for this provider. | Incomplete. |
| Connected in browser, not saved | Provider session exists, but the signup has not been submitted with it. | Counts toward submit if it is X, Discord, Telegram, or LinkedIn. |
| Saved only | Account was loaded from a saved signup, but no current provider browser session exists. | Still counts as saved profile data. |
| Connected and same as saved | Current provider session matches saved account. | No replacement. |
| Connected and different from saved | Current provider session differs from saved account for the same signup. | Inline replacement warning; submit asks for confirmation. |
| Connected but owned by another signup | Current provider account is already linked to a different saved signup. | Blocking inline conflict; submit disabled. |
| Check failed or unknown | Provider account exists, but follow/join/star/subscription verification failed or was unavailable. | Account can remain connected; the specific task is incomplete or unknown. |

The required-social gate is satisfied by at least one of:

- X
- Discord
- Telegram
- LinkedIn

GitHub, YouTube, and CoinMarketCap are reward/profile tasks, not minimum-submit providers.

## Manual Claim States

Some actions are tracked as user claims because we cannot or do not automatically verify them in this form:

- X follow
- LinkedIn follow
- CoinMarketCap follow

Manual claims are local progress until submit. After submit, they are stored in verification JSON and, where applicable, attached to provider account verification history. These claims are intentionally distinct from verified checks.

## Submit Rules

`Submit & Sign` or `Update & Sign` is enabled only when all of these are true:

- A wallet is connected.
- The wallet has been signed in this signup browser session.
- At least one required social provider is connected or already saved.
- No blocking conflict exists.

On submit, the user signs a fresh wallet challenge. The backend then verifies:

- The challenge belongs to the current signup browser session.
- The signature matches the submitted wallet.
- The wallet and authenticated social accounts are not owned by another signup.
- Any requested replacements are confirmed.
- The minimum required-social rule is satisfied.

## Replacement Rules

Replacing an account is allowed only within a loaded existing signup.

| Replacement | Required proof |
| --- | --- |
| Social account replacement | User must have loaded or signed into the saved signup's wallet, then authenticate the new social account. |
| Wallet replacement | User must load the saved signup, choose `Change wallet`, connect the replacement wallet, sign it, then confirm replacement at submit. |

All confirmed replacements are written to `signup_account_replacements` as audit history.

## Endpoint Trust Boundaries

`GET /api/signup/session` is session-bound. It does not accept arbitrary provider user ids.

The endpoint derives state from:

- The backend signup browser session cookie.
- The signed wallet proof stored server-side for that session.
- Provider HttpOnly cookies from accounts authenticated in this browser.
- Database lookups against the full saved signup table.

It returns only safe status information such as provider conflict/replacement messages. It does not return the other signup's wallet address, signup id, or saved social details for cross-signup conflicts.

## E2E Coverage

The current e2e suite covers:

- Social checklist remains hidden until wallet ownership is signed.
- Signed wallet state survives reload.
- Signed wallet state survives a provider auth completion redirect.
- Expired signup session during provider return locks the checklist again.
- New signup with Discord.
- Manual follow claims persist after submit.
- Unsaved progress warning.
- Wallet change clears signed proof when unsaved socials exist.
- Saved socials load by signed wallet.
- Saved required social still permits update without a current provider session.
- Inline social replacement warning before submit.
- Saved social account replacement confirmation.
- Social account already linked to another signup is blocked before submit.
- Saved wallet replacement confirmation.

Third-party provider UI flows remain manual tests. E2E uses local test session helpers for provider cookies so automated tests exercise our session handling without depending on X, Discord, Telegram, LinkedIn, GitHub, YouTube, or CoinMarketCap availability.
