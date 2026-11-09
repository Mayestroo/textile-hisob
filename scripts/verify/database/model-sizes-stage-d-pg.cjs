'use strict';
// Bounded Stage D fixture: actual PostgreSQL mutation/dedup plus fresh SQLite backup/restore.
// It uses only the exact locally-owned container documented in LOCAL-TEST-DATABASE.md.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const root = path.resolve(__dirname, '../../..');
const container = 'hisob_test_display_05d2b2';
const identity = 'f8070090fa5aaedf8aa34a983c8606be4b8954d4d0aa7f7993352caf29a0c9d3';
const dbName = `hisob_test_model_sizes_d_${crypto.randomBytes(5).toString('hex')}`;
const password = crypto.randomBytes(32).toString('hex');
const safeEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, APPDATA: process.env.APPDATA };
for (const key of ['DATABASE_URL', 'NOVDA_PG_URL', 'NOVDA_LOCAL_TEST_PG_URL']) delete process.env[key];
const { applyMigrations } = require(path.join(root, 'ops/deploy/migrateProduction.cjs'));
const { canonicalStringify, computePayloadHash } = require(path.join(root, 'apps/server/modules/sync/canonicalPayload.cjs'));
const { processSingleOperation } = require(path.join(root, 'apps/server/modules/sync/handlers/operations.cjs'));
const { readCompanySnapshot, withCompanyBootstrapSnapshot } = require(path.join(root, 'apps/server/modules/sync/bootstrapSnapshot.cjs'));
const { applyBootstrapSnapshot } = require(path.join(root, 'apps/desktop/electron/sync/bootstrapApplier.cjs'));
const { applyChangesBatch, getLocalCursor } = require(path.join(root, 'apps/desktop/electron/sync/changeFeedApplier.cjs'));
const { createChangeFeedHandler } = require(path.join(root, 'apps/server/modules/sync/handlers/changeFeed.cjs'));
const { dispatchOutbox } = require(path.join(root, 'apps/desktop/electron/sync/outboxDispatcher.cjs'));
const databaseManager = require(path.join(root, 'apps/desktop/electron/database/databaseManager.cjs'));
const { executeWorkbookCommand } = require(path.join(root, 'apps/desktop/electron/database/workbookCommandPipeline.cjs'));
const { backupCompanyDatabase, restoreCompanyDatabase } = require(path.join(root, 'apps/desktop/electron/database/sqliteBackup.cjs'));
const { loadWorkbookProjectionFromSqlite } = require(path.join(root, 'apps/desktop/electron/database/projectionReader.cjs'));

