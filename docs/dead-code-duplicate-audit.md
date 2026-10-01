# Dead-Code and Duplicate-Code Audit

**Date:** 2026-10-01  
**Scope:** Root package, desktop renderer/Electron runtime, Fastify server, shared packages, scripts, and deployment workspace.

## Outcome

No additional deletion or dependency removal was justified by this pass. Candidates were checked against application entrypoints, package/build configuration, cross-workspace references, tests, and deployment/runtime files. In particular, the Electron application is launched through the root `main` field, the server through `apps/server/serve.cjs`, and Vite through root `index.html` and `vite.config.mts`.

The prior `docs/repository-hygiene-audit.md` records an earlier cleanup (including removal of obsolete tools, an old Express server, and unused renderer files). Those removals are already reflected in this checkout. This report records the additional audit requested for the consolidated layout.

The follow-up cleanup removed the confirmed Firebase-backed worker bot and its
exclusive configuration, and renamed the active VPS API-backed bot source to a
non-versioned canonical filename. Details are recorded in the Firebase and API
naming audit reports.

## Confirmed removals in this pass

- **Files:** None. No additional file was confirmed dead after checking dynamic entrypoints, filesystem/deployment references, and workspace packaging.
- **Exports/imports:** None. No unused export was confirmed independently of the framework/runtime and test entrypoints. Renderer TypeScript is configured with `noUnusedLocals` and `noUnusedParameters`.
- **Dependencies/devDependencies:** None. The root dependencies are referenced by the renderer/server/build/test/release-verification code or Electron packaging. The deploy workspace's `fastify` and `pg` are runtime requirements of the deployed server/migration utilities. `package-lock.json` agrees with the manifests.
- **Duplicate implementations consolidated:** None in this pass; see the verified canonical serialization divergence below.

The working tree already contained unrelated edits in `.gitignore` and `ops/deploy/{VPS-BOOTSTRAP.md,compose.yaml,deploy.sh}`, as well as deletion of `worker-bot/render.yaml`. These were not part of this audit and were left untouched.

## Duplicate implementations reviewed

### Canonical payload serialization and hash

- `apps/desktop/electron/database/canonicalPayload.cjs`
- `apps/server/modules/sync/canonicalPayload.cjs`
- The Python signer has a language-specific implementation at `packages/contracts/serialization/canonicalPayload.py`.

The JavaScript modules both sort keys, omit undefined object properties, map undefined array entries to null, and compute SHA-256. They are not behaviorally interchangeable: the desktop version rejects cycles, `Date`, BigInt, functions, and symbols and explicitly normalizes `-0`; the server version treats null and top-level undefined alike and has a less restrictive type/error contract. Callers use the resulting hashes in desktop persistence/outbox and server synchronization/idempotency paths. Altering these semantics without compatibility fixtures risks changing durable payload identity. Retained pending an explicit shared-contract compatibility decision and cross-runtime fixtures; no caller was silently switched.

The Python implementation serves the license-signing workflow and is necessarily language-specific. It is not a candidate to replace the JavaScript runtime modules without a verified cross-language contract.

### Shared domain policies

`packages/domain/partyPolicy.cjs` and `packages/domain/periodWriteGuard.cjs` are used from both server and Electron paths. Searches confirmed live imports from database schema/migration/command-pipeline code and server sync/operations code. No duplicate policy implementation was identified that could safely replace these shared sources.

### Renderer calculations/formatters

The renderer has a shared `utils/formatters.ts`, `domain/projections.ts`, `domain/partyAnalytics.ts`, and `domain/ticketValidation.ts`; reviewed consumers import these modules directly. `formulaEngine.ts` re-exports `formatMoney` and `formatNumber` from the shared formatter rather than implementing a second version. No confirmed duplicate was found in this set.

## Unused/dead-code and entrypoint checks

- Root package scripts, Electron Builder `files`, Electron `main.cjs`, Vite's configured HTML entry, server bootstrap/routes, desktop preload/IPC wiring, and test harness children were treated as entrypoints even where ordinary static import searches may miss them.
- Admin static assets are served by the server; ops scripts and systemd/Compose assets are deployment entrypoints and were not judged by JavaScript import reachability alone.
- Bot directories are submodule/deployment paths referenced by repository/deployment configuration; their contents were not treated as ordinary unused files.
- The root Excel dependency `xlsx-js-style` is imported by `renderer/engine/excelSync.ts`; `excelUtils.ts` is used by `HisobView.tsx`. Neither is stale.
- `legacy` references in Electron storage loading and runtime-mode selection support data migration and/or explicit mode boundaries. Legacy-named schema fields and migration code are exercised by migration tests. They are not dead solely because the architecture has consolidated.
- No stale barrel-export files were identified in the inspected application layout; renderer store exports and types have active imports.
- `git ls-files "*.pyc" "**/__pycache__/**"` returned no tracked bytecode. Visible Python cache files are untracked/local artifacts, not shipped source.

## Suspicious items intentionally retained

1. **The two JavaScript canonical-payload modules** — near-duplicate code, but their behavior differs and payload hashes are durable sync identifiers. Consolidation without proving compatibility is unsafe.
2. **Legacy data/runtime paths in Electron (`main.cjs`, `runtimeMode.cjs`)** — retained because they participate in on-disk database selection/migration and runtime-mode decisions; removing them could strand existing installations.
3. **Migration/reconciliation schema fields and tests containing `legacy` names** — retained because migration, reconciliation, compatibility rejection, or database cleanup code still uses them; names alone do not make them obsolete.
4. **Deployment scripts that appear overlapping** — retained because backup, restore drill, database verification, migration, host health checks, and deploy orchestration have distinct workflow/service references.
5. **Python canonical serialization** — retained as a separate-language contract used by the license signing tool; no runtime evidence supports deleting it.

## Verification results

| Check | Result |
|---|---|
| Repository/workspace and runtime-entrypoint inspection | Completed; no confirmed dead file found |
| Dependency reference audit | All direct manifest dependencies had an identified code, test, build, or packaging use; no removal |
| Knip | Not run: dependencies are not installed and there is no Knip configuration/package entry |
| jscpd | Not run: dependencies are not installed and there is no jscpd configuration/package entry |
| `npm run lint` | Unavailable: root package has no `lint` script |
| `npm ls --depth=0` | Blocked: all declared root dependencies are unmet because `node_modules` is absent |
| `npx tsc --noEmit` | Blocked: TypeScript executable is absent (`node_modules/typescript/bin/tsc`) |
| Tests | Not runnable in this environment: Vitest and project dependencies are absent |
| Production builds | Not runnable in this environment: TypeScript/Vite/Electron Builder dependencies are absent |
| `git diff --check` | Passed (no output) |
| Search for paths removed by the earlier hygiene pass | No runtime/config references; names appear only in the prior audit's deletion inventory |

No tool-generated unused-code finding was accepted as a deletion by itself. Install dependencies in the normal project environment and rerun the configured verification commands to complete executable validation.
