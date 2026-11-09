# Redesign Phase A — desktop shell and Umumiy

Date: 2026-11-05. Reference: `.opencode/deep-audit/output/REDESIGN-REFERENCE.md` (observed signed-in Chrome rendering of `Main.dc.html`), mapped against `.opencode/deep-audit/output/REDESIGN-EXISTING-SURFACES.md`. Existing-only scope; no reference/sample financial data copied.

## Changes made

- `apps/desktop/renderer/index.css` — removed remote Google Fonts import; applied offline-safe system font stacks, observed light palette (`#F3F6FB`, `#0B1B2B`, emerald `#047857`, reference border colors), tabular numerals, white TitleBar, refined existing action buttons/sidebar, report cards/table headings and responsive shell breakpoints. Preserved existing dark palette and added dark TitleBar/button overrides. Kept table/virtualizer row metrics and geometry unchanged; no shadow on individual rows.
- `scripts/verify/fixtures/payroll-display-fixture.tsx` — local isolated fixture now mounts the existing `TitleBar` and `SheetTabs` around actual Hisob/Umumiy components.
- `scripts/verify/render/payroll-display-runtime.cjs` — asserts rendered Phase A TitleBar/period action, Umumiy search toolbar, sidebar keyboard-open and Umumiy selection, plus actual rendered synthetic report/Hisob values and provisional state.
- `REDESIGN-TODO.md` — ordered existing-surface plan and explicit many-artboards-to-one-current-surface mappings.
- `.opencode/deep-audit/output/CURRENT-DESKTOP-CANDIDATE.md` — marked STALE before product source changes; historical artifact paths/hashes/build evidence retained below the status line.

No navigation handlers, data actions, keyboard shortcuts, permissions, payroll calculations, dirty financial/sync/offline/bot work, or role checks were changed.

## Reference choices

- Reused the reference's pale blue-gray canvas, dark ink, emerald action/positive palette, white surfaces, restrained borders, uppercase table headings, and rounded report cards.
- Used installed system fallbacks instead of external font requests; no font downloads.
- Mapped `Umumiy hisobot` and `Modellar kesimida jami` to the current Umumiy screen; mapped `Yon panel (Varaqlar)` to the existing drawer; no standalone/invented ERP screens.
- Did not apply reference 58px rows to virtualized tables: Umumiy and Hisob geometry/virtualizer assumptions remain intact.

## Executed local verification

- `node_modules/.bin/tsc.cmd --noEmit` — passed (no output).
- `node_modules/.bin/vitest.cmd run apps/desktop/renderer/features/payroll/payrollDisplay.integration.test.tsx apps/desktop/renderer/features/models/HisobView.test.ts apps/desktop/renderer/components/layout/ConnectionStatus.test.ts` — 3 files passed; 29 passed, 1 skipped.
- `node scripts/verify/render/payroll-display-runtime.cjs` — passed against disposable synthetic SQLite and isolated Electron with network-deny policy. Actual current `HisobView`/`UmumiyView` rendered payroll outputs included Hisob ≈84, Umumiy gross ≈84/net ≈76, quantity 12, 5 columns and explicit provisional label. Phase A rendered shell evidence: TitleBar and period action present; Umumiy search present; computed canvas `rgb(243, 246, 251)`, header white; Ctrl+B opened existing sidebar and selecting Umumiy activated its current navigation entry. Existing local acceptance also confirmed unknown/provisional behavior, license/company/period invalidation and archive guards.
- `node --check scripts/verify/render/payroll-display-runtime.cjs` and scoped `git diff --check` — passed.

The runtime printed non-fatal Electron “No handler registered” diagnostics for optional `outbox-diagnostics`/`get-runtime-mode` calls made by the real TitleBar in this fixture; the script exited successfully and the period/sidebar/report rendered assertions passed. No screenshot capture was produced. No application profile, project server, customer DB, health endpoint, Telegram, `.env`, installation, download, deployment or user-owned PID was accessed. No source guard was treated as render acceptance.

## Phase boundary / next stage

Phase A is complete for the shared desktop visual foundation and Umumiy surface. Other desktop sheets/modals and the two WebApps remain unchecked in `REDESIGN-TODO.md`; next unchecked stage is Phase B: Patta output/entry/journal, per-model Hisob, and Konveyer existing views.
