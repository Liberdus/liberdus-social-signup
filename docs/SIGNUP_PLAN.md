# Liberdus Social Rewards Signup Plan

## Goal

Replace the old Google Form flow with a signup website that collects reward-campaign account proofs while making spam more expensive:

- Require wallet connection and an EIP-191 message signature to prove wallet ownership.
- Require X sign-in to prove the user controls the submitted X account.
- Present signup as a checklist of required and optional account proofs instead of a general-purpose form.
- Support optional Discord, Telegram, LinkedIn, GitHub, and YouTube sign-ins.
- Provide a CoinMarketCap follow link as an unverified optional action.
- Store submissions in a backend database.
- Keep the frontend static so it can be hosted through GitHub Pages.
- Keep admin simpler than the airdrop app because there is no smart contract or owner-wallet control path.

## Current Scaffold

This repository contains an MVP structure:

- `frontend/index.html`: public signup page.
- `frontend/admin/`: password-protected admin review page.
- `backend/server.js`: Node HTTP API for X OAuth, wallet-signature challenges, signup submission, admin login, list, and CSV export.
- `backend/lib/db.js`: SQLite initialization.
- `backend/lib/signup-store.js`: signup persistence and export.
- `backend/lib/social/`: one backend provider module per optional social integration.
- `frontend/js/checklist-providers/`: one frontend checklist definition per optional social or external action.
- `vendor/liberdus-wallet-module`: temporary local copy from `Liberdus/liberdus-wallet-module` branch `base_branch`.

The frontend reuses the Liberdus rewards visual style, logo assets, injected-wallet discovery, wallet picker, and X OAuth client helper. Contract, Merkle proof, token transfer, airdrop round, and owner-wallet admin code were intentionally not copied into the main app.

The current scaffold is being reshaped from the original broad details form into a checklist where each row is either a verified account connection or a clearly labeled external action.

## Proposed Architecture

Frontend:

- Static HTML/CSS/ES modules hosted by GitHub Pages.
- Reads `frontend/config.json` for backend URL and social links.
- Uses the temporary vendored wallet module or shared wallet helpers until the GitHub Pages-hosted wallet module is available.
- Calls backend APIs with credentials for social-session cookies and CSRF headers.
- Main signup page is a checklist:
  - Wallet ownership, required.
  - X sign-in, required.
  - Discord sign-in and server membership, optional.
  - Telegram sign-in and group/channel membership, optional.
  - LinkedIn sign-in, optional.
  - GitHub sign-in and Liberdus repo star check, optional.
  - YouTube sign-in and Liberdus channel subscription check, optional.
  - CoinMarketCap follow link, optional and not API-verified.
- Optional checklist rows should be data-driven from `frontend/js/checklist-providers/`, not hand-coded into `frontend/index.html`.
- Wallet connect belongs inline with the checklist, not in the top navigation.
- Signup state should load after a user proves control of either an existing X account or an existing wallet.

Backend:

- Node HTTP server, intentionally similar to the rewards backend deployment model.
- SQLite for MVP storage.
- OAuth and bot secrets stay server-side.
- Optional social backends should be added through `backend/lib/social/{provider}.js` and registered in `backend/lib/social/index.js`.
- Backend should support an anonymous browser signup session so wallet proof can happen before or after X sign-in.
- Admin authentication uses `ADMIN_USERNAME` and `ADMIN_PASSWORD` from `.env`, returning a short-lived admin token.
- Future production option: put the API behind a reverse proxy with TLS, rate limits, backups, and monitoring.

Database:

- `signups` table keyed by signup ID for wallet proof, required X/wallet summary fields, status, timestamps, user agent, and IP.
- Unique X user ID and unique wallet address reduce duplicate/spam submissions.
- `signup_social_accounts` stores one row per connected account with provider, provider user ID, username/display name, profile/avatar URL, connected timestamp, and raw normalized profile JSON.
- `signup_social_verifications` stores one row per verification check, such as `x_verified`, `discord_guild_member`, `telegram_group_member`, and `linkedin_authenticated`.
- `verification_json` remains as a compatibility snapshot, but normalized social account/check rows are the long-term source for search, filtering, audit history, and account replacement.
- Should support explicit account replacement history so changes are visible and auditable.

