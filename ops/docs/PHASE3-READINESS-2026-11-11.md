# Phase 3 — production readiness and engineering quality

**Verdict: NOT READY for the requested controlled production release scope.**

Phase 1/2 fixes and business rules are preserved. Substantial local engineering,
financial-evidence and packaged-desktop validation is complete. Historical financial
signoff and environment-dependent release gates remain blocked; passing tests does
not waive them. Nothing was pushed, deployed, installed over an existing application,
or written to production. All business mutations were confined to named disposable
loopback databases and isolated test profiles.

## 1. Safe baseline and rollback

Baseline HEAD: `66e69286e5d3ac71823319c9e80655b0fea8ee59`.

- Inspected the dirty tracked/untracked changes, including Phase 1/2 application,
  migration, package, harness and test-driver changes. The two deleted Python
  `test_*_acceptance_driver.py` files have existing non-test driver replacements;
  they were not independently deleted or reverted in Phase 3.
- Preserved all pre-existing work. No staging, commit, reset, checkout-over-dirty-tree,
  production connection, push or deployment was performed.
- `scripts/verify/release/local-checkpoint.py` captured binary tracked/staged patches,
  untracked source ZIP and SHA-256 manifest to
  `C:\Users\bekbo\AppData\Local\Temp\opencode\phase3-baseline-20261111`.
- Recovery was actually rehearsed into a **new** disposable directory,
  `phase3-baseline-restoreproof`: **467 source files** matched the manifest hashes.
  This reconstructs the Phase 1/2 dirty baseline, not just HEAD.
- Original dump SHA remains
  `ce529a4afb44da7bafed55ccc26ecc2b7ba64b3241b9e382ed740b01399dda7e`.

Source rollback: reconstruct the checkpoint in a new directory and verify it before
switching working directories. Never apply a reverse patch blindly over this dirty
tree. Capture any later work first. Example:

```text
python scripts/verify/release/local-checkpoint.py --verify <checkpoint> <NEW-disposable-directory>
```

Database rollback is separate. Keep a consistent online SQLite backup before upgrade;
restore only after stopping the app. An older executable must not use a newer schema.
Restoring SQLite does not roll back accepted PostgreSQL facts: reconnect, reconcile
receipts/feed and preserve original pending operation identities before new writes.
No automatic schema downgrade or server reset is proposed.

## 2. Historical financial reconciliation

Full record-by-record output:
[`evidence/phase3-historical-reconciliation.json`](evidence/phase3-historical-reconciliation.json).

Classification concerns **original work/period/tariff attribution**, not merely whether
a command reached the server. Result: **VERIFIED 0; AMBIGUOUS 0; UNRESOLVED 216**.
Zero attribution writes were made.

Evidence examined in a repeatable-read, READ ONLY transaction on `novda_local_current`:

- All 216 original adjustments and their original quantities/status/provenance.
- Retained `change_log` payloads joined to same-company `operations_dedup` receipts,
  command/entity/operation IDs and independently recomputed canonical payload hashes.
- Both immutable period archives: JSON digest and tenant/period binding, original
  ticket/entry/worker/model/operation/rate evidence.
- Reconciliation candidate/resolution tables and retrospective baseline decision.
- Retained legacy worker-balance columns. All 216 adjustments reference ACTIVE
  workers; no inactive-worker filtering is concealing these records in this backup.

**194 MANUAL_CORRECTION** records have matching accepted server command evidence.
Their signed quantity subtotal is **−28**, not a currency amount. The original
payloads also omit original ticket, entry, period and rate attribution. Acceptance
proves the mutation existed; it does not establish its historical accounting month.

**13 REMOTE_SYNC** records have quantity subtotal **−889**; **9 REMOTE_BOOTSTRAP**
records subtotal **0**. These 22 imported records have no retained original command
payload in the current feed/dedup join. The baseline records 22 imported adjustments,
but no per-record original-work attribution. Net zero is not proof of cancellation.

All 216 rows have NULL original ticket/entry/period/rate fields. Reconciliation
candidate and resolution tables contain no rows. Neither archive embeds adjustment
identity that could establish that missing linkage. Creation timestamps, equal
quantities, operation-name matches, one apparent candidate or current tariffs are
not sufficient evidence and were not used to invent attribution. No conflicting
direct attribution was found, hence zero AMBIGUOUS classifications—not 216 verified
records inferred from a likely month.

### Opening balances

