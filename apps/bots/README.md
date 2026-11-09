# Bot services

- `admin/` — admin Telegram bot, license signer, and its tests.
- `worker/` — worker Telegram bot, static WebApp, and its tests.

Both Docker builds use the repository root as their build context. Compose and CI
configuration live under `ops/deploy/` and `.github/workflows/` respectively.