## Required Signup Flow

1. User opens GitHub Pages signup page.
2. User sees a checklist of required and optional tasks.
3. User completes required wallet ownership and X sign-in in either order.
4. Wallet row:
   - User connects a wallet.
   - Frontend asks backend for a wallet challenge tied to the current browser signup session.
   - User signs the challenge with the connected wallet.
   - Backend verifies the signature and can look up an existing signup for that wallet.
5. X row:
   - User signs in with X.
   - Backend stores an X session cookie and CSRF token.
   - Backend can look up an existing signup for that X user ID.
6. User optionally signs in with Discord, Telegram, LinkedIn, GitHub, and YouTube.
7. User optionally opens the CoinMarketCap follow link.
8. On final submit, backend verifies:
   - Valid X session.
   - Valid CSRF token.
   - Wallet challenge belongs to the current browser signup session.
   - Submitted wallet equals challenged wallet.
   - Signature recovers the submitted wallet.
   - Optional Discord, Telegram, LinkedIn, GitHub, and YouTube identities belong to the current browser session.
9. Backend saves or rejects the signup.

## Existing Signup Lookup

The app should load an existing signup when the user proves control of a previously linked required account:

- X lookup: after successful X sign-in, backend may return any signup linked to that X user ID.
- Wallet lookup: after wallet signature verification, backend may return any signup linked to that wallet address.
- Do not reveal full signup details from a wallet address alone. The user must prove wallet ownership first.
- If both X and wallet are linked to the same signup, the checklist loads that signup normally.
- If X and wallet belong to different existing signups, the UI must stop and show a conflict instead of merging silently.

## Account Replacement

Account replacement is wanted but needs a deliberate workflow before launch.

Open design:

- User should be able to replace an optional social account after loading their existing signup.
- User may also need a way to replace a required X account or wallet, but that is higher risk because those are the primary anti-duplicate anchors.
- Replacements must never be silent. The UI should show the current linked account, the newly authenticated account, and require an explicit confirmation such as "Replace @old with @new".
- Backend should record old value, new value, timestamp, IP/user agent, and which verified session authorized the change.
- If the new account is already linked to another signup, backend should reject the replacement and show a clear conflict.
- Admin should be able to see replacement history before account replacement becomes broadly available.

## Social Verification Feasibility

### X

Feasible for identity and likely feasible for follow checks, subject to current X API access, pricing, and rate limits.

- X sign-in proves account control.
- X API follows endpoints include `GET /2/users/:id/following` and `GET /2/users/:id/followers`, documented in the X follows API docs: https://docs.x.com/x-api/users/follows/introduction
- User lookup endpoints include authenticated-user and username/id lookup: https://docs.x.com/x-api/users/lookup/introduction

Recommended approach:

- Store authenticated X user ID.
- Store Liberdus target account IDs in backend config.
- Use a background verification job to check whether each signup follows required Liberdus accounts.
- Cache results because follow-list endpoints are paginated and rate-limited.

### Discord

Feasible to prove account ownership and verify server membership.

- Discord OAuth `identify` gives the user profile.
- `guilds` can list current user guilds.
- `guilds.members.read` supports `GET /users/@me/guilds/{guild.id}/member`, which returns member information for the current user. Discord documents this in the User Resource docs: https://docs.discord.com/developers/resources/user

Recommended approach:

- Add Discord OAuth as optional.
- Request `identify` and `guilds.members.read`.
- Check the configured Liberdus guild ID via the current-user guild member endpoint.
- Store Discord user ID, username/global name, avatar if useful, and membership status.
- Show Discord as an optional checklist item. It should say whether the account is connected and whether server membership was confirmed.

