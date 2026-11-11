# Phase 4 — release blockers and final local engineering hardening

**Verdict: NOT READY — 6 PASS / 7 BLOCKED, full Phase 3 release criteria unchanged.**

Locally reproducible source defects found during this phase are fixed and validated.
Remaining blocked requirements need an authorized external environment, finance
primary evidence, or an upstream-compatible dependency fix/release-owner decision.
No production connection/credentials, push, deployment, host installation, registry
change, or physical print was used. Original installed business data was copied for
read-only investigation, never migrated in place. Healthy modules were not rewritten.

## 1. Preservation and reviewable local commits

- Phase 3 final checkpoint was reconstructed into a **new** disposable directory:
  `C:\Users\bekbo\AppData\Local\Temp\opencode\phase4-baseline-restoreproof`.
  All **502 files** matched SHA-256. Current baseline files also matched that manifest
  before any Phase 4 edit. Earlier Phase 1–3 fixes and regression assertions survived.
- Prior uncommitted source/tests/runners were committed as `c3668fe`; original reports
  and evidence separately as `b58fb17`. These preserve the inherited work, including
  the Python driver renames; they do not claim all of it was authored in Phase 4.
- `fed935e`: automatic pre-upgrade snapshot, schema compatibility and safe restore.
- `119eccb`: conflicting archive tenant identity rejected by both payroll readers.
- `1b3a3d0`: compatible builder refresh, signed-RC requirement, sandbox acceptance fence.
- `f20ba20`: scoped historical/capacity/integrity runners and stronger evidence binding.
- `357f0c5`: acceptance of discovered original-profile copies with packaged modules.
- Final evidence/docs are a separate local commit. No commits were pushed. Inspection
  of package-lock changes confirmed **no runtime dependency version changes**. Npm's
  incidental line-ending reformatting was minimized while retaining prior mixed EOLs.

Source rollback: reconstruct the retained Phase 3 checkpoint in a NEW directory;
verify before switching. For individual Phase 4 changes, review/revert the logical
commit in a separate branch/checkout. Never reset or overwrite a later dirty tree.
Source rollback does not downgrade a SQLite file or reverse accepted server facts.

## 2. Engineering-controlled causes resolved

### Profile compatibility and recovery — P1

Six new negative tests initially reproduced unsafe behavior; the expanded suite now
also covers cached inspection handles and restore-publication failure.

- Future-schema rejection now applies before WAL/header changes and through
  `skipMigration`, including managed-cache access. Existing explicit
  `SCHEMA_LINEAGE_MISSING` behavior remains preserved.
- A cached old profile opened for inspection no longer bypasses a later normal upgrade.
- Before forward migration of a nonempty schema lineage, the manager creates a
  standalone `VACUUM INTO` snapshot (committed WAL included), verifies schema/integrity/
  FKs, flushes it and records its SHA/versions. If snapshot creation fails, migration
  does not start. No retention pruning or speculative repair of business data.
- Backup destination equal to the active database is refused explicitly.
- Restore validates source schema, integrity and every table's tenant column; it
  refuses a non-standalone WAL source, a foreign tenant, and existing target DB/WAL/SHM.
  A staged verified copy is published with an atomic no-overwrite filesystem link.
  Unsupported linking fails safely; no destructive fallback. Restore no longer closes
  another active profile of the same company or deletes a potentially newer WAL.

This intentionally tightens the maintenance helper's contract: restore to a **new
profile**, never blindly overwrite one. Its only callers are maintenance acceptance
runners/tests, not a changed payroll or user-facing financial command. Operator
recovery steps are explicit in `PHASE4-OPERATOR-ACCEPTANCE.md`.

### Archive tariff tenant binding — P1

Both server and desktop trusted a correctly hashed closing archive even when its
top-level company contradicted the requested tenant and its nested period. Before
the fix, a 12-piece fixture incorrectly valued the foreign tariff at **11,988**.
Both readers now refuse the conflicting top-level binding and expose unknown tariff
and `CLOSED_TARIFF_UNAVAILABLE`, not certified zero wages. Existing legacy optional
identity compatibility and genuine zero-price behavior are preserved. No archive
bytes/digests or shared payroll arithmetic were changed.

### Release and installer tooling — P1/P2

- `dist:rc` requires Windows and an explicitly approved signer thumbprint, forces
  code signing, and independently checks final hash/Authenticode/signer/timestamp.
  Unsigned local builds still exist via the clearly separate engineering build path.
  A signtool log or matching hash alone cannot report RC success.
- The existing destructive NSIS fault matrix now refuses ordinary host execution;
  it requires explicit opt-in, switch and the Windows Sandbox account. Its PASS
  predicate now **requires** userData preservation, previously only reported.
- The `.wsb` uses a prepared secret-free project export and consistent paths rather
  than obsolete host source paths; production networking/clipboard remain disabled.
- Electron-builder **26.15.3 → 26.18.0**, compatible 26.x, built and exercised locally.
  Electron/runtime remains pinned **44.10.2**; PostgreSQL 29 and SQLite 25 unchanged.
