# Liberdus Social Signup

Static signup frontend plus a small Node/SQLite backend for collecting reward signup information.

The current MVP requires:

- Wallet connect and message signature to prove wallet ownership.
- At least one connected account from X, Telegram, Discord, or LinkedIn.
- Signup details stored in SQLite for admin review.

The public page is a checklist instead of a details form. Discord, Telegram, and LinkedIn are required-choice sign-ins, X/GitHub/YouTube are optional sign-in integrations, and CoinMarketCap is an external follow link only. See [docs/SIGNUP_PLAN.md](docs/SIGNUP_PLAN.md) for the provider plan and account replacement notes.

The database keeps one row per signup, plus normalized social account and verification-check rows for connected providers. Provider raw profile/check payloads are retained as JSON for audit/debug while searchable identity fields stay relational.

Follow/link tasks that cannot be verified through an API are stored as manual claims, not verified checks. A user click on tasks such as X follow, LinkedIn follow, or CoinMarketCap follow can be persisted after submit with verification status `claimed`; only API-confirmed checks should use `passed`.

Social integrations are split by provider:

- Backend OAuth/verification providers live in `backend/lib/social/`.
- Frontend checklist providers live in `frontend/js/checklist-providers/`.
- Shared browser auth helpers for OAuth flows live in `frontend/js/shared/*-auth.js`.

## Local Setup

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` with Discord/Telegram/LinkedIn credentials, optional X/GitHub/YouTube credentials, callback URLs, and a strong `ADMIN_PASSWORD`.
The backend also ships with in-memory throttles for admin login, signup writes, signup session reads, and provider sign-in routes. Tune the `SIGNUP_*_LIMIT` and `SIGNUP_*_WINDOW_SECONDS` values in `.env` to match your deployment, and set `SIGNUP_TRUST_PROXY=true` only behind a trusted proxy that sanitizes forwarded IP headers.

Run backend:

```powershell
npm run serve
```

Run static frontend:

```powershell
npm run serve:static
```

Open `http://127.0.0.1:5503/frontend/`.

## Tests

Unit tests use Node's built-in test runner:

```powershell
npm run test:unit
```

E2E tests use Playwright with a fake browser wallet and local-only fake social sessions. They do not run real third-party OAuth flows:

```powershell
npm run test:e2e
```

Real X, Discord, Telegram, LinkedIn, GitHub, YouTube, and CoinMarketCap flows stay as manual smoke tests because they depend on external accounts, app credentials, approvals, and provider availability.

## GitHub Pages

The frontend is static and can be hosted from `frontend/` or published from a separate GitHub Pages repository. The backend must be deployed separately because it stores data, handles OAuth secrets, and verifies wallet signatures.

## Production Backend With PM2

PM2 is not included in `package.json`. Install it separately on the server, usually as a global process-manager tool:

```bash
npm install -g pm2
```

Install production dependencies and create the server environment file:

```bash
npm ci --omit=dev
cp .env.example .env
```

Edit `.env` for the production frontend and backend domains before starting the process:

- Set `SIGNUP_HOST=127.0.0.1` when the backend is behind nginx, Caddy, Apache, or another reverse proxy.
- Set `SIGNUP_PORT` to the local backend port the proxy forwards to.
- Set `SIGNUP_ALLOWED_ORIGINS` to the public GitHub Pages frontend origin, for example `https://example.github.io`.
- Set `SIGNUP_FRONTEND_RETURN_URL` and `SIGNUP_FRONTEND_RETURN_URLS` to the public GitHub Pages frontend URL.
- Set all OAuth callback URLs to the public backend callback URLs.
- Set a strong `ADMIN_PASSWORD`.
- Set `SIGNUP_TRUST_PROXY=true` only when the reverse proxy sanitizes `X-Forwarded-For` and `X-Real-IP`.

Start only the backend API with PM2:

```bash
pm2 start npm --name liberdus-social-signup-api -- run serve
pm2 save
```

To make PM2 restart the backend after a server reboot, run the startup command PM2 prints:

```bash
pm2 startup
```

Do not run `npm run serve:static` for production. That script is only a local development and E2E helper. Serve the static frontend from GitHub Pages instead.

## Temporary Wallet Module

`vendor/liberdus-wallet-module` is vendored from `Liberdus/liberdus-wallet-module` branch `base_branch`. The intent is to replace this local copy with the GitHub Pages-hosted module once that distribution is ready.
