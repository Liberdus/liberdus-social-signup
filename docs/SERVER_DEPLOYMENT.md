# Server Deployment

This public checklist documents the deployment shape without publishing private server layout details.

- the frontend is hosted separately at `https://liberdus.com/social/`
- the backend serves only API routes and stores secrets server-side
- the Node process should bind to loopback behind a trusted reverse proxy
- the public backend base URL is `https://att.liberdus.com/social-signup`
- PM2, systemd, or an equivalent process manager should keep the backend running

Keep exact server paths, SSH aliases, private IPs, internal ports, and full production proxy config in private operations notes.

## Public URLs

```text
frontend URL: https://liberdus.com/social/
backend URL:  https://att.liberdus.com/social-signup
```

The backend base URL is the public path prefix and must not include `/api`.

## Backend Environment

Create `.env` from `.env.production.example` on the server:

```bash
cp .env.production.example .env
```

Required production URL values:

```dotenv
SIGNUP_HOST=127.0.0.1
SIGNUP_PORT=<production internal port>
SIGNUP_ALLOWED_ORIGINS=https://liberdus.com
SIGNUP_FRONTEND_RETURN_URL=https://liberdus.com/social/
SIGNUP_FRONTEND_RETURN_URLS=https://liberdus.com/social/
SIGNUP_COOKIE_SECURE=true
SIGNUP_TRUST_PROXY=true
```

Set `SIGNUP_TRUST_PROXY=true` only behind a trusted reverse proxy that sanitizes forwarded IP headers.

## Provider Callback URLs

Use these exact public values in provider developer consoles:

```text
https://att.liberdus.com/social-signup/api/x/callback
https://att.liberdus.com/social-signup/api/discord/callback
https://att.liberdus.com/social-signup/api/linkedin/callback
https://att.liberdus.com/social-signup/api/github/callback
https://att.liberdus.com/social-signup/api/youtube/callback
```

Telegram uses the frontend domain in BotFather and the backend verification endpoint:

```text
BotFather /setdomain: liberdus.com
Telegram verify API:  https://att.liberdus.com/social-signup/api/telegram/verify
```

## Frontend Config

For production publishing, copy:

```bash
cp frontend/config.prod.json frontend/config.json
```

Important production values:

```json
{
  "apiBaseUrl": "https://att.liberdus.com/social-signup",
  "xAuth": {
    "enabled": true,
    "redirectUri": "https://liberdus.com/social/",
    "backendUrl": "https://att.liberdus.com/social-signup"
  }
}
```

The backend also publishes safe provider config from `/api/public/config`, but the static frontend file should still carry the correct backend URL and public social links.

## Process Manager

Build a backend-only deploy package locally:

```bash
npm run package:backend -- --archive
```

The package contains only backend runtime files, package manifests, and the production environment template. It intentionally excludes frontend files, tests, vendored browser assets, `node_modules`, and real `.env` files.

Use Node 20 or newer. If the deployment host has Node 20 installed but does not make it the default shell version, explicitly put that Node install first on `PATH` before running `node`, `npm`, or `pm2`:

```bash
export PATH="$HOME/.nvm/versions/node/<node-20-version>/bin:$PATH"
node --version
npm --version
```

Install production dependencies, then start the backend with the process manager used by the deployment host:

```bash
npm ci --omit=dev
PM2_APP_NAME=<production pm2 app name> npm run pm2:start
pm2 save
```

## Reverse Proxy

Configure the reverse proxy so the public backend URL forwards only API and health traffic to the local backend process:

```text
https://att.liberdus.com/social-signup/health -> http://127.0.0.1:<production internal port>/health
https://att.liberdus.com/social-signup/api/*  -> http://127.0.0.1:<production internal port>/api/*
```

Keep the exact production proxy file in private operations notes.

## Smoke Test

1. Confirm `https://att.liberdus.com/social-signup/health` returns `{"ok":true}`.
2. Open `https://liberdus.com/social/` from a clean browser profile.
3. Confirm the page loads `/api/public/config` from `https://att.liberdus.com/social-signup`.
4. Connect and sign a wallet.
5. Test X, Telegram, Discord, LinkedIn, GitHub, and YouTube with real user accounts.
6. Submit a signup and confirm the admin page shows the connected accounts.
