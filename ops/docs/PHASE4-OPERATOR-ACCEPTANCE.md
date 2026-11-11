# Phase 4 — operator acceptance and recovery runbook

Status: **NOT EXECUTED externally**. These procedures are prerequisites, not PASS
claims. Each signoff must identify operator, UTC time, source fingerprint, installer
and app.asar SHA-256, environment, expected/actual result and retained evidence. No
production credentials/data or live user machines are authorized by this document.

## 0. Inputs and safety boundary

Release owner must supply an authorized disposable Windows VM with snapshot/restore,
prior signed installer(s), approved release certificate/thumbprint and timestamping,
staging-only activation/device/operator/bot credentials, isolated staging tenant,
approved staging TLS/DNS routing, printers plus an attending operator, and approved
capacity/SLO and financial-review criteria. Use a consented copy of financial data
only in the isolated environment. Do not copy DPAPI credentials between Windows users
and call that an activation test; provision an authorized staging device instead.

Export tracked source to a new input directory (no `.env`, keys, browser profiles or
production credentials). Never map a user's live AppData, install folder or repository
secrets into a destructive installer matrix. Host remains untouched.

## 1. Signed artifact and installer upgrade / rollback

### Signer workstation (authorized release operator only)

1. Clean, reviewed source at the recorded local commits; `npm ci`; run verification.
   Provide signing access via the approved credential system, not committed files.
2. Set `NOVDA_RELEASE_SIGNER_THUMBPRINT` to the approved certificate thumbprint and
   run `npm run dist:rc`. This entrypoint now requires Windows/signing identity,
   forces builder code signing, then verifies Authenticode, signer, timestamp and hash.
   `dist:local` is for unsigned engineering fixtures, never release signoff.
3. Independently verify installer **and** installed/packaged executable; substitute
   actual recorded values, not the example placeholders:

```powershell
powershell.exe -NoProfile -NonInteractive -File scripts\verify\release\verify-windows-signature.ps1 `
  -Artifact '<signed-installer.exe>' -ExpectedSha256 '<64-hex-SHA256>' `
  -ExpectedSignerThumbprint '<40-hex-approved-thumbprint>'
```

Expected: exit 0, `PASS`, `Valid`, expected signer, timestamp present and hash match.
Unsigned/wrong signer/hash/expired trust without a valid timestamp: exit 1; STOP.
Never disable certificate checking or edit the verifier to get a pass.

### Disposable VM: real profile lifecycle (mandatory, not replaced by NSIS matrix)

1. Snapshot **VM-A**, disable production network access, verify DNS/route points only
   at approved staging. Record old installer hash/signature; install it per-user.
2. Seed an authorized copied existing profile, keep exact archive JSON/digests,
   payroll totals with uncertainty labels, ledger rows and operation IDs/body hashes.
   Add a staging offline pending financial command using the old app; stop it.
   Make a consistent online SQLite backup, not a raw main-file copy with missing WAL.
   Retain the full stopped userData/credential inventory privately. Do not publish it.
3. Install the new signed candidate. Verify install location/appId/per-user scope and
   shortcut targets remain unchanged. Start it; expect migration to v25, creation of
   `NovdaData\companies\<company>\pre-upgrade\vN-to-v25-*\profile.sqlite` plus manifest,
   intact ledger/archive/pending operation bodies, no duplicates and valid FK checks.
4. Reconnect to staging. Expect the original operation ID exactly once in PG receipt
   and financial ledger, cursor/feed caught up, no silent pending/conflict/dead-letter
   loss. Independently compare money, ticket count and archive digests before/after.
5. Close/reopen again; exercise offline restart and response-loss/replay. Capture
   desktop event log, installer exit status, versions, hashes, PG dedup/ledger proof.
6. Exercise upgrade while the old app is running. Expect it to be stopped gracefully
   or the installer to refuse safely; no locked-file replacement or lost local facts.
7. **Rollback:** stop writes/network sync; retain failed new profile and installer
   evidence; restore VM-A or install the prior signed release with a **compatible
   pre-upgrade backup into a new profile**. Never open schema v25 with an old binary
   expecting an older schema. Never reset PG. Reconcile any server-accepted operations
   since the backup by original IDs/status/feed before allowing new intent. Verify
   archive/ledger/body hashes and one server fact. This is the rollback acceptance.

`restoreCompanyDatabase` intentionally refuses existing target DB/WAL/SHM and
cross-company data. Recover to a new directory; move the stopped old directory aside
manually only after preserving it. If a restore fails, the original remains usable;
do not delete WAL files. Keep pre-upgrade snapshots until the operator confirms
recovery and retention policy; the app does not prune them automatically.

### Optional Windows Sandbox fault matrix

`ops/windows-sandbox/nsis-upgrade-matrix.wsb` now uses operator-prepared
`C:\NovdaReleaseInputs\{Project,Installers,LegacyPayload,TestOutput}`. Project is a
tracked-source export; installer/payload mappings are read-only; networking and
clipboard are disabled. Supply the 1.7.12 installer, preserved 1.7.13 payload, final
candidate, synthetic SQLite fixture and compiled exit-code-2 uninstaller fixture
required by `nsis-upgrade-matrix.ps1`. Review that script first: it deliberately
deletes **sandbox** installation/registry/profile fixtures. It rejects ordinary host
execution unless the explicit switch, opt-in and WDAG sandbox account all match.

