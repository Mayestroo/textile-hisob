# Repository Hygiene Audit

**Date:** 2026-10-01

## Documentation

Removed completed transition plans, migration logs, and one-off audit reports whose useful current findings are represented by the repository structure, active product documentation, and this report:

- `docs/folder-structure-audit.md`
- `docs/folder-structure-migration.md`
- `docs/pre-production-consolidation-plan.md`
- `docs/pre-production-consolidation-result.md`
- `docs/dead-code-duplicate-audit.md`
- `docs/firebase-removal-audit.md`
- `docs/v2-naming-cleanup-audit.md`
- `docs/final-production-readiness-audit.md`

Retained `PRODUCTION.md` as the project/operations guide, `ops/ADMIN_PANEL_FEATURE_INVENTORY.md` as the active feature inventory, and the presentation under `docs/taqdimot/`. No markdown links or workflow references to the removed reports remain.

## Scripts, tests, and duplicate files

Existing worktree cleanup removes obsolete Firebase cutover tools and their tests (`scripts/backup_firebase.cjs`, `scripts/backupFirebaseReadOnly.test.ts`, `scripts/prepareFirebaseCleanBaseline.cjs`, `scripts/prepareFirebaseCleanBaseline.test.ts`), the superseded local Express server and persistence tests, diagnostic SQLite/crash spikes and their tests, the Firebase-era baseline importer and tests, and unused renderer files (`FormulaBar.tsx`, `domain/commands.ts`). The direct unused `xlsx` dependency and its Vite chunk mapping were also removed. Active persistence, migration, runtime, and product behavior tests were retained. No additional scripts/tests or backup/junk files were deleted in this pass.

## Organization and root

The existing worktree relocates desktop code to `apps/desktop/`, server code to `apps/server/`, shared contracts/domain rules to `packages/`, deployment assets to `ops/deploy/`, developer tooling to `scripts/{build,verify,tools}/`, desktop test fixtures/harnesses under `apps/desktop/electron/tests/`, and screenshots to `docs/assets/screenshots/`. Representative move map: `src/` → `apps/desktop/renderer/`; `electron/` → `apps/desktop/electron/`; `server/v2/` → `apps/server/`; `build/` → `apps/desktop/build/`; `license_payload.py` → `packages/contracts/serialization/canonicalPayload.py`; `generate_license.py` → `scripts/tools/generate_license.py`; `ops/novda-v2/` → `ops/deploy/`; `screenshots/` → `docs/assets/screenshots/`.

No further file moves were made. Root `index.html` remains the configured Vite entry; package manifests/lockfile, TypeScript/Vite configs, environment example, Docker ignore file, and project guide are intentionally root-level. `admin-bot/` and `worker-bot/` remain at root because `.gitmodules`, Compose, and deployment workflows depend on those submodule paths. Local `data/`, `dist/`, `dist-build/`, `.env.local`, and `node_modules/` are workspace/runtime artifacts, not misplaced tracked source files.

## Ignore rules

No `.gitignore` change was made in this pass. Existing changes include local/runtime exclusions; no tracked junk was found that warranted additional ignore patterns.

## Verification

Results on the current worktree:

- Repository searches: no stale references to deleted runtime/script paths; removed Markdown report names occur only in this report's deletion inventory.
- `npm run lint`: unavailable; no lint script is configured.
- `npx tsc --noEmit`: PASS.
- `npm run build`: PASS (TypeScript + Vite; existing large-chunk warning).
- `npm test`: 64 test files passed, 9 failed, 7 skipped; 556 tests passed, 2 failed, 115 skipped. Seven PostgreSQL-dependent suites could not initialize because an explicit disposable PostgreSQL DSN is not configured. Two signer tests failed because the Windows Python environment lacks `cryptography`. These are environment-dependent, not cleanup failures.
- `git diff --check`: reports trailing whitespace across pre-existing staged/modified files, including moved deployment manifests and tests. No unrelated formatting was applied. The new audit report introduces no trailing whitespace.
- `.gitignore`: no change made by this audit pass; unrelated existing worktree changes were preserved.
