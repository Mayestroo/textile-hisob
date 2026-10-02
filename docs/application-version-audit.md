# Application Version Audit

**Date:** 2026-10-02

## Fresh application version

At the owner's request, the first-party application version was reset from the
temporary `0.0.0` placeholder to **`1.0.0`** after the owner removed the old
`1.7.*` installations and local data from the target PCs. This changes version
metadata only; it does not reset or delete the authoritative `comp_novda`
PostgreSQL database or its retained pre-import backup.

The root `package.json`/lockfile and the minimal deployment package
`ops/deploy/package.json`/lockfile now agree on `1.0.0`. Vite uses the root
version by default while allowing an explicit `VITE_APP_VERSION` for a local
test candidate. Electron activation and sync headers use the packaged app
version. New-device provisioning and the server's default minimum client version
are `1.0.0`.

Third-party dependency versions and package resolutions were not changed.
Electron/Node/tool versions and database/API schema identifiers remain
unchanged. Historical `1.7.*` installers and release records remain historical
artifacts; no release or updater publication was made as part of this version
reset.

## Verification

- Root and deployment package/lock versions match at `1.0.0`.
- Version and NSIS configuration tests cover the new canonical version.
- TypeScript, non-PostgreSQL tests, PostgreSQL tests, and the production build
  passed in CI.
- The unsigned Windows x64 `1.0.0` local test installer and its SHA-256 are
  recorded in `PRODUCTION.md`.
