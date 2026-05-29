# Production Social API Setup

This checklist is for replacing personal/test social apps with production-owned Liberdus accounts before deployment.

Use organization-owned accounts wherever the platform allows it. Store all secrets in the production environment or secret manager, not in `frontend/config.json`, not in Git, and not in shared notes.

## Production URLs To Decide First

Pick the final public URLs before creating provider apps. Most providers require exact callback URLs.

| Placeholder | Meaning | Example |
| --- | --- | --- |
| `<FRONTEND_ORIGIN>` | Static signup site origin | `https://liberdus.com` |
| `<FRONTEND_URL>` | Full signup page URL | `https://liberdus.com/social/` |
| `<BACKEND_URL>` | Public HTTPS API origin | `https://att.liberdus.com/social-signup` |

Current Liberdus production target:

```text
<FRONTEND_ORIGIN>=https://liberdus.com
<FRONTEND_URL>=https://liberdus.com/social/
<BACKEND_URL>=https://att.liberdus.com/social-signup
```

Backend `.env` values that must match those URLs:

```dotenv
SIGNUP_ALLOWED_ORIGINS=<FRONTEND_ORIGIN>
SIGNUP_FRONTEND_RETURN_URL=<FRONTEND_URL>
SIGNUP_FRONTEND_RETURN_URLS=<FRONTEND_URL>
SIGNUP_COOKIE_SECURE=true
```

If the backend runs behind nginx, Caddy, Cloudflare, or another trusted proxy, keep `SIGNUP_HOST=127.0.0.1`, set `SIGNUP_PORT` to the internal API port, and set `SIGNUP_TRUST_PROXY=true` only if that proxy sanitizes `X-Forwarded-For` / `X-Real-IP`.

Frontend `frontend/config.json` should point at the production backend and public social links:

```json
{
  "apiBaseUrl": "<BACKEND_URL>",
  "xAuth": {
    "enabled": true,
    "backendUrl": "<BACKEND_URL>",
    "redirectUri": "<FRONTEND_URL>"
  }
}
```

The backend publishes safe provider config through `/api/public/config`, but `apiBaseUrl`, `xAuth.backendUrl`, `xAuth.redirectUri`, and the static `socialLinks` should still be correct in the deployed frontend file.

## Provider Summary

| Provider | Current app behavior | Production setup required |
| --- | --- | --- |
| X | OAuth 1.0a sign-in. X follow is stored as a manual claim. | X developer app with API key/secret and backend callback URL. |
| Telegram | Telegram Login Widget sign-in. Optional bot-backed group/channel membership check. | Telegram bot, linked frontend domain, bot token, optional chat ID and invite URL. |
| Discord | OAuth sign-in with optional server membership check. | Discord application with OAuth client ID/secret, redirect URL, guild ID, invite URL. |
| LinkedIn | OpenID Connect sign-in. LinkedIn follow is stored as a manual claim. | LinkedIn developer app with Sign In with LinkedIn using OpenID Connect. |
| GitHub | OAuth sign-in plus target repo star check. | GitHub OAuth app and target org/repo settings. |
| YouTube | Google OAuth sign-in plus YouTube channel subscription check. | Google Cloud project, OAuth client, YouTube Data API v3, OAuth verification if public. |
| CoinMarketCap | External follow link only. | No app credentials. Set final profile link. |

## X

Current backend route: `<BACKEND_URL>/api/x/callback`

Production ownership:

- Use a Liberdus-controlled X developer account and X app.
- Save the API key and API secret in the production backend secret store.
- Do not use personal access tokens for this app. The signup flow obtains user tokens through 3-legged OAuth.

X developer setup:

1. Create or open the production app in the X Developer Console.
2. Enable OAuth 1.0a user authentication for the app.
3. Add this callback URL exactly: `<BACKEND_URL>/api/x/callback`.
4. Configure the app website/terms/privacy URLs with production Liberdus URLs if the portal requires them.
5. Copy the app API key and API secret.

Backend `.env`:

```dotenv
X_API_KEY=<production X API key>
X_API_SECRET=<production X API secret>
X_OAUTH1_CALLBACK_URL=<BACKEND_URL>/api/x/callback
```

Frontend:

