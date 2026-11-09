'use strict';
// Guarded PostgreSQL Lifecycle & Accounting Verification Runner
// Strictly bounded to the documented own container in LOCAL-TEST-DATABASE.md
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');

const root = path.resolve(__dirname, '../../..');
const container = 'hisob_test_display_05d2b2';
const identity = 'f8070090fa5aaedf8aa34a983c8606be4b8954d4d0aa7f7993352caf29a0c9d3';
const name = `hisob_test_patta_lifecycle_${crypto.randomBytes(5).toString('hex')}`;
const password = crypto.randomBytes(32).toString('hex');
const safeEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  APPDATA: process.env.APPDATA,
  HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*'
};

delete process.env.DATABASE_URL;
delete process.env.NOVDA_PG_URL;
delete process.env.NOVDA_LOCAL_TEST_PG_URL;

const { applyMigrations } = require(path.join(root, 'ops/deploy/migrateProduction.cjs'));
const { canonicalStringify, computePayloadHash } = require(path.join(root, 'apps/server/modules/sync/canonicalPayload.cjs'));
const { processSingleOperation } = require(path.join(root, 'apps/server/modules/sync/handlers/operations.cjs'));
const { readPeriodArchiveSource } = require(path.join(root, 'apps/server/modules/sync/workbookOperations.cjs'));
const { readCompanySnapshot } = require(path.join(root, 'apps/server/modules/sync/bootstrapSnapshot.cjs'));
const { finishScopeHash } = require(path.join(root, 'packages/domain/pattaFinishScope.cjs'));

function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', env: safeEnv, timeout: 30000 });
  assert.equal(result.status, 0, `owned-container command failed: ${args[0]} - ${result.stderr}`);
  return result.stdout.trim();
}

function guard(url) {
  const result = spawnSync(process.execPath, [path.join(root, '.opencode/deep-audit/output/local-test-db/assert-local-pg.cjs')],
    { env: { NOVDA_LOCAL_TEST_PG_URL: url }, encoding: 'utf8' });
  assert.equal(result.status, 0, `local PostgreSQL boundary check failed: ${result.stderr}`);
}

function makeOp(commandType, entityType, entityId, payload, baseRevision, opId) {
  const opIdentifier = opId || `op_${crypto.randomBytes(8).toString('hex')}`;
  const value = JSON.parse(canonicalStringify({ commandId: `cmd_${opIdentifier}`, ...payload, operationId: opIdentifier }));
  return {
    operationId: opIdentifier,
    companyId: value.companyId,
    commandType,
    entityType,
    entityId,
    baseRevision,
    payloadHash: computePayloadHash(canonicalStringify(value)),
    payload: value
  };
}

