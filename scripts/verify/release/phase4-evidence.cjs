'use strict';
// Evaluates retained automated receipts only. External gates are intentionally
// BLOCKED; this runner cannot manufacture an operator's business/hardware approval.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sourceFingerprint, evaluateRelease } = require('./release-gates.cjs');
const directory = path.resolve(__dirname, '../../../ops/docs/evidence');
const read = name => fs.readFileSync(path.join(directory, name), 'utf8');
const json = name => JSON.parse(read(name));
const output = name => read(name).replace(/\u001b\[[0-9;]*m/g, '');
const artifact = name => ({ path: name, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex') });
function main() {
  const fingerprint = sourceFingerprint();
  const engineering = output('phase4-engineering-complete-output.txt'), api = output('phase4-api-output.txt');
  assert(/Tests\s+773 passed\s*\|\s*1 skipped/.test(engineering));
  assert(engineering.includes('built in') && !/\bFAIL\b/.test(engineering));
  assert(/Tests\s+368 passed\s*\|\s*1 skipped/.test(api) && !/\bFAIL\b/.test(api));
  assert(read('phase4-secret-scan-output.txt').includes('SECRET_SCAN_PASS'));
  assert(read('phase4-python-output.txt').includes('37 passed, 176 subtests passed'));
  const prefix = 'BACKUP_DESKTOP_RESULT ', lifecycle = output('phase4-backup-output.txt');
  const processes = lifecycle.split(/\r?\n/).filter(line => line.startsWith(prefix)).map(line => JSON.parse(line.slice(prefix.length)));
  assert.equal(processes.length, 2); assert(processes.every(item => item.status === 'passed' && item.electronVersion === '44.10.2'));
  assert(lifecycle.includes('11988') && !lifecycle.includes('BACKUP_DESKTOP_FAILED'));
  assert(read('phase4-admin-output.txt').includes('FINANCIAL_UI_PASS Electron 44.10.2'));
  assert(read('phase4-printing-output.txt').includes('MODEL_SIZES_C_PASS'));
  const packaged = json('phase4-packaged.json'), profile = json('phase4-profile.json');
  assert.equal(packaged.sourceFingerprint, fingerprint); assert.equal(packaged.status, 'PASS'); assert(packaged.cleanExit);
  assert.equal(profile.status, 'PASS'); assert(profile.automaticPreUpgradeBackup && profile.activeProfilePreserved && profile.foreignTenantRestoreRefused);
  const originals = json('phase4-original-profiles.json');
  assert.equal(originals.status, 'PASS'); assert.equal(originals.appAsarSha256, packaged.appAsarSha256);
  assert.equal(originals.profiles.length, 6); assert(originals.profiles.every(item => item.reopenVerified && item.onlineBackupRestoreVerified));
  assert.equal(json('phase4-financial-integrity.json').status, 'PASS');
  const history = json('phase4-local-historical-evidence.json');
  assert.equal(history.completeDirectAttributionCandidates.length, 0);
  assert(history.sqliteFiles.every(file => file.stableCopy && file.sourceUnchangedAfterInspection));
  const pass = (id, names) => ({ id, status: 'PASS', sourceFingerprint: fingerprint, artifacts: names.map(artifact) });
  const blocked = (id, reason, names = []) => ({ id, status: 'BLOCKED', reason, artifacts: names.map(artifact) });
  const records = [
    pass('engineering', ['phase4-engineering-complete-output.txt', 'phase4-secret-scan-output.txt', 'phase4-python-output.txt']),
    pass('apiRecovery', ['phase4-api-output.txt']),
    pass('backupLifecycle', ['phase4-backup-output.txt', 'phase4-admin-output.txt', 'phase4-financial-integrity.json']),
    pass('historicalInventory', ['phase3-historical-reconciliation.json', 'phase4-local-historical-evidence.json', 'phase4-financial-integrity.json']),
    blocked('historicalSignoff', 'Six additional local SQLite files and two JSON backups yield no complete original attribution; 216 UNRESOLVED and opening balances require finance primary evidence/approved scope'),
    pass('packagedStartup', ['phase4-packaged.json', 'phase4-package-identity.json']),
    pass('profileUpgrade', ['phase4-profile.json', 'phase4-original-profiles.json', 'phase4-recovery-verified.txt']),
    blocked('installerUpgradeRollback', 'Source/NSIS fixture safety hardened; authorized disposable Windows VM, previous signed installer/profile and actual install/rollback run still required'),
    blocked('security', 'Zero runtime/high/critical advisories; nine moderate tooling dependencies remain with no compatible upstream minimatch patch; explicit risk acceptance or compatible fix required', ['phase4-security-audit.json', 'phase4-runtime-audit.json']),
    blocked('activationTls', 'Unsigned engineering candidate; RC now refuses unsigned output. Approved signer and authorized production-mode staging TLS/activation remain unavailable', ['phase4-signature-output.txt', 'phase4-unsigned-rc-refusal.txt']),
    blocked('printing', 'Real preview/generated HTML/local persistence pass; witnessed Canon/Argox physical output and staging PG batch receipt remain required', ['phase4-printing-output.txt']),
    blocked('telegram', 'Local signed routes/actual admin DOM pass; permitted live Telegram staging transport still required', ['phase4-admin-output.txt']),
    blocked('performance', 'Nine real loopback HTTP bootstrap requests at concurrency 3 pass without business mutations; approved SLO, realistic TLS/UI load and soak remain required', ['phase4-http-capacity.json'])
  ];
  const result = evaluateRelease(records, fingerprint, item => artifact(item.path).sha256 === item.sha256);
  for (const [file, value] of [['phase4-release-gates.json', records], ['phase4-release-verdict.json', result]]) {
    fs.writeFileSync(path.join(directory, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify({ verdict: result.verdict, passed: result.gates.filter(item => item.status === 'PASS').length,
    blocked: result.gates.filter(item => item.status === 'BLOCKED').length, sourceFingerprint: fingerprint }));
}
if (require.main === module) main();
