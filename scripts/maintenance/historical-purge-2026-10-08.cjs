#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { verifyPostgresReleaseState } = require('../../apps/server/infrastructure/postgresIntegrity.cjs');
const {
  TARGET_TENANT_ID,
  CUTOFF_DATE,
  CUTOFF_UTC,
  computeManifestSha256,
  assertDisposablePostgresTarget,
  buildHistoricalPurgeManifest,
  executeDisposableHistoricalPurge
} = require('./lib/historicalPurgePlanner.cjs');

function parseArgs(argv) {
  const args = {
    mode: 'dry-run',
    tenant: TARGET_TENANT_ID,
    cutoff: CUTOFF_DATE,
    schemaVersion: 30,
    confirmDisposableTarget: false,
    injectFailureBeforeCommit: false,
    disposableRehearsalScope: 'strict'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dry-run') args.mode = 'dry-run';
    else if (token === '--execute') args.mode = 'execute';
    else if (token === '--confirm-disposable-target') args.confirmDisposableTarget = true;
    else if (token === '--inject-failure-before-commit') args.injectFailureBeforeCommit = true;
    else if (token === '--pg-url') args.pgUrl = argv[++i];
    else if (token === '--tenant') args.tenant = argv[++i];
    else if (token === '--cutoff') args.cutoff = argv[++i];
    else if (token === '--schema-version') args.schemaVersion = Number(argv[++i]);
    else if (token === '--manifest') args.manifestPath = argv[++i];
    else if (token === '--manifest-sha256') args.manifestSha256 = argv[++i];
    else if (token === '--disposable-rehearsal-scope') args.disposableRehearsalScope = argv[++i];
    else if (token === '--out') args.outPath = argv[++i];
    else throw new Error(`UNKNOWN_ARGUMENT: ${token}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pgUrl = args.pgUrl || process.env.NOVDA_PG_URL;
  assertDisposablePostgresTarget(pgUrl, {
    confirmDisposableTarget: args.confirmDisposableTarget,
    requireExecuteConfirmation: args.mode === 'execute'
  });

  if (args.tenant !== TARGET_TENANT_ID) {
    throw new Error(`INVALID_TENANT: required ${TARGET_TENANT_ID}`);
  }
  if (args.cutoff !== CUTOFF_DATE) {
    throw new Error(`INVALID_CUTOFF: required ${CUTOFF_DATE}`);
  }

  const pool = new Pool({ connectionString: pgUrl });
  const client = await pool.connect();
  try {
    if (args.mode === 'dry-run') {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const manifest = await buildHistoricalPurgeManifest(client, {
          tenantId: args.tenant,
          cutoffDate: CUTOFF_DATE,
          cutoffUtc: CUTOFF_UTC
        });
        await client.query('COMMIT');
        const json = `${JSON.stringify(manifest, null, 2)}\n`;
        if (args.outPath) {
          fs.mkdirSync(path.dirname(path.resolve(args.outPath)), { recursive: true });
          fs.writeFileSync(path.resolve(args.outPath), json, 'utf8');
        }
        process.stdout.write(JSON.stringify({
          mode: 'dry-run',
          status: manifest.status,
          tenantId: manifest.tenantId,
          schemaVersion: manifest.schemaVersion,
          manifestSha256: manifest.manifestSha256,
          outPath: args.outPath || null,
          blockerCount: manifest.blockers.length
        }, null, 2) + '\n');
        return;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
    }

    // --execute mode strictly validates approved manifest + SHA-256 + schema version + disposable target
    if (!args.manifestPath || !args.manifestSha256) {
      throw new Error('EXECUTE_REQUIRES_MANIFEST_AND_SHA256');
    }
    const manifest = JSON.parse(fs.readFileSync(path.resolve(args.manifestPath), 'utf8'));
    if (Number(manifest.schemaVersion) !== Number(args.schemaVersion)) {
      throw new Error(`SCHEMA_VERSION_ARG_MISMATCH: arg=${args.schemaVersion}, manifest=${manifest.schemaVersion}`);
    }
    const verifiedHash = computeManifestSha256(manifest);
    if (verifiedHash !== args.manifestSha256) {
      throw new Error(`MANIFEST_SHA256_MISMATCH: expected=${args.manifestSha256}, actual=${verifiedHash}`);
    }

    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    let result;
    try {
      result = await executeDisposableHistoricalPurge(client, {
        tenantId: args.tenant,
        manifest,
        manifestSha256: args.manifestSha256,
        disposableRehearsalScope: args.disposableRehearsalScope,
        injectFailureBeforeCommit: args.injectFailureBeforeCommit
      });
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }

    // Post-commit release integrity verification
    const integrityReport = await verifyPostgresReleaseState(client);
    const payload = {
      mode: 'execute',
      ...result,
      integrityReport: {
        scopePreserved: integrityReport.baseline?.scopePreserved,
        unmatchedChangeLogOperations: integrityReport.operations?.unmatchedChangeLogOperations,
        orphanCounts: integrityReport.orphanCounts,
        purgeFence: integrityReport.purgeFence
      }
    };
    if (args.outPath) {
      fs.mkdirSync(path.dirname(path.resolve(args.outPath)), { recursive: true });
      fs.writeFileSync(path.resolve(args.outPath), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[HISTORICAL_PURGE_FAILED] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs };

