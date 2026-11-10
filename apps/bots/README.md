# Bot services

- `admin/` — company-admin Telegram bot; tests are in `admin/tests/`.
- `worker/` — worker Telegram bot; tests are in `worker/tests/`.
- `superadmin/` — placeholder for a separate superadmin bot, not deployed.
- Telegram WebApp interfaces live in `apps/webapps/` and are served by the API.
- Each bot's runtime source is in `src/`; the worker's local launcher is in `worker/scripts/`.

Both Docker builds use the repository root as their build context. Compose and CI
configuration live under `ops/deploy/` and `.github/workflows/` respectively.
