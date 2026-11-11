'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const CRITERIA = Object.freeze({
  engineering: 'Lint, TS, build, protected-file, secret and unit regressions pass',
  apiRecovery: 'PG atomicity, concurrent dedup, authorization and stale-session regressions pass',
  backupLifecycle: 'Real Electron/SQLite/HTTP/PG restart, ticket/payroll/close/archive workflows pass',
  historicalInventory: 'Every retained historical adjustment classified; original rows and digests unchanged',
  historicalSignoff: 'Original financial attribution/opening balances verified or explicit business-approved restricted-release scope',
  packagedStartup: 'Actual packaged main, sandboxed preload/IPC, activation UI and clean shutdown pass',
  profileUpgrade: 'Existing-profile data/outbox/archive migration, reopen and backup recovery pass',
  installerUpgradeRollback: 'Old-to-new Windows installer and rollback in disposable Windows VM preserve existing profile and pending commands',
  security: 'No unaccepted runtime/high/critical advisories; remaining tooling risks reviewed by release owner',
  activationTls: 'Approved signing/activation and TLS/reverse-proxy exercise on authorized staging environment',
  printing: 'Preview/HTML match persisted batches; required physical-printer output approved by operator',
  telegram: 'Authorized staging bot/WebApp login, signed routes and delivery exercise',
  performance: 'Backup-sized latency/error/memory measurements evaluated against approved operational SLO'
});

function sourceFingerprint() {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !['__pycache__', 'node_modules'].includes(entry.name)) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  // Bind verification policy/runners and deployment/installer source too. Reports
  // and evidence are hashed separately to avoid a self-referential fingerprint.
  for (const directory of ['apps', 'packages', 'scripts', 'ops/deploy', 'ops/windows-sandbox']) walk(directory);
  for (const file of ['package.json', 'package-lock.json', 'vite.config.ts', 'vitest.config.ts', 'tsconfig.json', 'eslint.config.mjs']) if (fs.existsSync(path.join(root, file))) files.push(file);
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) {
    hash.update(file.split(path.sep).join('/') + '\0');
    hash.update(fs.readFileSync(path.join(root, file))); hash.update('\0');
  }
  return hash.digest('hex');
}

function verifyArtifact(artifact, baseDirectory) {
  if (!artifact || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '') || typeof artifact.path !== 'string') return false;
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(path.resolve(baseDirectory, artifact.path))).digest('hex') === artifact.sha256;
  } catch { return false; }
}

function evaluateRelease(records, fingerprint, verify = artifact => verifyArtifact(artifact, root)) {
  if (!Array.isArray(records)) throw new Error('RELEASE_EVIDENCE_ARRAY_REQUIRED');
  if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('DUPLICATE_RELEASE_GATE');
  if (records.some(record => !Object.hasOwn(CRITERIA, record.id))) throw new Error('UNKNOWN_RELEASE_GATE');
  const gates = Object.entries(CRITERIA).map(([id, expected]) => {
    const record = records.find(item => item.id === id);
    if (!record || !['PASS', 'FAIL', 'BLOCKED'].includes(record.status)) return { id, expected, status: 'BLOCKED', reason: 'MISSING_OR_INVALID_EVIDENCE' };
    if (record.status !== 'PASS') return { id, expected, status: record.status, reason: record.reason || 'NOT_VERIFIED' };
    if (record.sourceFingerprint !== fingerprint) return { id, expected, status: 'BLOCKED', reason: 'STALE_SOURCE_EVIDENCE' };
    if (!Array.isArray(record.artifacts) || !record.artifacts.length || !record.artifacts.every(verify)) {
      return { id, expected, status: 'BLOCKED', reason: 'MISSING_OR_CHANGED_ARTIFACT' };
    }
    return { id, expected, status: 'PASS' };
  });
  // No silent waivers. Restricted-scope releases need separately approved criteria.
  return { verdict: gates.every(gate => gate.status === 'PASS') ? 'READY' : 'NOT READY', sourceFingerprint: fingerprint, gates };
}

if (require.main === module) {
  if (process.argv[2] === '--fingerprint') console.log(sourceFingerprint());
  else {
    const file = path.resolve(process.argv[2]);
    const result = evaluateRelease(JSON.parse(fs.readFileSync(file, 'utf8')), sourceFingerprint(), artifact => verifyArtifact(artifact, path.dirname(file)));
    console.log(JSON.stringify(result, null, 2));
    if (result.verdict !== 'READY') process.exitCode = 1;
  }
}
module.exports = { CRITERIA, sourceFingerprint, evaluateRelease };
