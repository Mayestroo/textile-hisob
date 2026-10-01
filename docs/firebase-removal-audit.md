# Firebase Removal Audit

**Date:** 2026-10-01

## Removed

- `worker-bot/bot.py`: obsolete bot implementation used Firebase Realtime Database for binding lookup/writes and worker calculations, with local JSON fallback. It was not the deployed bot; `worker-bot/Dockerfile` already launched the authenticated server-backed implementation. The canonical implementation is now `worker-bot/worker_bot.py` and uses PostgreSQL-backed VPS worker endpoints.
- `worker-bot/config.json`: private/local configuration used only by the removed bot implementation.
- Firebase-specific environment setting `FIREBASE_DATABASE_URL` and the hard-coded Realtime Database URL were removed with that implementation.
- No Firebase client/admin SDK dependency, Hosting/Firestore/Storage/FCM configuration, deployment command, or CI secret reference was present in the current manifests/configuration.

## Runtime/data safety

The retained worker bot uses `NOVDA_WORKER_API_URL` and `NOVDA_WORKER_API_TOKEN`, and calls `/api/worker/...`; the server routes invoke `workerService` over the VPS PostgreSQL pool. Enrollment, binding claims, profile and tickets therefore have an active canonical implementation. The worker web app uses the same VPS routes and signed worker context.

No Firebase data, snapshots, backups, or local user data were deleted. Historical `data/backups/firebase_*` files remain protected local/archive data and are not packaged or accessed by application runtime code. The repository does not provide evidence of a production-data export/reconciliation operation in this pass; before disposing of archived snapshots, verify that production worker bindings and any records of continuing business value are present in PostgreSQL.

## References retained

- Static tests retain a few negative assertions ensuring shipped admin/worker runtime assets do not contain retired external database/runtime references. These are regression checks, not SDK callers or fallback behavior.
- Audit/history documents may refer to the retired provider to record its removal. These references are non-runtime.

## Verification

- Direct SDK, Auth, Firestore, Storage, messaging, environment and URL search of application/deployment source: no active caller/configuration remains.
- The former Firebase-accessing bot was removed from the normal and developer startup paths; both Docker and `run.bat` start `worker_bot.py`.
- Package manifests contain no Firebase package or script.
- `npx tsc --noEmit`: passed. `npm run build`: passed. Worker auth boundary: 4 tests passed. Admin bot Python unit tests: 15 passed. Worker Python syntax check: passed.
- Full non-PostgreSQL test run: 50 files passed, 429 tests passed, with 2 existing signer-environment tests failing because the Python subprocess launched from Vitest cannot import `cryptography`; direct signer verification passes outside Vitest. PostgreSQL tests are blocked because no disposable PostgreSQL DSN is configured.
- `npm run lint`: unavailable (no lint script). Electron `dist:local` reached native Electron rebuild and failed because Visual Studio C++ build tools are absent. `git diff --check`: passed.