The retained baseline decision documents a retrospective import of a SQLite source
with SHA `7db7b8f2cbf2c9104107ce2a29b5d1d71ce36bfd0ac6db57a1adc317eb9b75b3`.
Its recorded local path `C:\Users\bekbo\Desktop\baza\hisob.sqlite` is absent in this
environment. This inventory decision is not accountant attestation of opening wages.

Raw current legacy columns total AVANS **2,020,000**, JARIMA **550,000** and worker
staj **5,740,000**. Fifty workers have a nonzero value in at least one of these
columns. These values are preserved, **not summed into a proposed opening balance**;
staj is a worker attribute and is not automatically a period ledger fact. The
existing 73 worker adjustments remain unchanged. Period-specific historical opening
balances remain UNRESOLVED / `HISTORICAL_BASELINE_UNVERIFIED`.

Integrity comparison against the preserved migration-22 reference confirms exact
equality of every common original column for all 216 production adjustments, all
73 worker adjustments and both full archive rows. See
[`phase3-original-financial-integrity.json`](evidence/phase3-original-financial-integrity.json).
New attribution columns remain explicitly unresolved; archive JSON and digests were
not rewritten.

Reporting keeps every unresolved record and its signed quantity. Its financial
amount is NULL with an explicit reason, never silently zero. Existing payroll/API/UI
incompleteness reasons remain active; displayed money is a resolved subtotal, not a
certified final wage. Resolution requires original work links or equivalent immutable
business evidence plus an explicitly reviewed reconciliation command. A restricted
prospective release would additionally require explicit business approval of its
scope and treatment of these historical facts; no such waiver was assumed.

## 3. Confirmed causes fixed in Phase 3

### P1: wrong SQLite profile reused

`databaseManager.cjs` cached connections solely by company ID. Opening the same
company in an isolated restore/upgrade profile returned the active profile's handle.
A regression reproduced the wrong file name before the fix. Cache identity is now
the canonical filesystem path (including resolved parent and Windows case handling).
Company-scoped close still closes all managed handles for that company.

Evidence: `profileIsolation.test.ts` verifies distinct files/data and reuse only of
the requested file. The packaged native-module upgrade/backup drill opens active and
restored profiles of the same company concurrently and verifies their independence.

### P1: future schema accepted by an older migrator

A coherent `schema_meta` / `user_version` greater than the application's supported
version previously passed `applyMigrations` with no pending migrations. The new
`SCHEMA_VERSION_NEWER_THAN_APP` guard fails before writes. Regression demonstrates
the old acceptance and verifies that the future profile remains unchanged.

### P1: desktop tariff editor converted unknown to zero

The admin path had been fixed in Phase 2, but `OperationRatesView.tsx` separately
cloned/reset `null` via `Number(rate) || 0`, parsed blank/invalid input as zero and
rendered explicit zero as an empty field. Editing an unrelated price could certify
unknown work as free work.

`operationRateDraft.ts` now explicitly represents unknown draft rates as NULL, keeps
explicit zero visible, validates before creating a command, rejects blank/invalid/
negative/nonfinite values, and preserves existing finite fractional-rate behavior.
The duplicated clone/reset implementation is removed. Pure regressions cover these
cases. Real App DOM acceptance checks blank versus `0`, blocked unknown save, then
explicit `0`/`9` through IPC → SQLite → sync → HTTP → PG; the original disposable
model tariff is subsequently restored. Payroll tariff policy is unchanged.

### P1: main-process fatal errors could leave the app running

The shipped main process logged `uncaughtException` and continued. Unknown main
state must not accept further financial commands. `runtime/diagnostics.cjs` now
records a bounded operational event and exits 1 on uncaught exceptions/unhandled
rejections, even if logging fails. Startup readiness failure also uses native exit 1.
Rotating local logs live under `<userData>/logs/desktop-events.jsonl` with one prior
file and a 256 KiB rotation threshold. Only whitelisted operational fields are
recorded: no payloads, arbitrary renderer text, tokens, URLs, SQL or personal data.
Modern Electron console-event handling replaces deprecated raw console forwarding.
Tests verify privacy, bounded retention and exactly-once termination. Packaged normal
startup/clean shutdown and the existing crash/durable-outbox regressions pass.

### P2/P3: structural and release-tooling debt

- Removed the confirmed UI dependency cycle by extracting the unchanged navigation
  predicate to `domain/modelRateStatus.ts`, retaining the old export contract.
