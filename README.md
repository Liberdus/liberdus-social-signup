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

The frontend is static and can be hosted from `frontend/`. The backend must be deployed separately because it stores data, handles OAuth secrets, and verifies wallet signatures.

## Temporary Wallet Module

`vendor/liberdus-wallet-module` is vendored from `Liberdus/liberdus-wallet-module` branch `base_branch`. The intent is to replace this local copy with the GitHub Pages-hosted module once that distribution is ready.
