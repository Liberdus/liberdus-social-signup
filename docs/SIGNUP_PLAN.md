# Liberdus Social Rewards Signup Plan

## Goal

Replace the old Google Form flow with a signup website that collects reward-campaign account proofs while making spam more expensive:

- Require wallet connection and an EIP-191 message signature to prove wallet ownership.
- Require at least one connected account from Telegram, Discord, or LinkedIn.
- Present signup as a checklist of required and optional account proofs instead of a general-purpose form.
- Support optional X, GitHub, and YouTube sign-ins.
- Provide a CoinMarketCap follow link as an unverified optional action.
- Store submissions in a backend database.
- Keep the frontend static so it can be hosted through GitHub Pages.
- Keep admin simpler than the airdrop app because there is no smart contract or owner-wallet control path.

## Current Implementation

As of May 8, 2026, this repository contains a working local MVP:

- `frontend/index.html`: public signup page.
- `frontend/admin/`: password-protected admin review page.
- `backend/server.js`: Node HTTP API for wallet-signature challenges, signup submission, X OAuth, admin login, list, and CSV export.
- `backend/lib/db.js`: SQLite initialization.
- `backend/lib/signup-store.js`: signup persistence and export.
- `backend/lib/social/`: one backend provider module per social integration.
- `frontend/js/checklist-providers/`: one frontend checklist definition per social or external action.
- `vendor/liberdus-wallet-module`: temporary local copy from `Liberdus/liberdus-wallet-module` branch `base_branch`.

Implemented provider state:

- Required: wallet ownership by EIP-191 signature.
- Required-choice: at least one connected account from Telegram, Discord, or LinkedIn.
- Optional: X sign-in, GitHub sign-in plus repo star check, YouTube/Google sign-in plus channel subscription check.
- Optional external action: CoinMarketCap follow link, not API-verified.
- Discord and Telegram membership checks are implemented when guild/chat configuration is present.
- Existing signup lookup works for verified wallet and is checked on final submit for linked X/required social accounts.
- Admin list/search/export is implemented with safe DOM rendering.
- SQLite storage uses one signup row plus normalized social account and verification rows.

The frontend reuses the Liberdus rewards visual style, logo assets, injected-wallet discovery, wallet picker, and OAuth helpers. Contract, Merkle proof, token transfer, airdrop round, and owner-wallet admin code were intentionally not copied into the main app.

## Architecture

Frontend:

- Static HTML/CSS/ES modules hosted by GitHub Pages.
- Reads `frontend/config.json` for backend URL and social links.
- Uses the temporary vendored wallet module or shared wallet helpers until the GitHub Pages-hosted wallet module is available.
- Calls backend APIs with credentials for social-session cookies and CSRF headers.
- Main signup page is a checklist:
  - Wallet ownership, required.
  - At least one of Discord, Telegram, or LinkedIn sign-in, required.
  - X sign-in, optional.
  - GitHub sign-in and Liberdus repo star check, optional.
  - YouTube sign-in and Liberdus channel subscription check, optional.
  - CoinMarketCap follow link, optional and not API-verified.
- Checklist rows are data-driven from `frontend/js/checklist-providers/`.
- Wallet connect is inline with the checklist.
- Signup state should load after a user proves control of an existing wallet or previously linked account.

Backend:

- Node HTTP server, intentionally similar to the rewards backend deployment model.
- SQLite for MVP storage.
- OAuth and bot secrets stay server-side.
- Social backends are added through `backend/lib/social/{provider}.js` and registered in `backend/lib/social/index.js`.
- Backend should support an anonymous browser signup session so wallet proof can happen before or after social sign-in.
- Admin authentication uses `ADMIN_USERNAME` and `ADMIN_PASSWORD` from `.env`, returning a short-lived admin token.
- Future production option: put the API behind a reverse proxy with TLS, rate limits, backups, and monitoring.

Database:

- `signups` table keyed by signup ID for wallet proof, optional X summary fields, status, timestamps, user agent, and IP.
- Unique X user ID and unique wallet address reduce duplicate/spam submissions.
- `signup_social_accounts` stores one row per connected account with provider, provider user ID, username/display name, profile/avatar URL, connected timestamp, and raw normalized profile JSON.
- `signup_social_verifications` stores one row per verification check, such as `x_verified`, `discord_guild_member`, `telegram_group_member`, and `linkedin_authenticated`.
- `verification_json` remains as a compatibility snapshot, but normalized social account/check rows are the long-term source for search, filtering, audit history, and account replacement.
- Explicit account replacement history is not implemented yet and remains a launch-followup requirement.

## Required Signup Flow

1. User opens GitHub Pages signup page.
2. User sees a checklist of required and optional tasks.
3. User completes required wallet ownership and at least one required social sign-in from Telegram, Discord, or LinkedIn in any order.
4. Wallet row:
   - User connects a wallet.
   - Frontend asks backend for a wallet challenge tied to the current browser signup session.
   - User signs the challenge with the connected wallet.
   - Backend verifies the signature and can look up an existing signup for that wallet.