- Corrected the obsolete relative migration-runner import to the authoritative PG
  registry. The literal-import graph now has no unresolved internal imports.
- Actual package inspection found a native-package FileSet re-including its README
  despite the top-level markdown exclusion. Tightened that FileSet; inspected local
  candidates contain no forbidden tests/server/scripts/docs/database/environment files.
- Added evidence-based reconciliation, module inventory and fail-closed release
  criteria; incomplete evidence cannot be converted into READY by a green unit suite.

One new acceptance composition exposed an existing **harness timing assumption**:
it sampled asynchronous draft persistence once after a 2-second sleep. The retained
SQLite profile subsequently contained both exact expected drafts, so this was not
evidence of renewed cross-model data loss. The harness now waits for the actual two
persisted values with a bounded 10-second failure budget. Both assertions remain;
no failing business behavior or test was skipped.

## 4. Dependency, ownership and data-flow artifacts

[`PHASE3-ARCHITECTURE.md`](PHASE3-ARCHITECTURE.md) contains the three requested maps:
module dependency diagram, explicit code-ownership map and command/recovery,
WebApp and archive/upgrade data-flow diagrams.

[`phase3-module-dependencies-final.json`](evidence/phase3-module-dependencies-final.json)
contains the file-level graph and hashes: **220 non-test source files, 608 literal
import edges, zero detected cycles and zero unresolved internal literal imports**.
The initial cycle was independently inspected before extraction. The scanner is a
literal-import heuristic, not a proof of no dynamic/Python/HTTP/IPC dependencies or
of no dead code. Healthy large modules were not rewritten simply because they are
large. Known coupling and remaining audit limits are explicitly listed in the map.

## 5. Real workflow and failure-recovery evidence

- Final `npm run verify`: **90 files, 762 tests passed**, one pre-existing payroll
  display skip; ESLint, TypeScript, protected-file integrity and production Vite build
  passed. Secret scan passed separately. No assertions were disabled.
- Disposable PG suite: **367 passed**, one pre-existing opt-in backup drill skip.
  Includes transaction-stage rollback, committed-response loss, concurrent exact
  dedup/conflicting commands, leases, operator throttling/revocation, stale revisions,
  tenant scope, bootstrap snapshot/cursor consistency and SQLite replay/recovery.
- Python bot tests: **37 passed and 176 subtests passed**.
- `novda_audit_phase3_verified`: fresh restore of the preserved dump, migrated to PG
  29, then actual two-process Electron 44.10.2 lifecycle acceptance. Device/operator
  credentials and production-equivalent PG grants are real; only the activation
  envelope is substituted in this isolated fixture. Real signing code is unchanged.
- **11,988 independent raw-SQL payroll comparisons** across 222 workers / 3 periods /
  9 fields / server+desktop, before deliberate acceptance mutations. Historical
  corrections remain explicitly unsupported by that independent oracle when resolved
  period-scoped corrections appear; they are not silently omitted.
- Real renderer → preload → IPC → SQLite/outbox → HTTP → PG → refreshed projection:
  offline AVANS, full process restart, interrupted HTTP, rehydration, repeated replay,
  ticket creation/edit/reassignment/VOIDED deletion, original saved rates, Oklad input,
  month close, next-period numbering and both legacy archives passed. Archive reads
  remain read-only; this does not introduce a business feature for reopening closed
  periods for writes.
- Post-lifecycle integrity: **29 PG migrations, 17 valid required FKs, all 16 orphan
  counters zero, baseline scope preserved, both original archive digests unchanged**.
  A second fresh `novda_audit_phase3_evidence` restore repeated the lifecycle and
  integrity checks with durable repository-local output (managed harness logs can
  expire). Neither audit database is the preserved reference or production.
- Fresh `hisob_test_bot8b1_phasethreea`: actual admin HTML/DOM/localStorage/Web Locks,
  signed routes, worker/admin bot logic and real PG passed. Independently expected
  net sequence **26 → 23 → 21 → 16**, exact-body lost-response replay, parallel/stale
  tabs, late period responses, unknown versus zero tariff, revoked sessions and
  cross-company rejection all passed. Telegram transport remains synthetic.
  `hisob_test_bot8b1_phasethreeb` repeated this unchanged acceptance with retained output.
- Batch-print acceptance on Electron 44.10.2 passed: four preview/generated-HTML
  tickets numbered 1–4, work **50 = 3×10 + 1×20**, model-local size definitions,
  guarded add/rename/delete, reopen/persistence and immutable old archive. Outbox is
  intentionally PENDING in this isolated print fixture; it is not proof of a PG print
  receipt or physical printing.