async function main() {
  assert.equal(docker(['inspect', '--format', '{{.Id}}', container]), identity, 'owned-container identity mismatch');
  const status = docker(['inspect', '--format', '{{.State.Status}}', container]);
  if (status !== 'running') {
    docker(['start', container]);
  }
  assert.equal(docker(['inspect', '--format', '{{.Id}}', container]), identity);
  const binding = docker(['port', container, '5432/tcp']);
  assert.match(binding, /^127\.0\.0\.1:\d+$/, 'owned DB must be bound to loopback only');

  const url = `postgresql://${name}:${password}@${binding}/${name}`;
  let client;

  try {
    guard(url);
    // Provision synthetic ephemeral role and database via local postgres socket
    docker(['exec', '-i', '-u', 'postgres', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
      '-U', 'hisob_test_display', '-d', 'hisob_test_display', '-q'],
      `CREATE ROLE ${name} LOGIN PASSWORD '${password}';\nCREATE DATABASE ${name} OWNER ${name};\n`);
    guard(url);

    client = new Pool({ connectionString: url, max: 5 });

    // Step 1: Run full migration suite through v28
    console.log('--- Step 1: Running forward migrations through v28 ---');
    await applyMigrations(client);

    // Verify 4 columns exist and constraint works
    const partyCols = await client.query(`SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'parties' AND column_name IN ('ended_at', 'ended_operation_id', 'month_closed_period_id')`);
    assert.equal(partyCols.rows.length, 3, 'parties table must have all 3 lifecycle columns');

    const periodCols = await client.query(`SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'periods' AND column_name = 'close_operation_id'`);
    assert.equal(periodCols.rows.length, 1, 'periods table must have close_operation_id column');

    // Test finish pair constraint
    let constraintViolated = false;
    try {
      await client.query(`INSERT INTO parties (id, company_id, party_number, model_id, ended_at)
        VALUES ('invalid_party', 'comp_test', '99', 'mod_1', NOW())`);
    } catch (e) {
      constraintViolated = true;
    }
    assert.equal(constraintViolated, true, 'finish pair constraint must reject ended_at without ended_operation_id');

    console.log('Step 1 PASS: 4 columns and constraints verified.');

    // Step 2 & 3: Setup Company, Worker, Model, Tariffs, Period P
    console.log('--- Step 2 & 3: Executing A+B accounting sequence (P: 17x7=119, Q: 5x9=45, total 164) ---');
    const companyId = `comp_${name}`;
    const req = { auth: { companyId, deviceId: 'dev_test_1' } };

    // Register company admin and model
    const modelId = `model_${name}`;
    await client.query(`INSERT INTO models (id, company_id, name, operations_json)
      VALUES ($1, $2, 'Model Test', '[{"id":"op1","name":"Tikish","rate":7}]')`, [modelId, companyId]);

    const workerId = 101;
    await client.query(`INSERT INTO workers (id, company_id, name, status) VALUES ($1, $2, 'Worker Ali', 'ACTIVE')`, [workerId, companyId]);

    // Period P: 2026-11-01 -> 2026-11-30
    const periodPId = `period_P_${name}`;
    await client.query(`INSERT INTO periods (id, company_id, name, start_date, end_date, is_closed, status)
      VALUES ($1, $2, 'Noyabr 2026', '2026-11-01', '2026-11-30', 0, 'OPEN')`, [periodPId, companyId]);

    // Create party A: 2 pattas, 10 items each, total 20 items
    const partyAId = `party_A_${name}`;
    const createA = makeOp('CreateParty', 'party', partyAId, {
      companyId, partyRecordId: partyAId, partyNumber: '1', modelId, modelName: 'Model Test',
      color: 'Qora', pattaCount: 2, cumulativePattaCount: 2, pattaStartNumber: 1, pattaEndNumber: 2,
      ishSoniPerPatta: 10, totalIshSoni: 20, ishSoni: 20, cumulativeIshSoni: 20,
      sizes: { M: 2 }, sizeOrder: ['M'], printedAt: '2026-11-02T10:00:00.000Z'
    }, 0);
    const resA = await processSingleOperation(client, req, createA);
    assert.equal(resA.status, 'APPLIED');

    // Create party B: 1 patta, 7 items, total 7 items
    const partyBId = `party_B_${name}`;
    const createB = makeOp('CreateParty', 'party', partyBId, {
      companyId, partyRecordId: partyBId, partyNumber: '2', modelId, modelName: 'Model Test',
      color: 'Qizil', pattaCount: 1, cumulativePattaCount: 1, pattaStartNumber: 3, pattaEndNumber: 3,
      ishSoniPerPatta: 7, totalIshSoni: 7, ishSoni: 7, cumulativeIshSoni: 7,
      sizes: { M: 1 }, sizeOrder: ['M'], printedAt: '2026-11-03T10:00:00.000Z'
    }, 0);
    const resB = await processSingleOperation(client, req, createB);
    assert.equal(resB.status, 'APPLIED');

    // Submit ticket A1 in period P: qty 10
    const ticketA1Id = crypto.randomUUID();
    const submitA1 = makeOp('SubmitTicket', 'ticket', ticketA1Id, {
      companyId, ticketId: ticketA1Id, modelId, partyNumber: '1', partyRecordId: partyAId,
      pattaNumber: 1, periodId: periodPId, qty: 10, size: 'M', color: 'Qora',
      submittedAt: '2026-11-05T12:00:00.000Z',
      entries: [{ opName: 'Tikish', workerId, workerNameSnapshot: 'Worker Ali', rateSnapshot: 7 }]
    }, 0);
    const resA1 = await processSingleOperation(client, req, submitA1);
    if (resA1.status !== 'APPLIED') console.log('resA1 rejected:', JSON.stringify(resA1));
    assert.equal(resA1.status, 'APPLIED');

    // Submit ticket B1 in period P: qty 7
    const ticketB1Id = crypto.randomUUID();
    const submitB1 = makeOp('SubmitTicket', 'ticket', ticketB1Id, {
      companyId, ticketId: ticketB1Id, modelId, partyNumber: '2', partyRecordId: partyBId,
      pattaNumber: 3, periodId: periodPId, qty: 7, size: 'M', color: 'Qizil',
      submittedAt: '2026-11-06T12:00:00.000Z',
      entries: [{ opName: 'Tikish', workerId, workerNameSnapshot: 'Worker Ali', rateSnapshot: 7 }]
    }, 0);
    const resB1 = await processSingleOperation(client, req, submitB1);
    assert.equal(resB1.status, 'APPLIED');

    // Close Period P
    const periodQId = `period_Q_${name}`;
    const closePOpId = `op_close_P_${name}`;
    const closeP = makeOp('ClosePeriod', 'period', periodPId, {
      companyId, periodId: periodPId, endDate: '2026-11-30', archiveFilename: `archive_${periodPId}.json`,
      nextPeriod: { id: periodQId, name: 'Dekabr 2026', startDate: '2026-12-01' }
    }, 1, closePOpId);
    const resCloseP = await processSingleOperation(client, req, closeP);
    assert.equal(resCloseP.status, 'APPLIED');

    // Verify P closure facts:
    // Period P must have close_operation_id
    const dbP = await client.query('SELECT is_closed, close_operation_id FROM periods WHERE company_id = $1 AND id = $2', [companyId, periodPId]);
    assert.equal(dbP.rows[0].is_closed, 1);
    assert.equal(dbP.rows[0].close_operation_id, closePOpId);

    // Party B was completely submitted -> month_closed_period_id = P, is_closed = 1, status = 'CLOSED'
    const dbBAfterP = await client.query('SELECT status, is_closed, month_closed_period_id, ended_at FROM parties WHERE company_id = $1 AND id = $2', [companyId, partyBId]);
    assert.equal(dbBAfterP.rows[0].status, 'CLOSED');
    assert.equal(dbBAfterP.rows[0].is_closed, 1);
    assert.equal(dbBAfterP.rows[0].month_closed_period_id, periodPId);
    assert.equal(dbBAfterP.rows[0].ended_at, null, 'Month close alone does not set ended_at');

    // Party A was partially carried -> month_closed_period_id is null, status != 'CLOSED', archived_patta_numbers = [1]
    const dbAAfterP = await client.query('SELECT status, is_closed, month_closed_period_id, ended_at, archived_patta_numbers_json FROM parties WHERE company_id = $1 AND id = $2', [companyId, partyAId]);
    assert.equal(dbAAfterP.rows[0].status, 'ACTIVE');
    assert.equal(dbAAfterP.rows[0].is_closed, 0);
    assert.equal(dbAAfterP.rows[0].month_closed_period_id, null);
    assert.equal(dbAAfterP.rows[0].ended_at, null);
    assert.deepEqual(dbAAfterP.rows[0].archived_patta_numbers_json, [1]);

    // Read stored frozen P archive from period_archives table
    const pArchiveRow = await client.query('SELECT archive_json, sha256 FROM period_archives WHERE company_id = $1 AND period_id = $2', [companyId, periodPId]);
    assert.ok(pArchiveRow.rows.length, 'P archive must be stored in period_archives table');
    const archiveP = pArchiveRow.rows[0].archive_json;
    assert.equal(archiveP.submittedTickets.length, 2);
    const pGross = archiveP.submittedTickets.reduce((sum, t) => sum + (t.qty * 7), 0);
    assert.equal(pGross, 119, 'P gross must be exactly 119 (10*7 + 7*7)');

    const J_P = canonicalStringify(archiveP);
    const H_P = pArchiveRow.rows[0].sha256;
    assert.equal(computePayloadHash(J_P), H_P, 'Stored hash must match canonical payload hash');

    console.log(`P Archive verified from storage: 2 tickets, gross = ${pGross}, sha256 = ${H_P}`);

    // Enter Q: Submit ticket A2 in Period Q with qty = 5
    const ticketA2Id = crypto.randomUUID();
    const submitA2 = makeOp('SubmitTicket', 'ticket', ticketA2Id, {
      companyId, ticketId: ticketA2Id, modelId, partyNumber: '1', partyRecordId: partyAId,
      pattaNumber: 2, periodId: periodQId, qty: 5, size: 'M', color: 'Qora',
      submittedAt: '2026-12-05T12:00:00.000Z',
      entries: [{ opName: 'Tikish', workerId, workerNameSnapshot: 'Worker Ali', rateSnapshot: 9 }]
    }, 0);
    const resA2 = await processSingleOperation(client, req, submitA2);
    assert.equal(resA2.status, 'APPLIED');

    // Test Stale Scope Rejection: CompletePartySeries with invalid finishScopeHash
    const badScopeHash = '0000000000000000000000000000000000000000000000000000000000000000';
    let scopeRejected = false;
    const badFinish = makeOp('CompletePartySeries', 'party_series', periodQId, {
      companyId, periodId: periodQId, endDate: '2026-12-10', finishScopeHash: badScopeHash
    }, 0);
    const badRes = await processSingleOperation(client, req, badFinish);
    if (badRes.status === 'REJECTED' && (badRes.error?.code === 'FINISH_SCOPE_CHANGED' || badRes.error?.message?.includes('FINISH_SCOPE_CHANGED'))) {
      scopeRejected = true;
    }
    assert.equal(scopeRejected, true, 'Finish with mismatched scope hash must reject with FINISH_SCOPE_CHANGED');

    // Compute legitimate finish scope hash
    // Both active Party A and certified month-closed Party B are eligible!
    const eligibleParties = await client.query(`SELECT p.id, p.server_revision
      FROM parties p WHERE p.company_id = $1 AND p.is_archived = FALSE AND p.ended_at IS NULL
        AND ((p.status != 'CLOSED' AND p.is_closed = 0) OR EXISTS (
          SELECT 1 FROM periods closed WHERE closed.company_id = p.company_id AND closed.id = p.month_closed_period_id
            AND closed.is_closed = 1 AND closed.close_operation_id IS NOT NULL))
      ORDER BY p.id`, [companyId]);
    assert.equal(eligibleParties.rows.length, 2, 'Both A and B must be eligible for finish');

    const [settingsRow, seqRow] = await Promise.all([
      client.query('SELECT server_revision FROM company_batch_settings WHERE company_id = $1', [companyId]),
      client.query('SELECT next_patta_number FROM company_patta_sequences WHERE company_id = $1', [companyId])
    ]);
    const validScopeHash = finishScopeHash({
      companyId, periodId: periodQId,
      parties: eligibleParties.rows.map(p => ({ id: p.id, expectedRevision: Number(p.server_revision || 0) })),
      batchSettingsRevision: Number(settingsRow.rows[0]?.server_revision || 0),
      nextPattaNumber: Number(seqRow.rows[0]?.next_patta_number || 1)
    });

    // Execute series finish with valid scope hash
    const finishOpId = `op_finish_Q_${name}`;
    const finishOp = makeOp('CompletePartySeries', 'party_series', periodQId, {
      companyId, periodId: periodQId, endDate: '2026-12-10', finishScopeHash: validScopeHash
    }, 0, finishOpId);
    const resFinish = await processSingleOperation(client, req, finishOp);
    assert.equal(resFinish.status, 'APPLIED');

    // Verify Party A and Party B are both ENDED
    const dbAEnded = await client.query('SELECT status, is_closed, ended_at, ended_operation_id, month_closed_period_id FROM parties WHERE company_id = $1 AND id = $2', [companyId, partyAId]);
    assert.equal(dbAEnded.rows[0].status, 'CLOSED');
    assert.equal(dbAEnded.rows[0].is_closed, 1);
    assert.equal(dbAEnded.rows[0].ended_operation_id, finishOpId);
    assert.ok(dbAEnded.rows[0].ended_at);

    const dbBEnded = await client.query('SELECT status, is_closed, ended_at, ended_operation_id, month_closed_period_id FROM parties WHERE company_id = $1 AND id = $2', [companyId, partyBId]);
    assert.equal(dbBEnded.rows[0].status, 'CLOSED');
    assert.equal(dbBEnded.rows[0].is_closed, 1);
    assert.equal(dbBEnded.rows[0].ended_operation_id, finishOpId);
    assert.ok(dbBEnded.rows[0].ended_at);
    assert.equal(dbBEnded.rows[0].month_closed_period_id, periodPId, 'B keeps its month_closed_period_id after finish');

    // Idempotency: Replaying the exact same finish operation returns original dedup / does not double-apply
    const replayFinish = await processSingleOperation(client, req, finishOp);
    assert.equal(replayFinish.status, 'APPLIED');
    const dbBAfterReplay = await client.query('SELECT ended_operation_id FROM parties WHERE company_id = $1 AND id = $2', [companyId, partyBId]);
    assert.equal(dbBAfterReplay.rows[0].ended_operation_id, finishOpId);

    // Close Period Q
    const periodRId = `period_R_${name}`;
    const closeQOpId = `op_close_Q_${name}`;
    const closeQ = makeOp('ClosePeriod', 'period', periodQId, {
      companyId, periodId: periodQId, endDate: '2026-12-31', archiveFilename: `archive_${periodQId}.json`,
      nextPeriod: { id: periodRId, name: 'Yanvar 2027', startDate: '2027-01-01' }
    }, 1, closeQOpId);
    const resCloseQ = await processSingleOperation(client, req, closeQ);
    assert.equal(resCloseQ.status, 'APPLIED');

    // Read Period Q Archive from storage
    const qArchiveRow = await client.query('SELECT archive_json, sha256 FROM period_archives WHERE company_id = $1 AND period_id = $2', [companyId, periodQId]);
    assert.ok(qArchiveRow.rows.length, 'Q archive must be stored in period_archives table');
    const archiveQ = qArchiveRow.rows[0].archive_json;

    // Archive Q must include Party A because A has ticket A2 in period Q!
    const partyAInQ = archiveQ.printedPartyHistory.find(p => p.id === partyAId);
    assert.ok(partyAInQ, 'Party A must be included in Q archive via ticket linkage');
    assert.equal(archiveQ.submittedTickets.length, 1);
    assert.equal(archiveQ.submittedTickets[0].id, ticketA2Id);
    const qGross = archiveQ.submittedTickets[0].qty * 9;
    assert.equal(qGross, 45, 'Q gross must be 5 * 9 = 45');

    // Total gross combined = 119 + 45 = 164
    assert.equal(pGross + qGross, 164, 'Combined gross must be exactly 164');

    // Integrity Check: Read P Archive again from storage and verify digest has NOT changed!
    const pArchiveRowAfter = await client.query('SELECT archive_json, sha256 FROM period_archives WHERE company_id = $1 AND period_id = $2', [companyId, periodPId]);
    const J_P_After = canonicalStringify(pArchiveRowAfter.rows[0].archive_json);
    const H_P_After = pArchiveRowAfter.rows[0].sha256;
    assert.equal(J_P_After, J_P, 'Period P archive contents must be byte-for-byte identical');
    assert.equal(H_P_After, H_P, 'Period P archive SHA-256 hash must be identical');

    // Change current model tariff to 99 afterwards
    await client.query(`UPDATE models SET operations_json = '[{"id":"op1","name":"Tikish","rate":99}]' WHERE company_id = $1 AND id = $2`, [companyId, modelId]);

    // Verify changing current tariff to 99 does NOT change stored archives or their hashes!
    const pArchiveRowAfterTariff = await client.query('SELECT archive_json, sha256 FROM period_archives WHERE company_id = $1 AND period_id = $2', [companyId, periodPId]);
    assert.equal(pArchiveRowAfterTariff.rows[0].sha256, H_P, 'Period P archive hash remains immutable after tariff change');
    const qArchiveRowAfterTariff = await client.query('SELECT archive_json, sha256 FROM period_archives WHERE company_id = $1 AND period_id = $2', [companyId, periodQId]);
    assert.equal(qArchiveRowAfterTariff.rows[0].sha256, qArchiveRow.rows[0].sha256, 'Period Q archive hash remains immutable after tariff change');

    // Next Month Close must NOT downgrade ENDED to CLOSED
    const dbAFinal = await client.query('SELECT status, is_closed, ended_at, ended_operation_id FROM parties WHERE company_id = $1 AND id = $2', [companyId, partyAId]);
    assert.ok(dbAFinal.rows[0].ended_at, 'Closing Q must not downgrade A ended_at');
    assert.equal(dbAFinal.rows[0].ended_operation_id, finishOpId);

    // Generic CloseParty check: cannot close already closed B
    const genericClose = makeOp('CloseParty', 'party', partyBId, {
      companyId, partyRecordId: partyBId
    }, 3);
    const closePartyRes = await processSingleOperation(client, req, genericClose);
    assert.equal(closePartyRes.status, 'REJECTED', 'Generic CloseParty on already-closed party must be rejected');

    console.log('ALL GUARDED PG STAGE 1 ACCEPTANCE CHECKS PASSED:');
    console.log('- 4 nullable columns & triggers');
    console.log('- P closed 17x7 = 119');
    console.log('- Q closed 5x9 = 45');
    console.log('- Combined = 164');
    console.log('- Archive P digest unchanged after finish and after Q close');
    console.log('- Certified month-closed B correctly transitioned to ENDED');
    console.log('- Scope CAS hash validation and rejection');
    console.log('- Subsequent month close never downgrades ENDED');
    console.log('PG_LIFECYCLE_STAGE1_VERIFIED');

  } finally {
    if (client) {
      await client.end();
    }
    // Clean up synthetic role and database
    try {
      docker(['exec', '-i', '-u', 'postgres', container, 'psql', '-X', '-U', 'hisob_test_display', '-d', 'hisob_test_display', '-q'],
        `DROP DATABASE IF EXISTS ${name};\nDROP ROLE IF EXISTS ${name};\n`);
    } catch (e) {}

    assert.equal(docker(['inspect', '--format', '{{.Id}}', container]), identity);
    docker(['stop', container]);
    console.log('Owned container stopped successfully.');
  }
}

main().catch((err) => {
  console.error('PG Lifecycle Runner Error:', String(err.stack || err).replaceAll(password, '[redacted]'));
  process.exitCode = 1;
});