5. Required social row:
   - User signs in with Telegram, Discord, or LinkedIn.
   - Backend stores the selected social session cookie.
   - Discord and Telegram may also perform membership checks when configured, but the current required gate is account connection.
6. X row:
   - User signs in with X.
   - Backend stores an X session cookie and CSRF token.
   - Backend can look up an existing signup for that X user ID.
7. User optionally signs in with X, GitHub, and YouTube.
8. User optionally opens the CoinMarketCap follow link.
9. On final submit, backend verifies:
   - Wallet challenge belongs to the current browser signup session.
   - Submitted wallet equals challenged wallet.
   - Signature recovers the submitted wallet.
   - At least one current browser session exists for Telegram, Discord, or LinkedIn.
   - Optional Discord, Telegram, LinkedIn, GitHub, and YouTube identities belong to the current browser session.
10. Backend saves or rejects the signup.

## Existing Signup Lookup

The app should load an existing signup when the user proves control of a previously linked account:

- Wallet lookup: after wallet signature verification, backend may return any signup linked to that wallet address.
- X lookup: after successful X sign-in, backend may return any signup linked to that X user ID.
- Required social lookup: final submit checks whether the connected Telegram, Discord, or LinkedIn account is already linked to a signup.
- Do not reveal full signup details from a wallet address alone. The user must prove wallet ownership first.
- If wallet and connected social accounts are linked to the same signup, the checklist loads that signup normally.
- If wallet, X, or connected social accounts belong to different existing signups, the UI must stop and show a conflict instead of merging silently.

## Account Replacement

Account replacement is wanted but needs a deliberate workflow before launch.

Open design:

- User should be able to replace an optional social account after loading their existing signup.
- User may also need a way to replace wallet or primary social accounts, but that is higher risk because those are the main anti-duplicate anchors.
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

Current approach:

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

- Discord OAuth is a required-choice provider.
- Request `identify` and `guilds.members.read`.
- Check the configured Liberdus guild ID via the current-user guild member endpoint.
- Store Discord user ID, username/global name, avatar if useful, and membership status.
- Show Discord as a required-choice checklist item. It says whether the account is connected and whether server membership was confirmed.

### Telegram

Feasible, with bot constraints. Telegram is a required-choice provider, and the local test setup now uses the Telegram Login Widget plus a bot-backed group membership check.

- Telegram Login or the Telegram Login Widget can authenticate a Telegram user and requires a Telegram bot: https://core.telegram.org/bots/telegram-login and https://core.telegram.org/widgets/login
- To verify group/channel membership, the backend can use Bot API membership lookups such as `getChatMember`, but the bot must have sufficient access to the group/channel.

Current approach:

- Add Telegram Login as a required-choice provider using the signed Login Widget payload for the current local/static frontend flow.
- Store Telegram user ID, username, display name, and profile image if provided.
- Use the bot token server-side to check membership in the configured Liberdus group/channel.
- Confirm bot permissions during setup before making Telegram membership required.
- The Liberdus bot must be in the target group/channel. Admin rights are preferred because Telegram only guarantees reliable `getChatMember` checks for other users when the bot is an administrator.
- Local test values are configured with `TELEGRAM_BOT_USERNAME`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `TELEGRAM_INVITE_URL`.

### LinkedIn

Feasible for sign-in, limited for follow/company checks. LinkedIn is a required-choice provider.

- LinkedIn supports Sign In with LinkedIn using OpenID Connect and returns profile/email claims: https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
- The same Microsoft/LinkedIn docs note this sign-in product should not be marketed as identity verification.
- General "does this person follow our LinkedIn page?" checks are not available through basic Sign In with LinkedIn. That usually requires partner/marketing API access and may not be practical for a rewards signup.

Current approach:

- Add LinkedIn OIDC sign-in as a required-choice provider.
- Store LinkedIn subject ID, name, profile picture if returned, email only if returned and needed, and authentication timestamp.
- Do not rely on LinkedIn follow verification unless Liberdus obtains the needed LinkedIn API product access.
- Show LinkedIn as a connected account, not as a verified follow task.
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
- Add captcha or turnstile if spam continues despite wallet and social account requirements.
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

1. Run local end-to-end signup with wallet plus each required-choice provider: Discord, Telegram, and LinkedIn.
2. Confirm production OAuth redirect URLs and bot/guild/chat IDs for the final frontend and backend domains.
3. Decide whether Discord/Telegram membership should be required or remain a visible secondary verification under the required account connection.
4. Design and implement explicit account replacement with audit history.
5. Add admin status editing and audit log.
6. Add IP and account-level rate limits before public launch.
7. Add database backup/restore process.
8. Add privacy notice and retention policy.
9. Add background X follow verification and cached verification results if X remains valuable as an optional signal.
10. Deploy backend to the selected server and GitHub Pages frontend to the final URL.
