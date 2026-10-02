# Novda Hisob-Kitob — Production and Project Guide

**Authoritative project document. Status captured 2026-10-01.**

This document combines current operating guidance, product usage, architecture,
release history, verification commands, and outstanding qualification gates. Older
root-level plans, audit reports, transcripts, and runbooks were reviewed and
consolidated here. The `admin-bot` and `worker-bot` are separate runtime services
and Docker build contexts within the main repository.

## 1. Safety and data authority

- PostgreSQL is the authoritative source for business data. The company scope
  is `comp_novda`.
- Never use production PostgreSQL for tests. Run PostgreSQL tests only after the
  repository's isolated PostgreSQL 16 preflight succeeds.
- Preserve all local userData, SQLite databases, backups,
  business exports, credentials, and evidence unless a specific authorized
  operation says otherwise. Do not use broad cleanup, reset, or restore commands.
- Do not modify the IELTS project, its services, data, network, TLS, Nginx, or
  volumes. This session did not access or modify IELTS.
- Business-data import and production deployment require a specifically
  authorized operation, an independently verified target, a backup, and
  post-import reconciliation. Routine source work alone does not authorize them.
- Production services run on the VPS using Docker Compose, systemd, and Nginx.
- Never put secrets in source, reports, shell history, command-line arguments,
  logs, or browser storage. Only public verification keys may ship in the client.
- Protected source files must remain byte-identical:
  - `apps/desktop/renderer/store/helpers/syncMerger.ts` — SHA-256
    `38c1b7457fc98ecc9ecbdf8643d97c201316568ba4ad8d3db59fad40f2e9e8ff`
  - `apps/desktop/renderer/store/slices/createPattaBatchSlice.ts` — SHA-256
    `b46d7b37b8284f6810ca84ba5cbb7f0549f1bfca43fc7d78a04618ace22a8d1d`

## 2. Current status

### Repository and client

- Canonical project package and lockfile version: **1.0.0**.
- Git branch/HEAD at deployment capture: `main`, `ec52cc7`, synchronized with
  `origin/main`.
- SQLite schema source lineage is at migration 15. PostgreSQL source migration
  lineage is at migration 17. The supplied `comp_novda` SQLite candidate reports
  schema version 15 and passes `PRAGMA integrity_check`.
- Application identity remains `com.novda.hisob` / `Novda-hisob-kitob`, Electron
  44, Windows x64, per-user NSIS installation. Electron user data is under
  `%APPDATA%\novda-hisob-kitob`; do not uninstall or clear it as a troubleshooting
  shortcut.
- The release builder is local-only, verifies the exact version, and refuses to
  overwrite an existing artifact. The former auto-publish release workflow was
  removed. Do not reintroduce a build command that commits, pushes, publishes, or
  writes hosting-provider metadata.

### Authorized initial data source and deployment status

The owner identified `C:\Users\bekbo\Desktop\baza\hisob.sqlite` as the
corrected in-progress database for `comp_novda`. This supersedes the older
2026-09-24 baseline as the intended business-data source; those earlier counts
are historical evidence, not current truth.

Read-only local inspection on 2026-10-01 recorded:

- SHA-256 `7db7b8f2cbf2c9104107ce2a29b5d1d71ce36bfd0ac6db57a1adc317eb9b75b3`;
- 209 workers, 20 models, 54 parties, 1 period, 3 tickets, 36 ticket entries,
  63 worker adjustments, and 22 production adjustments;
- 2 active legacy Party #2 exceptions, 20 model ID aliases, and 52 party ID
  aliases;
- 3 local ticket-form entries containing transient form defaults. These are
  intentionally not part of the shared baseline import;
- `local_outbox`: 231 `SYNCED` and 111 `DEAD_LETTER` records. The
  `DEAD_LETTER` records remain local and are excluded from the server baseline
  import; import the canonical business tables only.

The verified SQLite file is staged at `/srv/novda/import/comp_novda.sqlite`
with mode `0400` and owner `1000:1000`; its hash matches the local source above.
`local_outbox`, including all 111 `DEAD_LETTER` entries, was not imported.