- Release fingerprint now includes tests, verification runners and deploy/installer
  source as well as application/shared code and config. Evidence is separately hashed.
  Old Phase 3 gate inputs correctly become stale under the stronger policy; historical
  reports are preserved, not relabelled current. No waiver or criterion was removed.

## 3. Real local evidence

Retained under `ops/docs/evidence/phase4-*`, with before/failure attempts also kept.

- Full final verify: **92 files / 773 tests PASS**, one inherited skip, ESLint,
  TypeScript, protected-file integrity and production build. Python **37 tests / 176
  subtests PASS**. Secret scan and `git diff --check` pass.
- Fresh `hisob_test_phase4_final`: **368 PG tests PASS**, one inherited opt-in skip.
  Atomicity, response-loss replay, concurrency, revisions, auth/session/tenant and
  sync regressions remain enabled.
- Fresh restored `novda_audit_phase4_final`: real two-process Electron restart and
  offline replay; tariff editor, eight views, independent model drafts, AVANS,
  ticket lifecycle/reassignment/deletion, saved wage snapshots, Oklad DOM blur,
  month close and legacy archive read passed. **11,988 independent raw-SQL payroll
  comparisons** passed. Only the isolated fixture's activation envelope is substituted;
  this is not signed production activation proof.
- Original financial rows after lifecycle: all common original columns of **216
  production adjustments, 73 worker adjustments and both full archive rows** equal the
  migration-22 reference. **29 migrations, 17 valid FKs, 16 zero orphan counters** and
  baseline scope preserved. No historical attribution writes.
- Fresh `hisob_test_bot8b1_phasefoura`: actual admin DOM/storage/locks and local signed
  routes passed the independently expected **26 → 23 → 21 → 16**, repeated/lost-response
  intent, stale tabs/periods, unknown/zero rate, tenant and revoked-session checks.
  Telegram envelopes/transport are synthetic, not live messaging certification.
- Print preview/generated HTML/local persistence: 4 pattas numbered 1–4, work
  **50 = 3×10 + 1×20**, archive unchanged. Physical output and a PG print receipt are
  not claimed; this fixture deliberately leaves its outbox PENDING.

### Actual desktop artifacts and profiles

Candidate: `C:\Users\bekbo\AppData\Local\Temp\opencode\phase4-package`.
It is an **unsigned engineering fixture**, not a signed release.

- Installer SHA: `412a6e2fa620920a0c24be35bcc8a3f88df6f1ee8b5d5f6b7aa3c3580860128f`.
- app.asar SHA: `a4320c45d153df33cae944d7174b94a889e6a970ad19cf614ee49c1ed5666b8e`.
- Actual packaged executable/main/preload/DOM/IPC started, denied unlicensed reads,
  preserved renderer sandbox and exited 0. **69 source/build files** matched and
  **210 archive entries** contained no forbidden files. Startup uses an isolated
  unlicensed profile and loopback sink under NODE_ENV=test, not activated production.
- Packaged native SQLite synthetic **v15 → v25** retained exact ledger/archive and
  pending command ID/body/hash, automatic pre-upgrade snapshot, reopen and backup
  recovery. Existing-target/foreign-tenant restore was refused without closing active
  data; both independent health checks passed.
- **New original-profile evidence:** discovered copies of **three v18, two v19 and
  one v25** profiles all reached/reopened v25 with every original business column and
  outbox body/hash/ID preserved. This includes the current 28,715-entry profile and
  historical 3,002-entry profiles (one v19 is empty, not claimed as financial evidence).
  Automatic backups for all five older lineages and online backup/restore passed.
  Legacy SYNCED statuses did not invent receipts; no migration-19 retry qualified in
  these copies. No original AppData paths, credentials or network were opened by this
  packaged-module acceptance. It is still not an actual old-executable/NSIS upgrade.

### Honest failed attempts

The initial full verify caught two implementation issues introduced during Phase 4:
Windows fsync needs a writable backup handle; eager schema checks initially changed
the inherited missing-lineage error contract. Both were fixed without changing the
expected assertions, and full verify was rerun. The original-profile harness first
overrequired unchanged SHM (a reader index), then tried to hash app.asar through
Electron's virtual filesystem; it now validates durable main/WAL content, reconstructs
SHM in a fresh copy and uses original-fs for raw archive hashing. Those harness errors
were not counted as profile failures or hidden. The final six-profile run passed.

## 4. Historical evidence and business decision

Additional read-only discovery found six installed-profile SQLite files and two JSON
business backups. Copy stability and original source hashes were verified; no license
or credential files were read. All 216 IDs appear in the current profile, with **81**
matching outbox payloads. Four older copies contain overlapping 31-ID sets and 9
payloads each. **None supplies complete original ticket/entry/period/rate attribution**;
none matches the recorded original v15 baseline hash.