An earlier PG run had timeouts and was cut off by a 240-second harness limit; it is
retained as an unsuccessful attempt, not counted as a pass. Fresh reruns used
unchanged tests and no outer wall-clock cutoff. Existing synthetic `UNENTERED`
projection warnings and legacy browser-bound archive-URL fixture warnings remain
visible in the test output. They are not proof of production cleanliness and were
not suppressed or counted as newly fixed production bugs.

## 6. Desktop package, installer and compatibility

Local candidate directory:
`C:\Users\bekbo\AppData\Local\Temp\opencode\phase3-package-certified`.
The directory name is only a local fixture label, not release certification.

- Built actual Windows x64 Electron **44.10.2**, native better-sqlite3 and NSIS
  installer with `--publish never`. No host installation/uninstallation was run.
- Installer SHA-256:
  `93def355ca685d89b2716f42c9eff3c7600facdbf341ef86328033d2e4796ba8`.
- Packaged `app.asar` SHA-256:
  `ec3fba9efac0ce92d3091c733032d889ded10ed45d4d39e3df9d82bd309b890e`.
- Actual packaged `.exe`, with the real main/preload/renderer, opens the activation
  surface in an isolated blank profile, has a functional IPC bridge, denies unlicensed
  business reads, exposes no renderer `require`, and exits cleanly. **69 packaged
  source/build files** match the current checkout/build bytes; **210 archive entries**
  contain zero forbidden files. Test uses a loopback HTTPS sink with `NODE_ENV=test`;
  it does not substitute activation or certify an activated packaged production session.
- Packaged SQLite modules/native ABI migrated a synthetic on-disk existing **v15 →
  v25** profile. Ledger values, exact pending body/hash/operation ID and archive
  JSON/hash survived migration, reopen, online backup and recovery to another profile
  of the same company. Original v15 backup stayed intact. This complements, but does
  not replace, actual old-executable and Windows installer upgrade/rollback testing.
- Authenticode inspection says the candidate installer is **not digitally signed**.
  Builder's “signing with signtool” log is not proof of a valid signature.
- Hyper-V commands exist, but `Get-VM` was denied by host authorization. No elevation,
  VM mutation or workaround against a user's installed application was attempted.
- Canon MF3010 and Argox iX4-350 drivers are installed (plus Microsoft Print to PDF).
  Driver/queue status does not establish connected hardware or correct physical output.
  No physical page/label was printed or witnessed during this task.

### Required installer VM drill

In an authorized disposable Windows VM: snapshot; install the prior signed release;
load a copy of an existing profile; retain a pending offline command, ledger and
archive digest inventory; close and upgrade using the new signed installer; verify
startup/migration/replay exactly once; exercise running-process installer rejection
and NSIS diagnostics; restore the VM snapshot/pre-upgrade profile for the rollback
path; verify original file hashes and no duplicate server fact after reconciliation.
Never test old-binary rollback by opening a newly migrated schema, and never clear
user AppData or reset the server to make the drill pass.

## 7. Security and performance

Runtime dependency audit: **0 advisories**. Complete audit: **9 moderate affected
packages, 0 high/critical**. These are transitive/build/lint effects of the minimatch
globparts-amplification advisory `GHSA-g3hv-75wg-m249`, not nine independent runtime
CVEs. Affected installed minimatch families include 9.0.9 and 10.2.6; ESLint and
electron-builder chains are recorded in `phase3-security-audit.json`.

The advisory's fixed major is outside current dependency constraints. No forced
override, major downgrade or `npm audit fix --force` was used. A trusted-source local
build and zero runtime audit do not constitute release-owner acceptance of these
tooling risks or a complete security audit. Signing/activation/TLS and external
service acceptance remain separately blocked.

Read-only backup-size service measurement: **222 workers, 1,976 tickets, 3 periods**;
bootstrap JSON **13,041,272 bytes**. Ten local sequential snapshot calls: p50 **315.6
ms**, p95/max **646.8 ms**. Thirty all-worker payroll calls: p50 **43.6 ms**, p95
**298.4 ms**, max **307.1 ms**. Zero errors/writes; Node RSS observed **338,296,832
bytes**. Local cache state is not controlled; first calls are included. These are
service/SQL measurements, not network/TLS/UI tail latency, memory leak, multi-device
capacity or an approved operational SLO. The large bootstrap and repeated hot-path
integrity checks deserve measured follow-up, not speculative removal of validation.