The VPS had a pre-existing `novda_prod` database despite the earlier expectation
that it was empty. It was preserved under database name
`novda_prod_pre_sqlite_20261001t190411z` and exported to
`/srv/novda/import/novda_prod-pre-sqlite-20261001T190411Z.dump` (mode `0600`;
`pg_restore --list` verified the dump). The new `novda_prod` database was created
separately, leaving the prior database available for rollback or reconciliation.
The three PostgreSQL role passwords were aligned with the protected Compose
environment without exposing their values.

PostgreSQL migrations 1–17 are installed and release-integrity verification
passed. The guarded SQLite importer first passed dry-run with the exact source
hash and expected counts, then applied the baseline transactionally. Imported
counts: 209 workers, 20 models, 54 parties, 1 period, 3 tickets, 36 ticket
entries, 63 worker adjustments, and 22 production adjustments; 2 Party #2
exceptions and the canonical ID aliases/settings were also imported. Transient
ticket forms and local sync state were excluded.

The Novda API, PostgreSQL, admin bot, worker bot, and dedicated Cloudflare tunnel
are running. Internal API health and public
`https://sync.novdatextile.uz/health` both returned HTTP 200 with status `ok`.
The post-import PostgreSQL counts match the authorized SQLite baseline. The
pre-import database dump and renamed database must be retained until the owner
confirms no further reconciliation or rollback is needed.

An owner-approved license-signer rotation generated the new VPS private key at
`/srv/novda/secrets/bots/novda-license-ed25519-private-key`; its public
fingerprint is
`ce8ddbad7b368f8d0896e3f2d8d5c78545be0cb1c14755d3350a24f5a4bfdf68`. The
source retains the previous public key for verifying existing licenses and pins
new activations to the new signer. A desktop client update must be qualified
and delivered before issuing licenses signed by the new key. An authenticated
device-to-server bootstrap/sync round trip has not yet been verified from an
installed client.

### Runtime classification

- Electron startup uses local SQLite and authenticated sync to the API;
  outbox operations are idempotent and company-scoped. PostgreSQL is the remote
  authority.
- Admin and worker bots use the authenticated API; bot containers do not
  connect directly to PostgreSQL. The Admin bot is the only production Ed25519
  signer; the worker bot must never receive the signer private key.
- The VPS API and PostgreSQL are the only supported server and data authority.
- The source contains local-data migration paths. Do not interpret those paths as
  authorization to restore retired external data providers or legacy full-array writes.

## 3. Product and domain guide

The Windows desktop application supports factory worker, garment-model,
operation/rate, party/patta, ticket entry, payroll, period, archive, and Excel
workflows. Main UI areas are the general payroll sheet, party batch/printing,
party audit, conveyor view, model ticket entry, model operation/rate sheet,
worker management and detail, period management, and backup history.

- **Workers:** each worker ID identifies one worker. Do not reuse IDs or invent a
  Telegram binding. `staj` is deducted in the net-pay formula according to the
  approved factory policy.
- **Models and operations:** operation rates determine piecework totals. Treat
  historical ticket identity and snapshots as immutable evidence.
- **Parties and pattas:** parties group physical production batches. The display
  number may be reused only after its party is authoritatively closed, subject
  to the exact historical Party #2 exception above. A UUID is the party
  identity.
- **Tickets:** ticket IDs are canonical UUIDs. `operationId` identifies an
  idempotent delivery, not a business entity. `partyNumber` and `pattaNumber` are
  display metadata and must not be used as canonical foreign keys.
- **Payroll:**

  ```text
  sof foyda = umumiy - avans - staj - jarima
  ```

- **Periods and backups:** close/restore operations affect business records and
  must use the approved, version-aware application workflow. Preserve the local
  SQLite database and pre-operation backup. Do not use spreadsheets or legacy
  JSON as data authority.
- **Worker bot:** the worker view returns only the authenticated worker's profile,
  payroll projection, and recent tickets.