Classification remains **0 VERIFIED / 0 AMBIGUOUS / 216 UNRESOLVED**. No record was
forced to VERIFIED. Opening balances remain `HISTORICAL_BASELINE_UNVERIFIED`.
`PHASE4-FINANCIAL-BUSINESS-REVIEW.md` specifies primary evidence required per exact ID,
opening-wage reconciliation, approver/custody fields and the explicitly approved
restricted-scope alternative. Discovery does not prove historical amounts are wrong;
it establishes that currently available artifacts cannot certify the missing links.

## 5. Dependencies, capacity and justified debt

Runtime audit **0**; full audit **9 moderate, 0 high/critical**. Compatible builder
refresh does not fix minimatch `GHSA-g3hv-75wg-m249`: latest ESLint 10.14.0/config-array
still require 10.x and builder/universal require 10.x/9.x, while the fix starts at 11.0.1.
No compatible 9.x/10.x patch was published in the checked registry. No force override,
unsupported parser, major downgrade or unapproved risk waiver was introduced. This
gate now requires an upstream-compatible fix or explicit release-owner risk decision,
not further safe patch-level code work available locally.

New bounded HTTP measurement used real device-auth/Fastify/PG/bootstrap/client JSON
parsing: **3 concurrent requests × 3 rounds = 9**, each 13,041,626 bytes; zero errors
and unchanged business/receipt counts. p50 **1,523.6 ms**, p95/max **2,643.0 ms**;
RSS after rounds **267,591,680 / 306,003,968 / 307,736,576 bytes**. It includes local
resource contention and is not a controlled before/after benchmark. No invented SLO,
memory-leak or endurance claim. Full SQLite health checks remain enabled; removing
them or redesigning bootstrap without an approved measured latency requirement would
be a speculative safety tradeoff, not a justified release fix.

Architecture remains the Phase 3 ownership/data-flow design. Delta: databaseManager
owns pre-upgrade preservation; restore is explicitly isolated/no-overwrite; release
tooling owns signature and fixture safety. No new service layer or business arithmetic.
Literal-import inventory: **225 source files / 614 edges / 0 detected cycles / 0
unresolved literal internal imports**, with the same heuristic/dynamic-edge limits.
Large modules, two inherited test skips, synthetic fixture warnings and the independent
oracle's explicit resolved-correction guard remain documented non-blocking debt, not
proof of exhaustive code cleanliness or universal financial certification.

## 6. Actual gates, prerequisites and rollback

Current source fingerprint:
`2e2111edc3f5ee62f8cc2bc9b6bbe14bce74ec29479c639b255cf81bc220d512`.

PASS: engineering, API recovery, backup lifecycle, historical inventory, packaged
startup, profile upgrade. BLOCKED (unchanged scope):

1. Historical signoff — primary per-record attribution and period opening ledger, or
   explicitly approved restricted release scope from finance/business owners.
2. Installer upgrade/rollback — authorized disposable Windows VM/snapshot and prior
   signed release/profile; perform actual old/new startup and receipt reconciliation.
3. Security — compatible upstream minimatch fix or accountable tooling-risk acceptance.
4. Signing/activation/TLS — approved certificate/timestamp and isolated production-mode
   staging DNS/TLS/activation; candidate remains Authenticode `NotSigned`.
5. Printing — attending operator and physical Canon/Argox output, plus staging receipt.
6. Telegram — permitted staging bot/chat, real WebApp HTTPS origin and live delivery.
7. Capacity — approved workload/SLO/resources and realistic TLS/UI concurrent soak.

Every requirement has expected outcomes, negative tests, evidence and recovery steps
in **`PHASE4-OPERATOR-ACCEPTANCE.md`**. Existing VM denial was not bypassed, and the
destructive matrix was not executed on the host. No new external access was assumed.

Reproduce local evidence with `npm run verify`, scoped fresh PG/bot/backup commands
from Phase 3 and the retained Phase 4 runners. Use **new output directories/files**;
never reset the preserved reference or reuse a seeded bot fixture as a fresh target.
The original-profile runner requires the retained hash-checked discovery snapshots;
it refuses to fall back to opening live AppData. Run the evidence assembler only
after the specified outputs pass:

```text
node scripts/verify/release/phase4-evidence.cjs
node scripts/verify/release/release-gates.cjs ops/docs/evidence/phase4-release-gates.json
```

Assembler creates new files and refuses overwrites; preserve prior attempts. The gate
command intentionally exits **1 / NOT READY**. Initial Phase 4 gate/package receipts
are retained separately; final receipts include original-profile acceptance. Evidence
hashes are local staleness checks, not signed attestations. Any source/test/runner
change requires renewed relevant evidence, never manually editing the verdict.

**Recovery:** stop app/sync; preserve failed profile, WAL and logs; restore the verified
compatible pre-upgrade snapshot into a new same-company directory; use the matching
signed binary; reconcile later accepted PG operations by original IDs/status/feed
before new financial commands. Do not delete WAL, downgrade schema in place, infer
missing historical money or roll back PostgreSQL to match an old desktop backup.

**Final production decision: NOT READY.** Engineering evidence is stronger and the
identified local source defects are resolved. The seven external/upstream/business
prerequisites remain concrete release blockers, not manufactured passes.