## 8. Remaining issue classification and objective gates

All entries below remain release-blocking for the full requested scope until verified
or an explicit business/release-owner-approved restricted scope is documented.

- **P1 / historical financial integrity / reproduced missing evidence:** 216 unknown
  original-work attributions and unverified opening balances. Impact: historical
  payable totals cannot be certified. Required owner: accountable finance/business
  approver with original evidence; engineering must preserve uncertainty meanwhile.
- **P1 / installer recovery / environment-blocked:** actual old→new upgrade and
  rollback in a disposable Windows VM unverified; Hyper-V access denied. Impact:
  installation/profile recovery behavior not operationally certified.
- **P1 / signing, activation and TLS / observed unsigned artifact + unverified staging:**
  candidate is unsigned; approved staging activation/reverse proxy is unavailable.
  Impact: cannot certify release identity, trust path or operational API deployment.
- **P1 / critical external workflows / not exercised:** physical print output and
  live authorized Telegram staging. Drivers and synthetic envelopes are insufficient.
- **P2 / dependency/security / reproducible audit:** nine moderate tooling/package
  advisories require a compatible upstream update or an explicit reviewed exception.
- **P2 / operational capacity / measured partially:** local numbers exist, but SLO,
  concurrency/capacity and realistic network/UI latency are not approved.

Non-blocking technical debt absent a demonstrated production failure: large modules,
unrecertified old universal-harness modes, two inherited test skips, synthetic fixture
warnings, narrower nonnullable generic operation types versus historical unknown
values, and incomplete independent resolved-correction/reversal oracle coverage.
These remain explicit work, not a zero-debt claim.

`scripts/verify/release/release-gates.cjs` defines 13 objective criteria with documented
expected outcomes. It rejects missing/duplicate/unknown gates, stale source
fingerprints and missing/changed artifact SHA-256s. There is no automatic waiver.
PASS records attest only the documented scope of their evidence, not untested external
services. Full release requires all criteria; the current result is **NOT READY**:
**6 PASS, 7 BLOCKED**. The evidence fingerprint is
`5492e26720a94a4f5a32fcd3973b8d6e48b4f2615fa1c3844551ef20a4ab1246`.
It binds non-test application/shared source and build configuration; evidence files
have separate content hashes. These are local tamper/staleness checks, not signed
attestations or a substitute for code/release-owner review.

```text
node scripts/verify/release/release-gates.cjs ops/docs/evidence/phase3-release-gates.json
```

Exit 1 is expected while gates remain blocked. Evidence and evaluated result are
retained with the report. A future source change invalidates prior PASS fingerprints;
rerun relevant acceptance and regenerate reviewed evidence rather than editing the
verdict or treating old test output as current proof.

### Reproduction entrypoints

Use fresh explicitly disposable loopback databases for mutation tests; never use
`novda_local`, `novda_local_current` or an existing seeded bot harness as a reset target.

- `npm run verify`; `npm run verify:secrets`.
- PG suite: opt-in `NOVDA_DISPOSABLE_PG=1`, explicit fresh `NOVDA_PG_URL`, direct node
  Vitest command from the Phase 2 report; no ambient `DATABASE_URL`.
- Backup lifecycle: `NOVDA_AUDIT_DISPOSABLE=1`, fresh restored/migrated `/novda_audit_*`
  loopback DSN, then `node scripts/verify/database/backup-workflows.cjs --desktop --lifecycle`.
- Read-only reconciliation: set explicit guarded `NOVDA_AUDIT_PG_URL`, then
  `node scripts/verify/database/historical-reconciliation.cjs <NEW-report.json>`.
- Module graph: `node scripts/verify/release/architecture-inventory.cjs <NEW-graph.json>`.
- Packaged startup: `node scripts/verify/release/packaged-smoke.cjs <disposable-package.exe> <NEW-output-directory>`.
- Packaged native upgrade: `node node_modules/electron/cli.js scripts/verify/release/profile-upgrade-electron.cjs <app.asar> <NEW-output-directory>`.

**Production readiness decision remains NOT READY.** The next work is not another
cosmetic refactor: obtain finance evidence/approved scope and an authorized signed
staging/Windows VM/hardware release-validation environment, then rerun the blocked
criteria against the exact release artifact.