### Telegram

Feasible, with bot constraints. Telegram remains optional, but the local test setup now uses the Telegram Login Widget plus a bot-backed group membership check.

- Telegram Login or the Telegram Login Widget can authenticate a Telegram user and requires a Telegram bot: https://core.telegram.org/bots/telegram-login and https://core.telegram.org/widgets/login
- To verify group/channel membership, the backend can use Bot API membership lookups such as `getChatMember`, but the bot must have sufficient access to the group/channel.

Recommended approach:

- Add Telegram Login as optional using the signed Login Widget payload for the current local/static frontend flow.
- Store Telegram user ID, username, display name, and profile image if provided.
- Use the bot token server-side to check membership in the configured Liberdus group/channel.
- Confirm bot permissions during setup before making Telegram membership required.
- The Liberdus bot must be in the target group/channel. Admin rights are preferred because Telegram only guarantees reliable `getChatMember` checks for other users when the bot is an administrator.
- Local test values are configured with `TELEGRAM_BOT_USERNAME`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `TELEGRAM_INVITE_URL`.

### LinkedIn

Feasible for sign-in, limited for follow/company checks.

- LinkedIn supports Sign In with LinkedIn using OpenID Connect and returns profile/email claims: https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
- The same Microsoft/LinkedIn docs note this sign-in product should not be marketed as identity verification.
- General "does this person follow our LinkedIn page?" checks are not available through basic Sign In with LinkedIn. That usually requires partner/marketing API access and may not be practical for a rewards signup.

Recommended approach:

- Add LinkedIn OIDC sign-in as optional.
- Store LinkedIn subject ID, name, profile picture if returned, email only if returned and needed, and authentication timestamp.
- Do not rely on LinkedIn follow verification unless Liberdus obtains the needed LinkedIn API product access.
- Show LinkedIn as an optional connected account, not as a verified follow task.
- Local implementation uses backend-owned OAuth with `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, and `LINKEDIN_OAUTH_CALLBACK_URL`.

### GitHub

Feasible for sign-in and for verifying that the authenticated user starred a public repository.

- GitHub OAuth proves the user controls the GitHub account.
- The REST API supports checking whether the authenticated user starred a repo with `GET /user/starred/{owner}/{repo}`. GitHub documents this endpoint here: https://docs.github.com/en/rest/activity/starring?apiVersion=2022-11-28#check-if-a-repository-is-starred-by-the-authenticated-user
- The current target repo is `Liberdus/web-client-v2`, and the org follow link is `https://github.com/Liberdus`.
- Org follow verification is not part of the current implementation because the repo star is the higher-value signal.

Recommended approach:

- Add GitHub OAuth as optional.
- Request the minimum practical scopes, starting with `read:user`.
- Store GitHub user ID, username, display name, profile URL, avatar URL, authentication timestamp, and repo-star check result.
- Recheck the repo star when the GitHub session is loaded so a user can star the repo after signing in and then recheck.
- Keep GitHub access tokens short-lived and server-side only; do not serialize them to the frontend or database.
- Local implementation uses `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_OAUTH_CALLBACK_URL`, `GITHUB_TARGET_REPO`, `GITHUB_TARGET_ORG`, and `GITHUB_OAUTH_SCOPES`.

### YouTube

Feasible for Google account sign-in and likely feasible for checking whether the authenticated user is subscribed to the Liberdus channel.

- YouTube sign-in uses Google OAuth for web server applications and keeps the client secret server-side.
- The YouTube Data API `channels.list` endpoint supports resolving a channel by handle with `forHandle`, so `https://www.youtube.com/@Liberdus` can resolve to a channel ID.
- The YouTube Data API `subscriptions.list` endpoint supports `mine=true` for the authenticated user's subscriptions and `forChannelId` to filter to the Liberdus channel.
- Public launch may require Google app verification because `https://www.googleapis.com/auth/youtube.readonly` is a sensitive scope. Local testing can use the OAuth consent screen's test-user mode.

