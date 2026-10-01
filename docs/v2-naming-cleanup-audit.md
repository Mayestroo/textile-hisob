# Canonical API and Naming Cleanup

**Date:** 2026-10-01

## API and caller migration

The canonical server worker endpoints are `/api/worker/bindings/...`,
`/api/worker/enrollment`, `/api/worker/profile`, and `/api/worker/tickets` in
`apps/server/modules/workers/workerRoutes.cjs`. The Telegram bot and worker web
app now call these exact routes. The worker runtime source was renamed from
`worker-bot/v2_bot.py` to `worker-bot/worker_bot.py`; Docker and `run.bat` were
updated to launch the canonical filename.

No `/api/v2` server route or active first-party `/api/v2/...` caller was found.
`NOVDA_V2_SYNC_ENABLED`, `API_V2`, `NOVDA_V2`, and `novda-v2` are absent from
active source/configuration. `NOVDA_SYNC_ENABLED` is already the runtime switch.

## Removed/renamed architecture

- `worker-bot/v2_bot.py` → `worker-bot/worker_bot.py` (current VPS API-backed bot retained).
- Updated bot Docker copy/entrypoint and Windows developer launcher.
- Removed stale version-generation language from business migration comments,
  production-role SQL comments and worker bot template/messages.
- No separate v1 implementation or API compatibility wrapper was found to remove.
- `admin-bot/` is already the canonical bot directory. No `render-bot` path or
  package name exists. The working tree already had `worker-bot/render.yaml`
  deleted before this pass; that existing deletion is retained.

## Remaining matches

- Third-party/build output (ignored `dist-build/` when present) can contain
  vendor terms such as SQLite interface labels or software license versions;
  these are not first-party API/application-generation identifiers.
- Historical release records may contain old application release numbers; they
  identify completed artifacts, not the current source version.
- API/data-protocol fields such as schema migration numbers and authenticated
  worker-token `v1` markers are genuine format/contract identifiers and were not
  renamed as application generations.

## Verification

The first-party tracked source/config search found no `/api/v2`, `/v2/` caller,
`NOVDA_V2`, `API_V2`, `novda-v2`, or first-party filename containing `v2` after
the rename. The deleted bot path is no longer referenced. Build/typecheck/tests
were run: TypeScript passed; production frontend build passed; 50 test files
passed (429 tests), with two signer subprocess failures caused by the current
Python test environment not loading `cryptography`; four worker-auth boundary
tests passed. PostgreSQL suites lack a disposable PostgreSQL DSN. Desktop package
creation lacks Visual Studio C++ build tools. Lint is not configured and
`git diff --check` passed. Filesystem name scan returned only this audit report's
requested filename; Docker Compose validation is unavailable locally because
the Compose plugin is not installed.