## 4. Worker binding and WebApp security

Worker Telegram binding normally requires a configured salted scrypt PIN. The
owner explicitly requested PIN-less binding for this deployment; after that
authorization, `NOVDA_WORKER_PIN_REQUIRED=false` was enabled for the whole
company. First-time bot binding now accepts the company ID and active worker ID
without a PIN. Existing bindings remain unique per Telegram account and per
worker. This is a company-wide policy, not a per-worker PIN reset.

Worker WebApp links use a separate worker-auth HMAC, scoped to company, worker,
Telegram ID, and a 15-minute expiry. This is not license-signing material. The
same short-lived URL token is a bearer credential for requests during its valid
window; it is not a one-time code. Do not forward or publish worker links. The
API rejects modified scope and expired signatures. Real worker binding, payroll,
ticket, and cross-worker Telegram E2E checks remain unexecuted. The WebApp source
now shows the staj deduction that the API already subtracts; the public page was
read before this source correction and still showed its older formula. This UI
copy/display correction is not deployed.

Admin WebApp authentication uses server-validated Telegram `initData`, the
protected admin allowlist, and short-lived in-memory browser sessions. The
browser receives no service token or signing key.

## 5. Installer and release record

### 1.7.15 local candidate

- Artifact: `dist-build/Novda-hisob-kitob-Setup-1.7.15-win10-11-x64.exe`
- Size: `122198223` bytes
- SHA-256: `11255f002729f8bb7ce713cf9f781c8e8e42e18592839c26c7d4feef74bb71dc`
- Packaged `package.json`: version `1.7.15`; Electron entrypoint
  `electron/main.cjs`.
- Authenticode: `NotSigned`.
- Built locally with `npm run dist:rc`; no upload, release publication, tag, Git
  mutation, production install, or deployment was performed.
- This candidate is **not qualified for distribution**. It has not passed the
  isolated Windows Sandbox in-place upgrade matrix or a pristine physical
  Windows 10/11 test.

The 1.7.14 installer remains a historical local artifact with SHA-256
`67def0b763dd6fda67e9c454a51d8b7001501dcd8eda608442b80b5bb4e5f34f` and size
`122196152` bytes. Its previous isolated matrix is historical evidence only;
changes to packaged inputs require the 1.7.15 candidate to be qualified anew.

### 1.7.16 free-mode ticket compatibility candidate

- Artifact: `dist-build/Novda-hisob-kitob-Setup-1.7.16-win10-11-x64.exe`
- Size: `122198890` bytes
- SHA-256: `097480da301a88882669ca6f2eeec5a02962a6b895acffcfcb30e201c0b2579c`
- Packaged `package.json`: version `1.7.16`; Electron entrypoint
  `electron/main.cjs`.
- Authenticode: `NotSigned`.
- Built locally with `npm run dist:rc`; not uploaded or published. The installer
  is a local test candidate and has not been installed on a factory PC.
- It includes the free-mode ticket fix: canonical tickets may omit a printed
  party record only when the server's company policy is Erkin mode. No Party row
  is fabricated. The API remains authoritative and rejects this payload in
  Qat'iy mode.
- 1.7.16 is **invalidated for distribution** after a real-machine NSIS
  exit-code-2 recovery failure.

### 1.7.17 NSIS recovery candidate

- Artifact: `dist-build/Novda-hisob-kitob-Setup-1.7.17-win10-11-x64.exe`
- Size: `122199549` bytes
- SHA-256: `5e9229b436855bf2a7f07f1af2a0b5c6ab61537ae65bcacf8702b2f5927cd68e`
- Authenticode: `NotSigned`; this remains a local candidate, not ready to
  distribute through the application updater.
- Root cause in 1.7.16: `System::Call ... .r3/.r4` wrote to NSIS `$3/$4`, while
  the subsequent test checked `$R3/$R4`. The process check was skipped and the
  installer logged blank environment-set results, `CHECK_FAILED`, and exit 2
  even with no Novda process. The fixed include uses matching `$R3/$R4`, skips
  deletion when the result file is absent, and maps a verified `NO_PROCESS` to
  process-check code 1. A live Novda process or any failed check still aborts.