```json
"xAuth": {
  "enabled": true,
  "backendUrl": "<BACKEND_URL>",
  "redirectUri": "<FRONTEND_URL>"
},
"socialLinks": {
  "x": "https://x.com/liberdus"
}
```

Notes:

- The app verifies that the user controls the X account and records the profile's X `verified` flag when returned.
- The X follow task is not API-verified in this app. It is stored as `x_follow_manual` with status `claimed`.
- X API access level/pricing can affect whether the production app is allowed to use the needed endpoints.

Official references:

- [X API key and secret](https://docs.x.com/fundamentals/authentication/oauth-1-0a/api-key-and-secret)
- [X OAuth 1.0a overview](https://docs.x.com/fundamentals/authentication/oauth-1-0a/overview)
- [X developer apps](https://docs.x.com/resources/fundamentals/developer-apps)

## Telegram

Current backend verification route: `<BACKEND_URL>/api/telegram/verify`

Production ownership:

- Create the bot from a Liberdus-controlled Telegram account through `@BotFather`.
- Keep the bot token server-side only.
- If membership checking matters, make sure the bot can inspect the target group/channel membership.

Telegram setup:

1. In Telegram, message `@BotFather`.
2. Create a production bot, or transfer/use a bot controlled by Liberdus.
3. Set the bot name, username, description, and image to clearly match Liberdus.
4. Run BotFather `/setdomain` for the bot and set it to the signup frontend domain, not a local/test domain.
5. Copy the bot username and bot token.
6. If checking group/channel membership, add the bot to the target group/channel and collect the numeric or `@username` chat ID.
7. Set the public invite URL users should open if they are not already a member.

Backend `.env`:

```dotenv
TELEGRAM_BOT_USERNAME=<bot username without @>
TELEGRAM_BOT_TOKEN=<bot token>
TELEGRAM_CHAT_ID=<target group/channel id or @username>
TELEGRAM_INVITE_URL=<public Telegram invite/community URL>
```

Frontend:

```json
"telegramAuth": {
  "enabled": true,
  "botUsername": "<bot username without @>",
  "botId": "<numeric bot id>",
  "membershipConfigured": true
},
"socialLinks": {
  "telegram": "<public Telegram invite/community URL>"
}
```

Notes:

- The backend derives `botId` from `TELEGRAM_BOT_TOKEN` and publishes it through `/api/public/config`, so the static frontend does not need to hard-code it if the backend is reachable.
- The Login Widget proves control of the Telegram account using Telegram's signed login payload.
- `TELEGRAM_CHAT_ID` is optional for sign-in. Without it, membership is not checked.

Official references:

- [Telegram Login Widget](https://core.telegram.org/widgets/login)
- [Telegram Bot API](https://core.telegram.org/bots/api)

## Discord

Current backend callback URL: `<BACKEND_URL>/api/discord/callback`

Production ownership:

- Create the Discord application under a Liberdus-controlled Discord account/team.
- Use the official Liberdus server/guild for membership checks.

Discord developer setup:

1. Create a production application in the Discord Developer Portal.
2. In OAuth2 settings, add this redirect URL exactly: `<BACKEND_URL>/api/discord/callback`.
3. Copy the client ID and client secret.
4. Confirm the OAuth scopes used by this app: `identify guilds.members.read`.
5. Collect the target server/guild ID.
6. Set the public invite URL for the Liberdus Discord server.

Backend `.env`:

```dotenv
DISCORD_CLIENT_ID=<production client id>
DISCORD_CLIENT_SECRET=<production client secret>
DISCORD_OAUTH_CALLBACK_URL=<BACKEND_URL>/api/discord/callback
DISCORD_GUILD_ID=<target server/guild id>
DISCORD_INVITE_URL=<public invite URL>
```

Frontend:

```json
"discordAuth": {
  "enabled": true,
  "membershipConfigured": true
},
"socialLinks": {
  "discord": "<public invite URL>"
}
```

Notes:

- Discord sign-in proves control of the Discord account.
- `DISCORD_GUILD_ID` enables `/users/@me/guilds/{guild.id}/member` membership checking.
- If `DISCORD_GUILD_ID` is blank, sign-in still works, but the server membership check is not configured.

Official references:

- [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2)
- [Discord OAuth2 and permissions](https://docs.discord.com/developers/platform/oauth2-and-permissions)
- [Discord current user guild member](https://docs.discord.com/developers/resources/user)

## LinkedIn

Current backend callback URL: `<BACKEND_URL>/api/linkedin/callback`

Production ownership:

- Create the LinkedIn app from a Liberdus-controlled LinkedIn developer account.
- Associate it with the official Liberdus company page where LinkedIn requires company association.

LinkedIn developer setup:

1. Create a production app in the LinkedIn Developer Portal.
2. Request/add the "Sign In with LinkedIn using OpenID Connect" product.
3. Add this authorized redirect URL exactly: `<BACKEND_URL>/api/linkedin/callback`.
4. Copy the client ID and client secret.
5. Confirm the app can request `openid profile`.

Backend `.env`:

```dotenv
LINKEDIN_CLIENT_ID=<production client id>
LINKEDIN_CLIENT_SECRET=<production client secret>
LINKEDIN_OAUTH_CALLBACK_URL=<BACKEND_URL>/api/linkedin/callback
```

Frontend:

```json
"linkedinAuth": {
  "enabled": true
},
"socialLinks": {
  "linkedin": "https://www.linkedin.com/company/liberdus"
}
```

Notes:

- The app uses LinkedIn OpenID Connect only for sign-in/profile identity.
- The LinkedIn follow task is not API-verified in this app. It is stored as `linkedin_follow_manual` with status `claimed`.
- Do not describe this as formal identity verification; LinkedIn's own docs warn that Sign In with LinkedIn should not be marketed that way.

Official reference:

- [Sign In with LinkedIn using OpenID Connect](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2)

## GitHub

Current backend callback URL: `<BACKEND_URL>/api/github/callback`

Production ownership:

- Prefer creating the OAuth app under the `Liberdus` GitHub organization if the maintainers allow it.
- The target repository defaults to `Liberdus/web-client-v2`.

GitHub setup:

1. Create a production OAuth app in GitHub.
2. Set the homepage URL to the production signup or Liberdus site.
3. Set the authorization callback URL exactly: `<BACKEND_URL>/api/github/callback`.
4. Copy the client ID and generate/copy the client secret.
5. Confirm the target repo and org values.

Backend `.env`:

```dotenv
GITHUB_CLIENT_ID=<production client id>
GITHUB_CLIENT_SECRET=<production client secret>
GITHUB_OAUTH_CALLBACK_URL=<BACKEND_URL>/api/github/callback
GITHUB_TARGET_REPO=Liberdus/web-client-v2
GITHUB_TARGET_ORG=Liberdus
GITHUB_OAUTH_SCOPES=read:user
```

Frontend:

```json
"githubAuth": {
  "enabled": true,
  "targetRepo": "Liberdus/web-client-v2",
  "targetOrg": "Liberdus"
},
"socialLinks": {
  "github": "https://github.com/Liberdus",
  "githubOrg": "https://github.com/Liberdus",
  "githubRepo": "https://github.com/Liberdus/web-client-v2"
}
```

Notes:

- GitHub sign-in proves control of the GitHub account.
- The backend checks whether the authenticated user starred `GITHUB_TARGET_REPO` with `GET /user/starred/{owner}/{repo}`.
- If the target repo changes, update both backend `.env` and frontend link/config values.

Official references:

- [Creating a GitHub OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
- [GitHub starring API](https://docs.github.com/en/rest/activity/starring)

## YouTube / Google

Current backend callback URL: `<BACKEND_URL>/api/youtube/callback`

Production ownership:

- Create the Google Cloud project under a Liberdus-controlled Google account or organization.
- Use the official Liberdus YouTube channel as the target channel.

Google Cloud setup:

1. Create/select the production Google Cloud project.
2. Configure the OAuth consent screen with production app name, support email, authorized domains, privacy policy, and terms links.
3. Add scopes used by this app: `openid`, `profile`, and `https://www.googleapis.com/auth/youtube.readonly`.
4. Enable the YouTube Data API v3.
5. Create an OAuth client of type "Web application".
6. Add this authorized redirect URI exactly: `<BACKEND_URL>/api/youtube/callback`.
7. Copy the client ID and client secret.
8. Submit for Google OAuth app verification if the app will be public and Google requires it for `youtube.readonly`.
9. Add test users while the app is in testing mode, if needed before verification completes.

Backend `.env`:

```dotenv
YOUTUBE_CLIENT_ID=<production OAuth client id>
YOUTUBE_CLIENT_SECRET=<production OAuth client secret>
YOUTUBE_OAUTH_CALLBACK_URL=<BACKEND_URL>/api/youtube/callback
YOUTUBE_TARGET_CHANNEL_HANDLE=Liberdus
YOUTUBE_TARGET_CHANNEL_ID=<preferred stable channel id>
YOUTUBE_TARGET_CHANNEL_URL=https://www.youtube.com/@Liberdus
YOUTUBE_OAUTH_SCOPES=openid profile https://www.googleapis.com/auth/youtube.readonly
```

Frontend:

```json
"youtubeAuth": {
  "enabled": true,
  "targetChannelHandle": "Liberdus",
  "targetChannelId": "<preferred stable channel id>",
  "targetChannelUrl": "https://www.youtube.com/@Liberdus"
},
"socialLinks": {
  "youtube": "https://www.youtube.com/@Liberdus"
}
```

Notes:

- Set `YOUTUBE_TARGET_CHANNEL_ID` when possible. The backend can resolve the handle with `channels.list?forHandle=...`, but the channel ID is more stable.
- The backend checks the authenticated user's subscriptions with `subscriptions.list` using `mine=true` and `forChannelId=<target channel id>`.
- Public users may see an unverified-app warning until Google verification is complete.

Official references:

- [Google OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [YouTube channels.list](https://developers.google.com/youtube/v3/docs/channels/list)
- [YouTube subscriptions.list](https://developers.google.com/youtube/v3/docs/subscriptions/list)

## CoinMarketCap

Production ownership:

- Use the official Liberdus CoinMarketCap community/profile URL.
- No OAuth app, API key, or backend secret is used by the current signup app.

Frontend:

```json
"socialLinks": {
  "coinMarketCap": "https://coinmarketcap.com/community/profile/Liberdus/"
}
```

Notes:

- The app records the CMC follow action as `coinmarketcap_follow_manual` with status `claimed` after the user opens the link and submits.
- This is not proof that CoinMarketCap confirmed the follow.

## Final Smoke Test

Before announcing deployment:

1. Start the production backend with the production `.env`.
2. Confirm startup logs say each intended provider is configured.
3. Open the production frontend from a clean browser profile.
4. Connect and sign a wallet.
5. Test each provider using real non-admin user accounts:
   - X sign-in completes and returns to `<FRONTEND_URL>`.
   - Telegram sign-in completes, and membership shows configured if `TELEGRAM_CHAT_ID` is set.
   - Discord sign-in completes, and membership shows configured if `DISCORD_GUILD_ID` is set.
   - LinkedIn sign-in completes.
   - GitHub sign-in completes and star status updates after starring the target repo.
   - YouTube sign-in completes and subscription status updates after subscribing to the target channel.
   - CoinMarketCap link opens the production profile.
6. Submit a signup and verify the admin page shows the connected accounts and expected verification statuses.
7. Rotate any credentials that were used in local testing or shared outside the production secret store.

## Required Secret Inventory

Keep this list in the deployment secret manager:

```dotenv
X_API_KEY=
X_API_SECRET=
X_OAUTH1_CALLBACK_URL=

DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_OAUTH_CALLBACK_URL=
DISCORD_GUILD_ID=
DISCORD_INVITE_URL=

TELEGRAM_BOT_USERNAME=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_INVITE_URL=

LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
LINKEDIN_OAUTH_CALLBACK_URL=

GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_OAUTH_CALLBACK_URL=
GITHUB_TARGET_REPO=
GITHUB_TARGET_ORG=
GITHUB_OAUTH_SCOPES=

YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_OAUTH_CALLBACK_URL=
YOUTUBE_TARGET_CHANNEL_HANDLE=
YOUTUBE_TARGET_CHANNEL_ID=
YOUTUBE_TARGET_CHANNEL_URL=
YOUTUBE_OAUTH_SCOPES=
```