The matrix checks A/B ordinary/overlaid upgrade and G/H old-uninstaller exit-2 recovery
versus running-process abort. PASS now includes byte-for-byte userData preservation
(previously only reported). An offline sandbox may not establish trust/revocation
network checks: verify signatures separately. Synthetic marker/profile preservation
does not replace real old/new app startup, activated flow or backup-based rollback.

## 2. Activation and TLS staging

Prerequisites: authorized TLS reverse proxy, trusted certificate chain, activation
signer/service compatible with the exact binary, staging tenant/operators, explicit
outbound allowlist. Current production build pins the approved API origin. **Do not
silently use NODE_ENV=test/development to claim production-mode staging.** Obtain an
approved isolated DNS/hosts route for the pinned hostname with production egress
blocked, or obtain approval to pin an explicit staging origin in a distinct build
and regenerate all artifact/source evidence. Never guess a staging URL or loosen TLS.

1. Verify DNS and proxy upstream are staging before startup; capture redacted proof.
2. Fresh unlicensed profile: activation request → operator approval → signed envelope
   verification → OS-protected device credential → operator login → authorized read.
3. Close/reopen; ensure activation/session persistence. Log out/revoke/expire; ensure
   subsequent financial writes fail and stale UI cannot restore authority.
4. Reject tampered/wrong-device/foreign-tenant envelope, untrusted/expired TLS chain,
   HTTP downgrade, foreign redirects and renderer company/license reassignment.
5. Proxy a committed response loss; same ID/body retry must return the original
   receipt with no duplicate financial row. Keep correlation IDs, not bearer tokens.

Expected: normal flow succeeds only through trusted staging TLS; all negative cases
fail closed, with bounded operational diagnostics and no unauthorized writes.

## 3. Physical printing

Prerequisites: attending operator, actually connected Canon MF3010 and Argox iX4-350,
approved paper/label size/orientation/DPI/margins, staging print-role account.

Use deterministic two-model batch: 3 pattas at work 10 (M/XXL/XXL), one at work 20
(L). Compare persisted batch, preview, generated HTML and **four physical outputs**:
numbers 1–4, model/party/size/color/date, work 50 total, layout/barcode legibility if
applicable, no clipping. Photograph or scan output with operator approval.
Test cancel, offline printer, queue error and retry; document whether data was already
committed and which action is a reprint. Never create a second numbered batch just to
retry transport. Reconnect; prove exact batch receipt in PG and no duplicate sequence.
Spool callback/driver presence alone is not paper-delivery evidence.

## 4. Authorized live Telegram

Prerequisites: staging bot token stored privately, permitted private chat/test users,
staging WebApp HTTPS origin and webhook/polling configuration, scoped admin/worker
accounts. No unsolicited production messages.

Verify actual Telegram delivery and WebApp initData validation: worker binding,
profile/current and closed period, known zero versus unknown price, incomplete wage
label, admin period selection and one financial write. Test duplicate click/update,
network loss/reopen, revoked/expired session, foreign company, group-chat privacy and
late old-period response. Capture sanitized message/update IDs, expected money and
PG dedup proof, never tokens/contact details. Local synthetic envelopes are supporting
contract evidence only. Remove staging test bindings through approved staging flows.

## 5. Capacity / SLO

Prerequisites: release owner approves concurrent devices/users, data size, scenario
mix, p50/p95/p99 latency budgets per route/UI action, error budget, memory ceiling,
duration, reconnect recovery target and server resource size **before** the run.

Use a fresh staging backup copy with 222+ workers / 28,700+ entries; include real TLS,
admin tabs and desktop UI. Warm-up separately; retain cold and warm samples. Increase
load in bounded steps through the approved device target, then sustain for the
approved interval (include a ≥60-minute soak if required by the owner). Mix bootstrap,
payroll, ordinary writes, simultaneous edits, offline replay and period close; stage
period closes in disposable tenants. Record server/client RSS, event-loop delay, PG
pool wait/locks, per-route latency/error/retry counts and all integrity/dedup checks.
Abort at approved safety limits. Compare against **approved** thresholds, not invented
post-hoc numbers. This task's 3-way/9-request loopback HTTP run cannot certify endurance,
WAN/UI latency or memory leaks. Existing full SQLite health checks remain enabled.

## 6. Historical financial signoff

See `PHASE4-FINANCIAL-BUSINESS-REVIEW.md`. Finance must supply original source and
review every unresolved ID or approve a specifically bounded release scope. Imported
quantities, dates, a current tariff workbook or a net-zero group are not attribution.
Opening wages must reconcile by worker and period to original ledger/paid balances.
No code path may convert unknown money to zero or hide it in a final-wage label.

## 7. Gate submission

Keep current tests and exact-artifact evidence; submit signed operator results plus
artifact hashes to the release owner. Update gate inputs only after review. Run:

```text
node scripts/verify/release/release-gates.cjs ops/docs/evidence/phase4-release-gates.json
```

Expected now: exit 1 / NOT READY. A locally green suite or this runbook cannot approve
missing hardware, finance, signing, upstream dependency risk or staging results.