Recommended approach:

- Add YouTube/Google OAuth as optional.
- Request `openid profile https://www.googleapis.com/auth/youtube.readonly`.
- Store Google subject ID, display name, profile image, authentication timestamp, target channel, and subscription check result.
- Recheck the subscription when the YouTube session is loaded so a user can subscribe after signing in and then recheck.
- Keep YouTube access tokens short-lived and server-side only; do not serialize them to the frontend or database.
- Local implementation uses `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_OAUTH_CALLBACK_URL`, `YOUTUBE_TARGET_CHANNEL_HANDLE`, `YOUTUBE_TARGET_CHANNEL_ID`, `YOUTUBE_TARGET_CHANNEL_URL`, and `YOUTUBE_OAUTH_SCOPES`.

### CoinMarketCap

CoinMarketCap should be an optional external follow action, not a verified login.

- Public CoinMarketCap Pro API authentication is API-key based and intended for market/community data, not end-user OAuth login.
- Public CMC community/content endpoints expose trending topics/tokens and posts/comments, not a documented way to prove that a particular CMC user follows Liberdus.

Recommended approach:

- Add a checklist row with a link to the Liberdus CoinMarketCap page/community profile.
- Label it as an external follow link.
- Do not block signup on this action.
- Do not require CMC comments or screenshot uploads in the MVP.

## Admin Plan

MVP:

- Username/password login backed by `.env`.
- List submissions.
- Search by X username, X ID, wallet, and linked social identities.
- Export CSV.

Later:

- Submission status editing: `received`, `eligible`, `rejected`, `duplicate`, `needs_review`.
- Verification columns for each required social task.
- Account replacement history.
- Manual notes/history.
- Backup and restore commands.
- Admin audit log.
- Optional stronger admin auth using passkeys, Google Workspace, or a small allowlist.

## Backend Hardening

Before public launch:

- Add IP and account-level rate limits.
- Add captcha or turnstile if spam continues despite wallet and X requirements.
- Enforce production HTTPS and secure cookies.
- Add database backup automation.
- Add structured logs for signup, admin login, and verification events.
- Add a privacy notice and retention policy because the site collects social IDs, wallets, and optional contact data.
- Add admin status editing only after audit logging is present.

## Replacement Plan For Wallet Module

Current:

- Local vendored copy from `Liberdus/liberdus-wallet-module` branch `base_branch`.

Target:

- Serve the wallet module from a stable GitHub Pages URL.
- Replace local imports with the hosted module path or a small wrapper import.
- Keep the signup app wallet integration behind one local adapter so the swap is limited to one module.

## Next Implementation Steps

1. Configure X developer app callback URL and `.env`.
2. Run local end-to-end signup with a real X test account.
3. Fix current MVP correctness issues before expanding providers:
   - Bind X OAuth callback to the initiating browser.
   - Render admin table data safely without `innerHTML` interpolation.
   - Replace silent duplicate upsert behavior with explicit lookup/update/conflict handling.
4. Replace the broad details form with the checklist UI.
5. Move wallet connect into the checklist.
6. Add existing-signup lookup after verified X sign-in or verified wallet signature.
7. Add Discord OAuth as optional identity plus guild membership check.
8. Add Telegram Login as optional identity plus bot-backed group/channel membership check.
9. Add LinkedIn OIDC as optional sign-in only.
10. Add GitHub OAuth as optional identity plus repo-star check.
11. Add YouTube OAuth as optional identity plus channel subscription check.
12. Add CoinMarketCap external follow link.
13. Add background X follow verification and cached verification results.
14. Design and implement explicit account replacement with audit history.
15. Add admin status editing and audit log.
16. Deploy backend to the selected server and GitHub Pages frontend to the final URL.
