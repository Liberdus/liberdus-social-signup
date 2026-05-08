# Liberdus Social Signup

Static signup frontend plus a small Node/SQLite backend for collecting reward signup information.

The current MVP requires:

- Wallet connect and message signature to prove wallet ownership.
- X sign-in to prove X account ownership.
- Signup details stored in SQLite for admin review.

The public page is moving toward a checklist instead of a details form. Discord, Telegram, and LinkedIn are optional sign-in integrations, and CoinMarketCap is an external follow link only. See [docs/SIGNUP_PLAN.md](docs/SIGNUP_PLAN.md) for the provider plan and account replacement notes.

The database keeps one row per signup, plus normalized social account and verification-check rows for connected providers. Provider raw profile/check payloads are retained as JSON for audit/debug while searchable identity fields stay relational.

## Local Setup

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` with X OAuth credentials, callback URL, optional Discord/Telegram/LinkedIn test credentials, and a strong `ADMIN_PASSWORD`.

Run backend:

```powershell
npm run serve
```

Run static frontend:

```powershell
npm run serve:static
```

Open `http://127.0.0.1:5503/frontend/`.

## GitHub Pages

The frontend is static and can be hosted from `frontend/`. The backend must be deployed separately because it stores data, handles OAuth secrets, and verifies wallet signatures.

## Temporary Wallet Module

`vendor/liberdus-wallet-module` is vendored from `Liberdus/liberdus-wallet-module` branch `base_branch`. The intent is to replace this local copy with the GitHub Pages-hosted module once that distribution is ready.