function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', env: safeEnv, timeout: 30000 });
  assert.equal(result.status, 0, `owned-container command failed: ${args[0]}`);
  return result.stdout.trim();
}
function guard(url) {
  const result = spawnSync(process.execPath, [path.join(root, '.opencode/deep-audit/output/local-test-db/assert-local-pg.cjs')],
    { env: { NOVDA_LOCAL_TEST_PG_URL: url }, encoding: 'utf8' });
  assert.equal(result.status, 0, 'explicit local PostgreSQL boundary check failed');
}
function makeOperation(companyId, operationId, payload, baseRevision) {
  const normalized = JSON.parse(canonicalStringify({ ...payload,
    companyId, operationId, commandId: `cmd-${operationId}` }));
  return { operationId, companyId, commandType: 'UpdateBatchSettings', entityType: 'batch_settings',
    entityId: companyId, baseRevision, payload: normalized, payloadHash: computePayloadHash(canonicalStringify(normalized)) };
}
function printOperation(companyId, operationId, payload) {
  const normalized = JSON.parse(canonicalStringify({ ...payload,
    companyId, operationId, commandId: `cmd-${operationId}`,
    parties: payload.parties.map(party=>({...party, companyId, operationId, commandId:`cmd-${operationId}`})) }));
  return { operationId, companyId, commandType: 'CompletePattaBatch', entityType: 'patta_batch',
    entityId: payload.batchId, baseRevision: 0, payload: normalized,
    payloadHash: computePayloadHash(canonicalStringify(normalized)) };
}
function printPayload(companyId, batchId, partyId, modelId, revision, configs) {
  return { batchId, batchSettingsBaseRevision: revision, availableSizes: ['M','L'], configs,
    parties: [{ id:partyId, partyRecordId:partyId, partyNumber:partyId, modelId, modelName:'Synthetic A',
      color:'Qora', pattaCount:1, cumulativePattaCount:1, ishSoniPerPatta:25, totalIshSoni:25,
      ishSoni:25, cumulativeIshSoni:25, sizes:{M:1}, sizeOrder:['M'], printedAt:'2026-11-07T00:00:00.000Z' }] };
}
function config(modelId, sizeNames, sizes) {
  return { modelId, partyNumber: '', isCustomParty: false, totalIshSoni: '', color: null, sizeNames, sizes };
}
async function main() {
  assert.equal(docker(['inspect', '--format', '{{.Id}}', container]), identity, 'owned container identity mismatch');
  let pool;
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hisob-model-sizes-d-'));
  const companyId = `hisob_test_model_sizes_d_${crypto.randomBytes(4).toString('hex')}`;
  const clientAPath = path.join(fixtureDir, 'client-a');
  const clientBPath = path.join(fixtureDir, 'client-b');
  const destinationPath = path.join(fixtureDir, 'restored');
  try {
    if (docker(['inspect', '--format', '{{.State.Status}}', container]) === 'exited') docker(['start', container]);
    assert.equal(docker(['inspect', '--format', '{{.Id}}', container]), identity);
    const binding = docker(['port', container, '5432/tcp']);
    assert.match(binding, /^127\.0\.0\.1:\d+$/);
    const url = `postgresql://${dbName}:${password}@${binding}/${dbName}`;
    guard(url);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const probe = spawnSync('docker', ['exec', '-u', 'postgres', container, 'pg_isready', '-U', 'hisob_test_display', '-d', 'hisob_test_display'],
        { encoding:'utf8', env:safeEnv, timeout:10000 });
      if (probe.status === 0) { ready = true; break; }
      await new Promise(resolve=>setTimeout(resolve, 250));
    }
    assert(ready, 'owned PostgreSQL fixture did not become ready');
    // Create only this run's random role/database through the owned container's local socket.
    docker(['exec', '-i', '-u', 'postgres', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'hisob_test_display', '-d', 'hisob_test_display', '-q'],
      `CREATE ROLE ${dbName} LOGIN PASSWORD '${password}';\nCREATE DATABASE ${dbName} OWNER ${dbName};\n`);
    guard(url);
    pool = new Pool({ connectionString: url });
    await applyMigrations(pool);
    await pool.query('INSERT INTO models(id,company_id,name) VALUES ($1,$2,$3),($4,$2,$5),($6,$2,$7),($8,$2,$9)',
      [`model-a-${dbName}`, companyId, 'Synthetic A', `model-b-${dbName}`, 'Synthetic B', `empty-${dbName}`,
        'Synthetic empty', `legacy-${dbName}`, 'Synthetic legacy']);
    const req = { auth: { companyId, deviceId: 'synthetic-stage-d', clientVersion: '1.0.0' } };
    const modelA = `model-a-${dbName}`;
    const modelB = `model-b-${dbName}`;
    const initial = { companyId, availableSizes: ['M', 'L'], configs: [
      config(modelA, ['M', 'XXL'], { M: '1', XXL: '2' }), config(modelB, ['L'], { L: '1' }),
      config(`empty-${dbName}`, [], {}), config(`legacy-${dbName}`, null, {})
    ] };
    const op1 = makeOperation(companyId, `op-stage-d-first-${dbName}`, initial, 0);
    const applied = await processSingleOperation(pool, req, op1);
    assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
    const lostAckRetry = await processSingleOperation(pool, req, op1);
    assert.equal(lostAckRetry.status, 'APPLIED');
    assert.equal(lostAckRetry.isReplay, true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM operations_dedup WHERE company_id=$1 AND operation_id=$2',
      [companyId, op1.operationId])).rows[0].n, 1);
    const guardedPool = { connect: async () => ({ query: pool.query.bind(pool), release() {} }) };
    const bootstrap = await withCompanyBootstrapSnapshot(guardedPool, companyId);
    let clientA = databaseManager.getCompanyDatabase(clientAPath, companyId);
    applyBootstrapSnapshot(clientA, companyId, { success: true, ...bootstrap,
      feedBaseline: { protocolVersion: 1, companyId, headCursor: bootstrap.cursor } });
    databaseManager.closeAllCompanyDatabases();
    let clientB = databaseManager.getCompanyDatabase(clientBPath, companyId);
    applyBootstrapSnapshot(clientB, companyId, { success: true, ...bootstrap,
      feedBaseline: { protocolVersion: 1, companyId, headCursor: bootstrap.cursor } });
    databaseManager.closeAllCompanyDatabases();
    const readModels = (db) => {
      const rows = db.prepare('SELECT model_id,size_names_json,sizes_json FROM patta_batch_settings WHERE company_id=? ORDER BY model_id').all(companyId);
      return rows.map((r) => ({ id:r.model_id, names:r.size_names_json == null ? null : JSON.parse(r.size_names_json),
        counts: JSON.parse(r.sizes_json) }));
    };
    const expectedInitial = [
      { id:`empty-${dbName}`, names:[], counts:{} },
      { id:`legacy-${dbName}`, names:null, counts:{} },
      { id:modelA, names:['M','XXL'], counts:{ M:'1', XXL:'2' } },
      { id:modelB, names:['L'], counts:{ L:'1' } }
    ];
    clientA = databaseManager.getCompanyDatabase(clientAPath, companyId);
    assert.deepEqual(readModels(clientA), expectedInitial);
    databaseManager.closeAllCompanyDatabases();
    clientB = databaseManager.getCompanyDatabase(clientBPath, companyId);
    assert.deepEqual(readModels(clientB), expectedInitial);
    databaseManager.closeAllCompanyDatabases();

    // Both SQLite clients make real canonical outbox operations at the same revision.
    const command = (dbPath, db, operationId, aNames, bNames, rev, bCounts = {L:'1'}) => executeWorkbookCommand(dbPath, companyId, {
      commandType:'UpdateBatchSettings', commandId:`cmd-${operationId}`, operationId, companyId, entityId:companyId,
      baseRevision:rev, payload:{ availableSizes:['M','L'], configs:[config(modelA,aNames,{M:'1',XXL:'2'}),config(modelB,bNames,bCounts),config(`empty-${dbName}`,[],{}),config(`legacy-${dbName}`,null,{})] }
    });
    const opA = `op-stage-d-client-a-${dbName}`;
    const opB = `op-stage-d-client-b-${dbName}`;
    clientA = databaseManager.getCompanyDatabase(clientAPath, companyId);
    command(clientAPath, clientA, opA, ['M','XXL','A-EDIT'], ['L'], null);
    const outboxA = clientA.prepare('SELECT payload_json,payload_hash FROM local_outbox WHERE operation_id=?').get(opA);
    databaseManager.closeAllCompanyDatabases();
    clientB = databaseManager.getCompanyDatabase(clientBPath, companyId);
    command(clientBPath, clientB, opB, ['M','XXL'], ['L','B-WINNER'], null, {L:'1','B-WINNER':'3'});
    const outboxB = clientB.prepare('SELECT payload_json,payload_hash FROM local_outbox WHERE operation_id=?').get(opB);
    assert(outboxA && outboxB, 'both canonical local commands must create durable outbox payloads');
    const payloadA = JSON.parse(outboxA.payload_json);
    const payloadB = JSON.parse(outboxB.payload_json);
    assert.deepEqual(clientB.prepare("SELECT operation_id,command_type,status FROM local_outbox WHERE company_id=? AND status='PENDING'").all(companyId),
      [{ operation_id:opB, command_type:'UpdateBatchSettings', status:'PENDING' }]);
    assert.deepEqual(payloadA.configs.map(c=>c.sizeNames), [['M','XXL','A-EDIT'],['L'],[],null]);
    assert.deepEqual(payloadB.configs.map(c=>c.sizeNames), [['M','XXL'],['L','B-WINNER'],[],null]);
    assert.deepEqual(payloadB.configs.find(c=>c.modelId===modelB).sizes, {L:'1','B-WINNER':'3'});
    const serverPool = { connect: async () => ({ query: pool.query.bind(pool), release() {} }) };
    const transport = { pushOperations: async operations => ({ results: await Promise.all(operations.map(async operation =>
      JSON.parse(JSON.stringify(await processSingleOperation(serverPool, req, operation))))) }) };
    let loseAck = true;
    const lostAckTransport = { pushOperations: async operations => {
      for (const operation of operations) await processSingleOperation(serverPool, req, operation);
      if (loseAck) { loseAck = false; throw new Error('synthetic response lost after server commit'); }
      return transport.pushOperations(operations);
    } };
    const beforeLostAck = clientB.prepare('SELECT payload_json,payload_hash,status FROM local_outbox WHERE operation_id=?').get(opB);
    const lostAckResult = await dispatchOutbox(clientB, companyId, lostAckTransport, { baseUserDataPath:clientBPath });
    assert.equal(lostAckResult.transientErrors, 1, JSON.stringify(lostAckResult));
    const pendingAfterLoss = clientB.prepare('SELECT payload_json,payload_hash,status FROM local_outbox WHERE operation_id=?').get(opB);
    assert.deepEqual(pendingAfterLoss, { ...beforeLostAck, status:'PENDING' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM operations_dedup WHERE company_id=$1 AND operation_id=$2',
      [companyId,opB])).rows[0].n, 1);
    const ackB = await dispatchOutbox(clientB, companyId, lostAckTransport, { baseUserDataPath:clientBPath });
    assert.equal(ackB.synced, 1, JSON.stringify(ackB));
    assert.equal(clientB.prepare('SELECT status FROM local_outbox WHERE operation_id=?').get(opB).status, 'SYNCED');
    databaseManager.closeAllCompanyDatabases();
    clientA = databaseManager.getCompanyDatabase(clientAPath, companyId);
    const ackA = await dispatchOutbox(clientA, companyId, transport, { baseUserDataPath:clientAPath });
    assert.equal(ackA.conflict, 1, JSON.stringify(ackA));
    assert.equal(clientA.prepare('SELECT status FROM local_outbox WHERE operation_id=?').get(opA).status, 'CONFLICT');
    assert.deepEqual(JSON.parse(clientA.prepare('SELECT payload_json FROM local_outbox WHERE operation_id=?').get(opA).payload_json).configs.map(c=>c.sizeNames),
      [['M','XXL','A-EDIT'],['L'],[],null]);
    // A still has the old canonical snapshot. Its distinct print is a real
    // optimistic SQLite command; the server must reject it without accepting
    // either the party or the stale settings, retaining its exact outbox intent.
    const stalePrintId = `op-stale-print-${dbName}`;
    const stalePartyId = `stale-party-${dbName}`;
    const staleConfigs = [config(modelA,['M','XXL','A-EDIT'],{M:'',XXL:''}),
      config(modelB,['L'],{L:'1'}),config(`empty-${dbName}`,[],{}),config(`legacy-${dbName}`,null,{})];
    const stalePayload = printPayload(companyId, `batch-stale-${dbName}`, stalePartyId, modelA,
      loadWorkbookProjectionFromSqlite(clientA, companyId).batchSettingsPrintRevision, staleConfigs);
    executeWorkbookCommand(clientAPath, companyId, { commandType:'CompletePattaBatch',
      commandId:`cmd-${stalePrintId}`, operationId:stalePrintId, companyId, entityId:stalePayload.batchId,
      payload:stalePayload });
    const staleIntent = clientA.prepare('SELECT payload_json,payload_hash FROM local_outbox WHERE operation_id=?').get(stalePrintId);
    assert.equal(JSON.parse(staleIntent.payload_json).batchSettingsBaseRevision, 1);
    const staleAck = await dispatchOutbox(clientA, companyId, transport, { baseUserDataPath:clientAPath });
    assert.equal(staleAck.conflict, 1, JSON.stringify(staleAck));
    assert.equal(clientA.prepare('SELECT status FROM local_outbox WHERE operation_id=?').get(stalePrintId).status, 'CONFLICT');
    assert.deepEqual(clientA.prepare('SELECT payload_json,payload_hash FROM local_outbox WHERE operation_id=?').get(stalePrintId), staleIntent);
    assert.equal((await pool.query('SELECT count(*)::int n FROM parties WHERE company_id=$1 AND id=$2', [companyId,stalePartyId])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM change_log WHERE company_id=$1 AND operation_id=$2', [companyId,stalePrintId])).rows[0].n, 0);
    const afterStale = await readCompanySnapshot(pool, companyId);
    assert.equal(afterStale.snapshot.batchSettings.company.serverRevision, 2);
    const afterStaleB = afterStale.snapshot.batchSettings.models.find(c=>c.modelId===modelB);
    assert.deepEqual(afterStaleB.sizeNames, ['L','B-WINNER']);
    assert.deepEqual(afterStaleB.sizes, {L:'1','B-WINNER':'3'});
    const feedHandler = createChangeFeedHandler(serverPool);
    const deliverFeed = async db => {
      const fromCursor = getLocalCursor(db);
      let response;
      await feedHandler({ auth:{companyId}, query:{cursor:fromCursor,limit:200} }, { code(){return this;}, send(value){response=value;return value;}, reply(value){response=value;return value;} });
      assert.equal(response.success, true);
      applyChangesBatch(db, companyId, response.items, response.nextCursor, { feedResponse:response });
      return response;
    };
    const feedA = await deliverFeed(clientA);
    const expectedWinner = [
      { id:`empty-${dbName}`, names:[], counts:{} },
      { id:`legacy-${dbName}`, names:null, counts:{} },
      { id:modelA, names:['M','XXL'], counts:{ M:'1', XXL:'2' } },
      { id:modelB, names:['L','B-WINNER'], counts:{ L:'1', 'B-WINNER':'3' } }
    ];
    assert.deepEqual(readModels(clientA), expectedWinner);
    databaseManager.closeAllCompanyDatabases();
    clientB = databaseManager.getCompanyDatabase(clientBPath, companyId);
    const feedB = await deliverFeed(clientB);
    assert(feedA.items.some(item=>item.operationId===opB), 'A must consume B winning change through production feed handler');
    assert(feedB.items.some(item=>item.operationId===opB), 'B must consume its acknowledged change through production feed handler');
    assert.deepEqual(readModels(clientB), expectedWinner);
    const refreshedBootstrap = await withCompanyBootstrapSnapshot(serverPool, companyId);
    const freshBootstrapPath = path.join(fixtureDir, 'bootstrap-b');
    databaseManager.closeAllCompanyDatabases();
    let bootstrapClient = databaseManager.getCompanyDatabase(freshBootstrapPath, companyId);
    applyBootstrapSnapshot(bootstrapClient, companyId, { success:true, ...refreshedBootstrap,
      feedBaseline:{ protocolVersion:1, companyId, headCursor:refreshedBootstrap.cursor } });
    assert.deepEqual(readModels(bootstrapClient), expectedWinner);
    databaseManager.closeAllCompanyDatabases();
    clientA = databaseManager.getCompanyDatabase(clientAPath, companyId);
    assert.equal(clientA.prepare('SELECT status FROM local_outbox WHERE operation_id=?').get(opA).status, 'CONFLICT');
    const freshBootstrapAPath = path.join(fixtureDir, 'bootstrap-a');
    bootstrapClient = databaseManager.getCompanyDatabase(freshBootstrapAPath, companyId);
    applyBootstrapSnapshot(bootstrapClient, companyId, { success:true, ...refreshedBootstrap,
      feedBaseline:{ protocolVersion:1, companyId, headCursor:refreshedBootstrap.cursor } });
    assert.deepEqual(readModels(bootstrapClient), expectedWinner);
    assert.deepEqual(readModels(clientA), expectedWinner);
    assert.equal(clientA.prepare('SELECT count(*) n FROM parties WHERE company_id=? AND id=?').get(companyId,stalePartyId).n, 0);
    assert.equal(clientA.prepare('SELECT status FROM local_outbox WHERE operation_id=?').get(stalePrintId).status, 'CONFLICT');
    // A fresh print uses the revision from the real projection, survives an ACK
    // lost after commit, and is accepted exactly once on identical replay.
    databaseManager.closeAllCompanyDatabases();
    clientB = databaseManager.getCompanyDatabase(clientBPath, companyId);
    const freshPrintId = `op-fresh-print-${dbName}`;
    const freshPartyId = `fresh-party-${dbName}`;
    const freshProjection = loadWorkbookProjectionFromSqlite(clientB, companyId);
    assert.equal(freshProjection.batchSettingsServerRevision, 2);
    assert.equal(freshProjection.batchSettingsPrintRevision, 2);
    const freshConfigs = [config(modelA,['M','XXL'],{M:'',XXL:''}),
      config(modelB,['L','B-WINNER'],{L:'1','B-WINNER':'3'}),config(`empty-${dbName}`,[],{}),config(`legacy-${dbName}`,null,{})];
    const freshPayload = printPayload(companyId, `batch-fresh-${dbName}`, freshPartyId, modelA,
      freshProjection.batchSettingsPrintRevision, freshConfigs);
    executeWorkbookCommand(clientBPath, companyId, { commandType:'CompletePattaBatch',
      commandId:`cmd-${freshPrintId}`, operationId:freshPrintId, companyId, entityId:freshPayload.batchId,
      payload:freshPayload });
    const beforePrintLoss = clientB.prepare('SELECT payload_json,payload_hash,status FROM local_outbox WHERE operation_id=?').get(freshPrintId);
    loseAck = true;
    const printLoss = await dispatchOutbox(clientB, companyId, lostAckTransport, { baseUserDataPath:clientBPath });
    assert.equal(printLoss.transientErrors, 1, JSON.stringify(printLoss));
    assert.deepEqual(clientB.prepare('SELECT payload_json,payload_hash,status FROM local_outbox WHERE operation_id=?').get(freshPrintId), beforePrintLoss);
    const printReplay = await dispatchOutbox(clientB, companyId, transport, { baseUserDataPath:clientBPath });
    assert.equal(printReplay.synced, 1, JSON.stringify(printReplay));
    assert.equal(loadWorkbookProjectionFromSqlite(clientB, companyId).batchSettingsServerRevision, 3);
    assert.equal((await pool.query('SELECT count(*)::int n FROM operations_dedup WHERE company_id=$1 AND operation_id=$2', [companyId,freshPrintId])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM parties WHERE company_id=$1 AND id=$2', [companyId,freshPartyId])).rows[0].n, 1);
    const freshServer = await readCompanySnapshot(pool, companyId);
    assert.equal(freshServer.snapshot.batchSettings.company.serverRevision, 3);
    assert.deepEqual(new Map(freshServer.snapshot.batchSettings.models.map(c=>[c.modelId,c])).get(modelB).sizeNames, ['L','B-WINNER']);
    // Omitted revision must not be interpreted as zero/current; omitted old
    // sizeNames at a valid revision still retain the established definitions.
    const oldPartyId = `old-party-${dbName}`;
    const noBase = printPayload(companyId, `batch-no-base-${dbName}`, oldPartyId, modelA, 3, freshConfigs);
    delete noBase.batchSettingsBaseRevision;
    const missing = await processSingleOperation(pool, req, printOperation(companyId, `op-no-base-${dbName}`, noBase));
    assert.equal(missing.status, 'CONFLICT', JSON.stringify(missing));
    assert.equal(missing.error?.code, 'REVISION_CONFLICT');
    assert.equal((await pool.query('SELECT count(*)::int n FROM parties WHERE company_id=$1 AND id=$2', [companyId,oldPartyId])).rows[0].n, 0);
    const oldConfigs = freshConfigs.map(({sizeNames, ...rest})=>rest);
    const oldValid = printPayload(companyId, `batch-old-valid-${dbName}`, oldPartyId, modelA, 3, oldConfigs);
    const oldAccepted = await processSingleOperation(pool, req, printOperation(companyId, `op-old-valid-${dbName}`, oldValid));
    assert.equal(oldAccepted.status, 'APPLIED', JSON.stringify(oldAccepted));
    const oldServer = await readCompanySnapshot(pool, companyId);
    assert.deepEqual(new Map(oldServer.snapshot.batchSettings.models.map(c=>[c.modelId,c])).get(modelB).sizeNames, ['L','B-WINNER']);
    // Local failures after a fact write must roll back both party and settings.
    const rollbackId = `rollback-party-${dbName}`;
    const rollbackProjection = loadWorkbookProjectionFromSqlite(clientB, companyId);
    const rollbackPayload = printPayload(companyId, `batch-rollback-${dbName}`, rollbackId, modelA,
      rollbackProjection.batchSettingsPrintRevision, freshConfigs);
    assert.throws(() => executeWorkbookCommand(clientBPath, companyId, { commandType:'CompletePattaBatch',
      commandId:`cmd-${rollbackId}`, operationId:`op-${rollbackId}`, companyId, entityId:rollbackPayload.batchId,
      payload:rollbackPayload }, { testHooks:{ afterFactWrite(){ throw Error('synthetic rollback'); } } }), /synthetic rollback/);
    assert.equal(clientB.prepare('SELECT count(*) n FROM parties WHERE company_id=? AND id=?').get(companyId,rollbackId).n, 0);
    assert.equal(clientB.prepare('SELECT count(*) n FROM local_outbox WHERE operation_id=?').get(`op-${rollbackId}`).n, 0);
    const rejectedLocal = { ...rollbackPayload, batchId:`batch-missing-local-${dbName}` };
    delete rejectedLocal.batchSettingsBaseRevision;
    assert.throws(() => executeWorkbookCommand(clientBPath, companyId, { commandType:'CompletePattaBatch',
      commandId:`cmd-missing-local-${dbName}`, operationId:`op-missing-local-${dbName}`,
      companyId, entityId:rejectedLocal.batchId, payload:rejectedLocal }), /reload before printing/);
    assert.equal(clientB.prepare('SELECT count(*) n FROM parties WHERE company_id=? AND id=?').get(companyId,rollbackId).n, 0);
    databaseManager.closeAllCompanyDatabases();
    const serverSnapshot = await readCompanySnapshot(pool, companyId);
    const settings = serverSnapshot.snapshot.batchSettings;
    const metadata = new Map(settings.models.map(c=>[c.modelId,c]));
    assert.deepEqual(metadata.get(modelA).sizeNames, ['M','XXL']);
    assert.deepEqual(metadata.get(modelB).sizeNames, ['L','B-WINNER']);
    assert.deepEqual(metadata.get(`empty-${dbName}`).sizeNames, []);
    assert.equal(metadata.get(`legacy-${dbName}`).sizeNames, null);
    assert.deepEqual(metadata.get(modelA).sizes, { M:'', XXL:'' });
    assert.deepEqual(metadata.get(modelB).sizes, { L:'1', 'B-WINNER':'3' });
    const wrongCompany = `hisob_test_other_${crypto.randomBytes(4).toString('hex')}`;
    const rejectedScope = await processSingleOperation(pool, req, makeOperation(wrongCompany, `op-wrong-scope-${dbName}`,
      { companyId:wrongCompany, availableSizes:[], configs:[] }, 0));
    assert.equal(rejectedScope.status, 'REJECTED');

    // A legacy update which omits sizeNames cannot erase established explicit definitions.
    const legacyPayload = { companyId, availableSizes:['M','L'], configs:[
      { modelId:modelA, partyNumber:'', isCustomParty:false, totalIshSoni:'', color:null, sizes:{M:'1',XXL:'2'} }
    ] };
    const legacy = await processSingleOperation(pool, req,
      makeOperation(companyId, `op-stage-d-legacy-${dbName}`, legacyPayload, settings.company.serverRevision));
    assert.equal(legacy.status, 'APPLIED', JSON.stringify(legacy));
    const legacyRead = await readCompanySnapshot(pool, companyId);
    const legacyMap = new Map(legacyRead.snapshot.batchSettings.models.map(c=>[c.modelId,c]));
    assert.deepEqual(legacyMap.get(modelA).sizeNames, ['M','XXL']);
    assert.deepEqual(legacyMap.get(modelB).sizeNames, ['L','B-WINNER']);
    assert.deepEqual(legacyMap.get(`empty-${dbName}`).sizeNames, []);
    assert.equal(legacyMap.get(`legacy-${dbName}`).sizeNames, null);

    // Normal offline order: settings update followed by print at the predicted
    // next revision. Dispatch must not send these together or invert them.
    databaseManager.closeAllCompanyDatabases();
    clientB = databaseManager.getCompanyDatabase(clientBPath, companyId);
    await deliverFeed(clientB);
    const orderedStart = loadWorkbookProjectionFromSqlite(clientB, companyId);
    const orderedConfigs = [config(modelA,['M','XXL'],{M:'1',XXL:'2'}),
      config(modelB,['L','B-WINNER','ORDERED'],{L:'1','B-WINNER':'3',ORDERED:'4'}),
      config(`empty-${dbName}`,[],{}),config(`legacy-${dbName}`,null,{})];
    const orderedUpdateId = `op-ordered-settings-${dbName}`;
    executeWorkbookCommand(clientBPath, companyId, { commandType:'UpdateBatchSettings',
      commandId:`cmd-${orderedUpdateId}`, operationId:orderedUpdateId, companyId, entityId:companyId,
      payload:{availableSizes:['M','L'],configs:orderedConfigs} });
    const queued = loadWorkbookProjectionFromSqlite(clientB, companyId);
    assert.equal(queued.batchSettingsServerRevision, orderedStart.batchSettingsServerRevision);
    assert.equal(queued.batchSettingsPrintRevision, orderedStart.batchSettingsServerRevision + 1);
    const orderedPartyId = `ordered-party-${dbName}`;
    const orderedPrintId = `op-ordered-print-${dbName}`;
    const orderedPrint = printPayload(companyId, `batch-ordered-${dbName}`, orderedPartyId, modelA,
      queued.batchSettingsPrintRevision, orderedConfigs);
    executeWorkbookCommand(clientBPath, companyId, { commandType:'CompletePattaBatch',
      commandId:`cmd-${orderedPrintId}`, operationId:orderedPrintId, companyId,
      entityId:orderedPrint.batchId, payload:orderedPrint });
    assert.equal(loadWorkbookProjectionFromSqlite(clientB, companyId).batchSettingsPrintRevision,
      orderedStart.batchSettingsServerRevision + 2);
    const firstOrdered = await dispatchOutbox(clientB, companyId, transport, {baseUserDataPath:clientBPath});
    assert.equal(firstOrdered.synced, 1, JSON.stringify({firstOrdered, outbox:clientB.prepare(`SELECT operation_id,command_type,base_revision,status,last_error FROM local_outbox WHERE operation_id IN (?,?)`).all(orderedUpdateId,orderedPrintId)}));
    assert.equal(clientB.prepare('SELECT status FROM local_outbox WHERE operation_id=?').get(orderedPrintId).status, 'PENDING');
    const secondOrdered = await dispatchOutbox(clientB, companyId, transport, {baseUserDataPath:clientBPath});
    assert.equal(secondOrdered.synced, 1, JSON.stringify(secondOrdered));
    assert.equal(clientB.prepare('SELECT status FROM local_outbox WHERE operation_id=?').get(orderedPrintId).status, 'SYNCED');
    assert.equal((await pool.query('SELECT count(*)::int n FROM parties WHERE company_id=$1 AND id=$2', [companyId,orderedPartyId])).rows[0].n, 1);
    const orderedServer = await readCompanySnapshot(pool, companyId);
    assert.deepEqual(new Map(orderedServer.snapshot.batchSettings.models.map(c=>[c.modelId,c])).get(modelB).sizes,
      { L:'1', 'B-WINNER':'3', ORDERED:'4' });
    await deliverFeed(clientB);
    assert.equal(loadWorkbookProjectionFromSqlite(clientB, companyId).batchSettingsPrintRevision,
      orderedStart.batchSettingsServerRevision + 2);
    databaseManager.closeAllCompanyDatabases();

    // Actual production backup and restore entrypoints, independent fresh destination.
    databaseManager.closeAllCompanyDatabases();
    clientA = databaseManager.getCompanyDatabase(clientAPath, companyId);
    const partyId = `party-stage-d-${dbName}`;
    const printed = { partyRecordId:partyId, partyNumber:'81', modelId:modelA, modelName:'Synthetic A', color:'Qora',
      pattaCount:2, cumulativePattaCount:2, ishSoniPerPatta:25, totalIshSoni:50, ishSoni:50,
      cumulativeIshSoni:50, sizes:{ XXL:1, M:1 }, sizeOrder:['XXL','M'], printedAt:'2026-11-07T00:00:00.000Z' };
    executeWorkbookCommand(clientAPath, companyId, { commandType:'CreateParty', commandId:`cmd-${partyId}`,
      operationId:`op-${partyId}`, companyId, entityId:partyId, payload:printed });
    const periodId = `period-${dbName}`;
    clientA.prepare(`INSERT INTO periods(id,company_id,name,start_date,end_date,is_closed,status,created_at)
      VALUES(?,?,?,'2026-11-01','2026-11-30',1,'CLOSED',?)`).run(periodId,companyId,'Synthetic archived period','2026-11-07T00:00:00.000Z');
    const ticketId = `ticket-stage-d-${dbName}`;
    clientA.prepare(`INSERT INTO tickets(id,company_id,model_id,party_number,party_record_id,patta_number,qty,size,color,status,submitted_at,created_at)
      VALUES(?,?,?,?,?,81,25,'XXL','Qora','CONFIRMED','2026-11-07T00:01:00.000Z','2026-11-07T00:01:00.000Z')`)
      .run(ticketId,companyId,modelA,'81',partyId);
    const archiveJson = JSON.stringify({ period:{id:periodId}, printedPartyHistory:[{...printed}], ticketIds:[ticketId], qty:25 });
    const archiveHash = crypto.createHash('sha256').update(archiveJson).digest('hex');
    clientA.prepare('INSERT INTO period_archives(company_id,period_id,archive_json,sha256,archived_at) VALUES(?,?,?,?,?)')
      .run(companyId,periodId,archiveJson,archiveHash,'2026-11-07T00:02:00.000Z');
    executeWorkbookCommand(clientAPath, companyId, { commandType:'UpdateBatchSettings', commandId:`backup-${dbName}`,
      operationId:`op-backup-${dbName}`, companyId, entityId:companyId,
      payload:{ availableSizes:['M','L'], configs:[config(modelA,['M','XXL'],{M:'1',XXL:'2'}),
         config(modelB,['L','B-WINNER'],{L:'1','B-WINNER':'3'}),config(`empty-${dbName}`,[],{}),config(`legacy-${dbName}`,null,{})] } });
    const backupFile = path.join(fixtureDir, 'stage-d.sqlite');
    await backupCompanyDatabase(clientAPath, companyId, backupFile);
    const restore = restoreCompanyDatabase(backupFile, destinationPath, companyId);
    assert.equal(restore.success, true);
    const restoredDb = databaseManager.getCompanyDatabase(destinationPath, companyId);
    const projection = loadWorkbookProjectionFromSqlite(restoredDb, companyId);
    const restoredConfigs = new Map(Object.entries(projection.pattaBatchConfigs));
    assert.deepEqual(restoredConfigs.get(modelA).sizeNames, ['M','XXL']);
    assert.deepEqual(restoredConfigs.get(modelB).sizeNames, ['L','B-WINNER']);
    assert.deepEqual(restoredConfigs.get(`empty-${dbName}`).sizeNames, []);
    assert.equal(restoredConfigs.get(`legacy-${dbName}`).sizeNames, null);
    assert.deepEqual(restoredConfigs.get(modelA).sizes, { M:'1', XXL:'2' });
    assert.deepEqual(restoredConfigs.get(modelB).sizes, { L:'1', 'B-WINNER':'3' });
    const restoredParty = restoredDb.prepare('SELECT id,sizes_json,size_order_json,patta_count FROM parties WHERE company_id=? AND id=?').get(companyId,partyId);
    assert.deepEqual(restoredParty, { id:partyId, sizes_json:'{"XXL":1,"M":1}', size_order_json:'["XXL","M"]', patta_count:2 });
    const restoredTicket = restoredDb.prepare('SELECT id,qty,size,party_record_id FROM tickets WHERE company_id=? AND id=?').get(companyId,ticketId);
    assert.deepEqual(restoredTicket, { id:ticketId, qty:25, size:'XXL', party_record_id:partyId });
    const restoredArchive = restoredDb.prepare('SELECT archive_json,sha256 FROM period_archives WHERE company_id=? AND period_id=?').get(companyId,periodId);
    assert.deepEqual(restoredArchive,{ archive_json:archiveJson, sha256:archiveHash });
    console.log(`MODEL_SIZES_STAGE_D_PASS: B-WINNER count 3 survives stale A print PG/feed/bootstrap; A outbox CONFLICT and no accepted party; fresh print/ordered offline update+print APPLIED; exact lost-ACK print replay dedup; missing revision rejected; old omitted names retained; local rollback and backup/restore preserved ${partyId} sizeOrder [XXL,M], ${ticketId} qty 25 and archive SHA-256`);
  } finally {
    if (pool) await pool.end();
    databaseManager.closeAllCompanyDatabases();
    fs.rmSync(fixtureDir, { recursive:true, force:true });
    assert.equal(docker(['inspect', '--format', '{{.Id}}', container]), identity);
    docker(['stop', container]);
  }
}
main().catch((error) => { console.error(String(error.stack || error).replaceAll(password, '[redacted]')); process.exitCode = 1; });
