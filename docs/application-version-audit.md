# Application Version Audit

**Date:** 2026-10-01

## Canonical version

The root `package.json` remains the canonical application version source at
`0.0.0`; Vite injects that package version as `VITE_APP_VERSION`, Electron reads
the packaged root manifest, and release build scripts derive their application
version from it.

| Project metadata | Before | After |
|---|---:|---:|
| `ops/deploy/package.json` | `1.7.6` | `0.0.0` |
| `ops/deploy/package-lock.json` root metadata | `1.7.6` | `0.0.0` |
| `ops/deploy/package-lock.json` workspace metadata | `1.7.6` | `0.0.0` |
| `MIN_CLIENT_VERSION` defaults/examples/deployment | `2.0.0` | `0.0.0` |
| Desktop sync client's default release version | `2.0.0` | `0.0.0` |
| Integration fixture client release | `2.0.0` | `0.0.0` |

Third-party dependency/devDependency versions and package resolutions were not
changed. The root package and root lockfile already declared project version
`0.0.0`. Electron/Node/tool versions and database/API schema identifiers remain
unchanged.

`PRODUCTION.md` retains historical release-candidate artifact numbers as dated
records, not current version declarations. Version-fence tests may use explicit
nonzero versions to exercise comparison behavior.

## Verification

Manifest edits were limited to project-owned `version` values and client release
defaults; no dependency sections or package resolutions were edited. Typecheck,
and the production frontend build passed. `npm ci` succeeded with
`--ignore-scripts` (the normal install cannot compile `better-sqlite3` because
Visual Studio C++ build tools are absent). The package audit reports one high
transitive production vulnerability in `fast-uri`; dependency versions were not
changed. See the repository hygiene report for test and desktop packaging
limitations.