- The real machine had no Novda process. Its 1.7.15 installation upgraded
  in-place to 1.7.17 with installer exit code 0. The previous uninstaller
  returned 2; the installer recorded process-check code 1 / `NO_PROCESS` and
  continued without manual uninstall. The activation-request file hash was
  unchanged. No company SQLite or DPAPI credential file existed on this PC
  before the upgrade.
- The installer did not change the activation state. After upgrade, the client
  remained pending because its local activation-request ID did not match the
  already-approved server request; there was no local `license.lic` or DPAPI
  credential to preserve. Recover through the authenticated Admin revoke/new
  request/approval flow; do not edit or fabricate activation credentials.
- Windows Sandbox matrix: **7/7 PASS** (1.7.12 upgrade, overlaid 1.7.13,
  forced exit-code-2 recovery, fresh install, same-version reinstall, running
  app, and closed app). Synthetic SQLite and credential marker were preserved
  byte-for-byte on upgrade.

### 1.0.0 fresh-start Patta size-switcher candidate

- Artifact: `dist-build/local-candidate-1.0.0-clean-start/Novda-hisob-kitob-Setup-1.0.0-win10-11-x64.exe`
- Size: `121241760` bytes
- SHA-256: `dfc98af70d4cb3a3ed148cf79b79b748e59eea1e02f115e79f70b4473dcb84cb`
- Packaged `package.json`: version `1.0.0`; Electron entrypoint
  `apps/desktop/electron/main.cjs`.
- Authenticode: `NotSigned`.
- Built locally with publishing disabled. It includes the Patta printing
  switcher for Harfli and Raqamli size systems. The Raqamli presets are 36–60;
  additional numeric sizes can be added from the page.
- This is a local test candidate, not published or yet verified on the target
  office PC. The PostgreSQL `comp_novda` baseline remains the authoritative
  source; no server data reset was performed for the version reset.

Preserve prior release artifacts and local evidence unless an exact artifact is
proven invalid and its identity is recorded.

### Installer recovery behavior

NSIS remains one-click and per-user, with `deleteAppDataOnUninstall: false`.
When the old uninstaller returns code 2, the custom handler continues only if a
PowerShell process scan positively writes `NO_PROCESS`; process-running,
PowerShell, parse, or file-check failures abort. The include is
`build/installer.nsh` and is not copied into the packaged ASAR. Its regression
tests and a local no-publish build passed after replacing an invalid `FileDelete`
directive with NSIS `Delete`.

## 6. Architecture and source map

- `apps/desktop/renderer/`: React/TypeScript interface, Zustand stores, domain validation, payroll,
  and user workflows.
- `apps/desktop/electron/`: Electron main/preload security boundary, company-scoped SQLite,
  ordered migrations, backup/restore, local command pipeline, and sync.
- `apps/server/`: authenticated Fastify routes, PostgreSQL transactions, company
  and device authorization, change feed, migration/import checks, and Admin/Worker
  APIs.
- `packages/contracts/`: published shared contract definitions and verification keys.
- `packages/domain/`: shared business validation and domain rules.
- `admin-bot/`: Admin Telegram bot and signer implementation; no direct
  database access. It is built and run through the VPS Compose deployment.
- `worker-bot/`: Worker Telegram bot and static WebApp; no direct database
  access and no Ed25519 private key.
- `ops/deploy/`: Docker Compose, VPS service/configuration, and operational
  scripts. Production commands require explicit, reviewed infrastructure inputs.
- `data/`, `%APPDATA%` databases, backups, and spreadsheets
  are local/private evidence; they are not source fixtures and must be preserved.

The SQLite migration sequence is append-only. The PostgreSQL schema and forward
migrations are also append-only. Do not edit an already-deployed migration to
make current source state appear applied.

## 7. Current source changes in progress

This continuation added or changed source for:

- Strict bootstrap-response and persisted metadata validation.
- Scoped Party #2 policy and PostgreSQL/SQLite migrations 12–17.
- Electron window navigation restrictions and unverified-updater blocking.
- Removal of the legacy release auto-publisher and unused dependency entries.
- NSIS in-place upgrade recovery logging and a positive process-detection guard.
- Admin form handling for a field that does not exist in its HTML form.
- Worker binding fail-closed behavior when a PIN has not been provisioned.
- Worker WebApp display of the existing `staj` payroll deduction.
- Ed25519 activation signer rotation was approved because the previous private
  key was unavailable. New private key material is stored only in the VPS secret
  path. Updated public verification material retains the prior key for existing
  licenses; do not issue new-key licenses until the refreshed desktop client is
  built, qualified, and delivered.
- Canonical UUID model/party identities, company-wide patta ranges, per-patta
  quantity normalization, data-driven collision approvals, and removal of
  closed/archived local history. PostgreSQL migrations 16–17 must be applied before
  clients using canonical IDs reconnect; execution on the VPS is not verified.

The admin and worker bots are built from directories in the main repository;
they are not Git submodules. The migration-16 production deploy-list correction
is included in `fc8b58b`. Current local signer-rotation changes update the
fingerprint and retain legacy license verification. They still need
feature-branch CI, desktop RC qualification, and an authorized main deploy
before production use.

## 8. Local verification commands

```bash
npm run verify:protected-integrity
npm run verify:secrets
npm run test:non-pg
npx tsc --noEmit
npm run build
npx vitest run scripts/build/build-rc.test.ts scripts/verify/nsis-config.test.ts
npm run dist:rc
```

PostgreSQL verification requires a disposable PostgreSQL 16 database explicitly
configured with `NOVDA_PG_URL` and `NOVDA_DISPOSABLE_PG=1`. The repository
preflight rejects production databases and non-PostgreSQL-16 servers. Do not
replace this gate with SQLite or mocks.

## 9. Verification state and open gates

Passed locally in this continuation:

- Worker authentication compatibility: 4 tests, including expiry/scope and
  no-PIN binding refusal and consistent staj display.
- Non-PostgreSQL suite: 55 files / 435 tests.
- Targeted release, NSIS, release-integrity, and worker-auth suite: 5 files / 15
  tests after the compile correction.
- SQLite/PostgreSQL source tests at targeted checkpoints; the complete PostgreSQL
  16 suite was not run in the final worktree.
- TypeScript and Vite production build.
- Protected hashes and secret scan.
- Local 1.7.15 NSIS artifact build and packaged-version inspection.

Still open:

- PostgreSQL 16 integration/release-integrity suite: Docker Desktop daemon is
  unavailable and no disposable DSN is configured.
- Production PostgreSQL migration/schema revision check and any deployment:
  blocked by unavailable SSH credentials. The source migration 12 is not applied.
- Clean Windows / Windows Sandbox upgrade matrix: `WindowsSandbox=false` on this
  host; physical clean-machine verification remains required.
- Authenticode signing: no signing certificate; artifact is unsigned.
- Real authorized/unauthorized Admin Telegram, worker PIN/binding/payroll/ticket,
  cross-worker, and designated-PC activation E2E: not performed.
- Fresh production worker-bot/API status and IELTS before/after evidence: not
  available over current SSH access.

No factory readiness or production deployment claim is made. Keep the 1.7.15
candidate local until every required external gate has evidence and an operator
authorizes its next use.

## 10. Project execution rules

- Preserve user work and existing local history. Inspect status and diffs before
  editing, and never use destructive Git cleanup/reset operations.
- For ordinary failures, diagnose, correct, and rerun the relevant tests before
  continuing.
- Complete independent safe work while external gates remain blocked. Stop only
  at an action that cannot be performed safely without credentials, infrastructure,
  or owner-authorized production action.
- Before commit or release work, inspect the exact staged paths and verify that
  no secrets, business data, generated databases, or unintended submodule changes
  are included.
