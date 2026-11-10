'use strict';
// Synthetic, owned-container-only acceptance of the real PostgreSQL migration runner.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { MIGRATIONS, applyMigrations } = require('../../ops/deploy/migrateProduction.cjs');
const { canonicalStringify, computePayloadHash } = require('../../apps/desktop/electron/database/core/canonicalPayload.cjs');
const { loadPayroll } = require('../../apps/server/modules/workers/payrollValuation.cjs');
const { readPeriodArchiveSource } = require('../../apps/server/modules/sync/workbookOperations.cjs');
const { withCompanyBootstrapSnapshot } = require('../../apps/server/modules/sync/bootstrapSnapshot.cjs');
const { processSingleOperation } = require('../../apps/server/modules/sync/handlers/operations.cjs');
const { executeWorkbookCommand } = require('../../apps/desktop/electron/database/commands/workbookCommandPipeline.cjs');
const databaseManager = require('../../apps/desktop/electron/database/core/databaseManager.cjs');
const { dispatchOutbox } = require('../../apps/desktop/electron/sync/outboxDispatcher.cjs');
const { applyBootstrapSnapshot } = require('../../apps/desktop/electron/sync/bootstrapApplier.cjs');
const { applyChangesBatch, getLocalCursor } = require('../../apps/desktop/electron/sync/changeFeedApplier.cjs');
const { readWorkbookPayrollProjection } = require('../../apps/desktop/electron/database/readers/workbookPayrollRead.cjs');
const { loadPayrollValuationFromSqlite } = require('../../apps/desktop/electron/database/readers/payrollReader.cjs');

const root = path.resolve(__dirname, '../../..');
const container = 'hisob_test_display_05d2b2';
const identity = 'f8070090fa5aaedf8aa34a983c8606be4b8954d4d0aa7f7993352caf29a0c9d3';
const ownRole = `hisob_test_9a_${crypto.randomBytes(4).toString('hex')}`;
const password = crypto.randomBytes(32).toString('hex');
const safeEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', env: safeEnv, timeout: 30000 });
  assert.equal(result.status, 0, `owned-container command failed: ${args[0]}`);
  return result.stdout.trim();
}
function socketSql(sql) {
  // SQL, including synthetic password, travels only over stdin, never argv or output.
  docker(['exec', '-i', '-u', 'postgres', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-U', 'hisob_test_display', '-d', 'hisob_test_display', '-q'], sql);
}
async function withDb(name, fn) {
  const url = new URL(process.env.NOVDA_LOCAL_TEST_PG_URL);
  url.pathname = `/${name}`;
  const guard = spawnSync(process.execPath, [path.join(root, '.opencode/deep-audit/output/local-test-db/assert-local-pg.cjs')], {
    env: { NOVDA_LOCAL_TEST_PG_URL: url.href }, encoding: 'utf8'
  });
  assert.equal(guard.status, 0, 'local PG guard failed');
  const client = new Client({ connectionString: url.href });
  await client.connect();
  try { await fn(client, url.href); } finally { await client.end(); }
}
const migrations = path.join(root, 'apps/server/database/migrations');
async function versions(db, count) {
  const rows = (await db.query('SELECT version,name FROM schema_migrations ORDER BY version')).rows;
  assert.deepEqual(rows, MIGRATIONS.slice(0, count).map((name, index) => ({ version: index + 1, name })));
}
async function facts(db) {
  const query = async (sql) => (await db.query(sql)).rows;
  return {
    ticket: await query("SELECT id,qty::text AS qty,status,period_id FROM tickets WHERE company_id='hisob_test_9a'"),
    entry: await query("SELECT id,qty::text AS qty,rate_snapshot::text AS rate FROM ticket_entries WHERE company_id='hisob_test_9a'"),
    correction: await query("SELECT adjustment_id,delta_qty::text AS qty,status FROM production_adjustments WHERE company_id='hisob_test_9a'"),
    workerAdjustments: await query("SELECT id,type,amount::text AS amount,period_id FROM worker_adjustments WHERE company_id='hisob_test_9a' ORDER BY id"),
    archive: await query("SELECT archive_json,sha256 FROM period_archives WHERE company_id='hisob_test_9a'"),
    dedup: await query("SELECT operation_id,payload_hash,result_json,server_revision FROM operations_dedup WHERE company_id='hisob_test_9a'"),
    audit: await query("SELECT policy_revision,require_ticket_validation,synchronized_device_count FROM activation_policy_events WHERE company_id='hisob_test_9a'")
  };
}
async function seed(db) {
  const company = 'hisob_test_9a';
  const ticket = '00000000-0000-4000-8000-00000000009a';
  const archive = { period: { id:'P',companyId:company }, models:[{ id:'m',operations:[{ name:'Sew',rate:7 }] }] };
  const hash = computePayloadHash(canonicalStringify(archive));
  await db.query('INSERT INTO models(id,company_id,name) VALUES ($1,$2,$3)', ['m',company,'Synthetic model']);
  await db.query('INSERT INTO workers(id,company_id,name) VALUES (7,$1,$2)', [company,'Synthetic worker']);
  await db.query("INSERT INTO periods(id,company_id,start_date,name,is_closed) VALUES ('P',$1,'2026-10-01','Synthetic closed',1)", [company]);
  await db.query("INSERT INTO parties(id,company_id,party_number,physical_party_number,model_id) VALUES ('party',$1,'1','1','m')", [company]);
  await db.query(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,party_record_id,patta_number,qty,submitted_at)
    VALUES ($1,$2,'m','P','1','party',1,12,'2026-10-12T12:00:00Z')`, [ticket,company]);
  await db.query("INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,rate_snapshot,qty) VALUES ('e',$1,$2,'Sew',7,5,12)", [ticket,company]);
  await db.query(`INSERT INTO production_adjustments(adjustment_id,company_id,model_id,worker_id,op_name,delta_qty,reason,status,created_by)
    VALUES ('correction',$1,'m',7,'Sew',-2,'synthetic','APPROVED','fixture')`, [company]);
  await db.query(`INSERT INTO worker_adjustments(id,company_id,worker_id,type,amount,source_id,provenance,period_id)
    VALUES ('legacy-avans',$1,7,'AVANS',123,'legacy-avans','fixture','P'),
      ('legacy-jarima',$1,7,'JARIMA',45,'legacy-jarima','fixture','P')`, [company]);
  await db.query('INSERT INTO period_archives(company_id,period_id,archive_json,sha256) VALUES ($1,\'P\',$2,$3)',
    [company, archive, hash]);
  await db.query(`INSERT INTO operations_dedup(company_id,operation_id,command_type,entity_type,entity_id,payload_hash,result_json,server_revision)
    VALUES ($1,'op-9a','SubmitTicket','ticket',$2,$3,$4,1)`, [company,ticket,crypto.createHash('sha256').update('synthetic operation').digest('hex'),{ accepted:true, qty:12 }]);
  await db.query('INSERT INTO company_batch_settings(company_id) VALUES ($1)', [company]);
  await db.query("INSERT INTO activation_companies(company_id,company_name,updated_by_telegram_id) VALUES ($1,'Synthetic','1')", [company]);
  await db.query(`INSERT INTO activation_policy_events(company_id,actor_telegram_id,previous_require_ticket_validation,require_ticket_validation,policy_revision,synchronized_device_count)
    VALUES ($1,'1',TRUE,FALSE,2,3)`, [company]);
  return { ticket,hash };
}
async function assertManualPayrollTypeCompatibility(db, suffix) {
  const company = `hisob_test_types_${suffix}`;
  await db.query(`INSERT INTO workers(id,company_id,name) VALUES (1,$1,'Type fixture')`, [company]);
  await db.query(`INSERT INTO periods(id,company_id,name,start_date,is_closed)
    VALUES ('TYPE1',$1,'Type period','2026-10-01',0)`, [company]);
  await db.query(`INSERT INTO worker_adjustments(id,company_id,worker_id,period_id,type,amount,source_id,provenance)
    VALUES ($1,$2,1,'TYPE1','OKLAD',0,$1,'fixture'), ($3,$2,1,'TYPE1','MAGAZIN',0,$3,'fixture')`,
    [`oklad-${suffix}`, company, `magazin-${suffix}`]);
  const rows = await db.query(`SELECT type, amount::text AS amount, status FROM worker_adjustments
    WHERE company_id=$1 ORDER BY type`, [company]);
  assert.deepEqual(rows.rows.map(row => [row.type, Number(row.amount), row.status]), [
    ['MAGAZIN', 0, 'POSTED'], ['OKLAD', 0, 'POSTED']
  ]);
  await assert.rejects(db.query(`INSERT INTO worker_adjustments(id,company_id,worker_id,type,amount,source_id,provenance)
    VALUES ('bad-type-${suffix}',$1,1,'UNKNOWN',1,'bad','fixture')`, [company]), /check constraint/);
  await assert.rejects(db.query(`INSERT INTO worker_adjustments(id,company_id,worker_id,type,amount,source_id,provenance)
    VALUES ('missing-period-${suffix}',$1,1,'OKLAD',1,'missing-period','fixture')`, [company]), /check constraint/);
  await assert.rejects(db.query(`INSERT INTO worker_adjustments(id,company_id,worker_id,period_id,type,amount,source_id,provenance,status)
    VALUES ('unposted-${suffix}',$1,1,'TYPE1','MAGAZIN',1,'unposted','fixture','PENDING')`, [company]), /check constraint/);
  console.log(`worker adjustment types ${suffix}: zero preserved; unsupported type rejected`);
}
async function verifyManualPayrollRead(db, suffix) {
  const company = `hisob_test_payroll_${suffix}`;
  const ticket = `00000000-0000-4000-8000-0000000000${suffix === 'fresh' ? 'a1' : 'a2'}`;
  await db.query(`INSERT INTO models(id,company_id,name,operations_json) VALUES ('pay-model',$1,'Payroll fixture',$2)`,
    [company, JSON.stringify([{ name: 'Sew', rate: 50000 }])]);
  await db.query(`INSERT INTO workers(id,company_id,name,staj) VALUES (7,$1,'Payroll worker',25000)`, [company]);
  await db.query(`INSERT INTO periods(id,company_id,start_date,name,is_closed) VALUES ('PAY1',$1,'2026-10-01','Payroll period',0)`, [company]);
  await db.query(`INSERT INTO parties(id,company_id,party_number,physical_party_number,model_id)
    VALUES ('pay-party',$1,'1','1','pay-model')`, [company]);
  await db.query(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,party_record_id,patta_number,qty,submitted_at)
    VALUES ($1,$2,'pay-model','PAY1','1','pay-party',1,10,'2026-10-10T12:00:00Z')`, [ticket, company]);
  await db.query(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,rate_snapshot,qty)
    VALUES ('pay-entry',$1,$2,'Sew',7,50000,10)`, [ticket, company]);
  await db.query(`INSERT INTO worker_adjustments(id,company_id,worker_id,period_id,type,amount,source_id,provenance,status)
    VALUES ('pay-oklad',$1,7,'PAY1','OKLAD',2000000,'pay-oklad','fixture','POSTED'),
      ('pay-magazin',$1,7,'PAY1','MAGAZIN',100000,'pay-magazin','fixture','POSTED'),
      ('pay-avans',$1,7,'PAY1','AVANS',200000,'pay-avans','fixture','POSTED'),
      ('pay-jarima',$1,7,'PAY1','JARIMA',50000,'pay-jarima','fixture','POSTED')`, [company]);
  const result = await loadPayroll(db, company, 'PAY1');
  assert.deepEqual(Object.fromEntries(['pieceworkGross','oklad','magazin','avans','jarima','staj','gross','net','pieces']
    .map(key => [key, Number(result.workers[0][key])])), {
    pieceworkGross: 500000, oklad: 2000000, magazin: 100000,
    avans: 200000, jarima: 50000, staj: 25000, gross: 2500000, net: 2125000, pieces: 10
  });
  assert.equal(Number(result.workers[0].models_breakdown['pay-model'].operations[0].amount), 500000);
  const archiveSource = await readPeriodArchiveSource(db, company, {
    id: 'PAY1', name: 'Payroll period', start_date: '2026-10-01', end_date: '2026-10-31'
  });
  assert.deepEqual(archiveSource.workers[0], {
    id: 7, name: 'Payroll worker', staj: 25000, role: undefined,
    avans: 200000, jarima: 50000, oklad: 2000000, magazin: 100000
  });
  console.log(`actual PostgreSQL archive source ${suffix}: worker Oklad/Magazin retained with existing deductions`);
  console.log(`actual PostgreSQL payroll reader ${suffix}: 500000 + 2000000 - 100000 - 200000 - 50000 - 25000 = 2125000`);
}
async function verifyWorkerCommandDurability(db, fixtureUrl, suffix) {
  const company = `hisob_test_worker_sync_${suffix}`;
  const ticket = `00000000-0000-4000-8000-0000000000${suffix === 'fresh' ? 'b1' : 'b2'}`;
  await db.query(`INSERT INTO models(id,company_id,name,operations_json) VALUES ('sync-model',$1,'Sync fixture',$2)`,
    [company, JSON.stringify([{ name: 'Sew', rate: 50000 }])]);
  await db.query(`INSERT INTO workers(id,company_id,name,staj,status) VALUES (7,$1,'Sync worker',25000,'ACTIVE')`, [company]);
  await db.query(`INSERT INTO periods(id,company_id,start_date,name,is_closed) VALUES ('PAY1',$1,'2026-10-01','Sync period',0)`, [company]);
  await db.query(`INSERT INTO parties(id,company_id,party_number,physical_party_number,model_id)
    VALUES ('sync-party',$1,'1','1','sync-model')`, [company]);
  await db.query(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,party_record_id,patta_number,qty,submitted_at)
    VALUES ($1,$2,'sync-model','PAY1','1','sync-party',1,10,'2026-10-10T12:00:00Z')`, [ticket, company]);
  await db.query(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,rate_snapshot,qty)
    VALUES ('sync-entry',$1,$2,'Sew',7,50000,10)`, [ticket, company]);
  const guardedPool = { connect: async () => ({ query: db.query.bind(db), release: () => {} }) };
  const bootstrap = await withCompanyBootstrapSnapshot(guardedPool, company);
  const initialResponse = { success: true, ...bootstrap, feedBaseline: {
    protocolVersion: 1, companyId: company, headCursor: bootstrap.cursor
  } };
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hisob-money-1b-'));
  const req = { auth: { companyId: company, deviceId: 'fixture-device', clientVersion: '1.0.0' } };
  let localDb;
  let secondaryClients = [];
  try {
    localDb = databaseManager.getCompanyDatabase(userData, company);
    applyBootstrapSnapshot(localDb, company, initialResponse);
    const base = [
      ['10000000-0000-4000-8000-000000000001', 'AVANS', 200000],
      ['10000000-0000-4000-8000-000000000002', 'JARIMA', 50000],
      ['10000000-0000-4000-8000-000000000003', 'OKLAD', 2000000],
      ['10000000-0000-4000-8000-000000000004', 'MAGAZIN', 100000]
    ];
    const command = {
      commandType: 'UpsertWorker', commandId: 'money-1b-worker-command', operationId: '20000000-0000-4000-8000-000000000001',
      companyId: company, entityId: '7', baseRevision: 1,
      payload: { workerId: 7, name: 'Sync worker', staj: 25000, role: null, status: 'ACTIVE',
        balanceAdjustments: base.map(([adjustmentId, type, amountDelta]) => ({ adjustmentId, type, amountDelta, periodId: 'PAY1' })) }
    };
    assert.equal(executeWorkbookCommand(userData, company, command).committed, true);
    let local = loadPayrollValuationFromSqlite(localDb, company, 'PAY1').workers[0];
    console.log('offline SQLite worker payroll checkpoint', JSON.stringify({ gross: local.gross, net: local.net,
      accountingStatus: local.accountingStatus, syncStatus: local.syncStatus, reasons: local.accountingReasons }));
    assert.deepEqual({ pieceworkGross: local.pieceworkGross, gross: local.gross, net: local.net,
      accountingStatus: local.accountingStatus, syncStatus: local.syncStatus },
    { pieceworkGross: 500000, gross: 2500000, net: 2125000, accountingStatus: 'INCOMPLETE', syncStatus: 'UNSYNCED' });

    const serverPool = { connect: async () => ({ query: db.query.bind(db), release: () => {} }) };
    let loseFirstReply = true;
    const syncClient = { pushOperations: async (operations) => {
      const results = [];
      for (const operation of operations) results.push(await processSingleOperation(serverPool, req, operation));
      if (loseFirstReply) { loseFirstReply = false; throw new Error('synthetic lost acknowledgement'); }
      return { success: true, results };
    } };
    const lost = await dispatchOutbox(localDb, company, syncClient, { baseUserDataPath: userData });
    assert.equal(lost.transientErrors, 1);
    assert.equal(localDb.prepare("SELECT status FROM local_outbox WHERE operation_id=?").get(command.operationId).status, 'PENDING');
    const savedPayload = localDb.prepare("SELECT payload_json,payload_hash FROM local_outbox WHERE operation_id=?").get(command.operationId);
    databaseManager.closeAllCompanyDatabases();
    localDb = databaseManager.getCompanyDatabase(userData, company);
    const replay = await dispatchOutbox(localDb, company, syncClient, { baseUserDataPath: userData });
    assert.equal(replay.synced, 1);
    const ack = localDb.prepare(`SELECT status,payload_json,payload_hash,accepted_payload_hash,
      accepted_server_revision,accepted_change_id FROM local_outbox WHERE operation_id=?`).get(command.operationId);
    assert.deepEqual(ack, { status: 'SYNCED', ...savedPayload, accepted_payload_hash: savedPayload.payload_hash,
      accepted_server_revision: 2, accepted_change_id: expectCursor(ack.accepted_change_id) });
    const afterAck = loadPayrollValuationFromSqlite(localDb, company, 'PAY1').workers[0];
    assert.equal(afterAck.net, 2125000);
    assert.equal(afterAck.syncStatus, 'UNKNOWN'); // ACK cursor is newer than the applied feed cursor.
    assert.equal(afterAck.accountingStatus, 'INCOMPLETE');
    const serverPayroll = await loadPayroll(db, company, 'PAY1');
    assert.deepEqual(Object.fromEntries(['pieceworkGross','oklad','magazin','avans','jarima','staj','gross','net','pieces']
      .map(key => [key, Number(serverPayroll.workers[0][key])])), {
      pieceworkGross: 500000, oklad: 2000000, magazin: 100000, avans: 200000,
      jarima: 50000, staj: 25000, gross: 2500000, net: 2125000, pieces: 10
    });
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM worker_adjustments WHERE company_id=$1`, [company])).rows[0].n, 4);
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM operations_dedup WHERE company_id=$1 AND operation_id=$2`,
      [company, command.operationId])).rows[0].n, 1);

    const pageRows = await db.query(`SELECT change_id,company_id,entity_type,entity_id,entity_revision,operation_id,
      change_type,payload_json,committed_at FROM change_log WHERE company_id=$1 AND operation_id=$2 ORDER BY change_id`,
      [company, command.operationId]);
    assert.equal(pageRows.rows.length, 1);
    const items = pageRows.rows.map(row => ({ changeId: String(row.change_id), companyId: row.company_id,
      entityType: row.entity_type, entityId: row.entity_id, entityRevision: Number(row.entity_revision),
      operationId: row.operation_id, changeType: row.change_type,
      payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json,
      committedAt: row.committed_at instanceof Date ? row.committed_at.toISOString() : String(row.committed_at) }));
    const head = (await db.query('SELECT COALESCE(MAX(change_id),0)::text AS cursor FROM change_log WHERE company_id=$1', [company])).rows[0].cursor;
    const fromCursor = getLocalCursor(localDb);
    const feedResponse = { feedProtocolVersion: 1, companyId: company, fromCursor, headCursor: head,
      nextCursor: head, hasMore: false, items };
    console.log('feed acceptance fixture', JSON.stringify({ operationId: items[0].operationId, changeId: items[0].changeId,
      adjustmentCount: items[0].payload.balanceAdjustments?.length,
      local: JSON.parse(localDb.prepare('SELECT payload_json FROM local_outbox WHERE operation_id=?')
        .get(command.operationId).payload_json).balanceAdjustments }));
    // Simulate an older server's ACK without durable receipt fields; the exact
    // matching company/worker/adjustment change proves acceptance on feed apply.
    localDb.prepare(`UPDATE local_outbox SET accepted_payload_hash=NULL, accepted_server_revision=NULL,
      accepted_change_id=NULL WHERE company_id=? AND operation_id=?`).run(company, command.operationId);
    applyChangesBatch(localDb, company, items, head, { feedResponse });
    const afterFeed = loadPayrollValuationFromSqlite(localDb, company, 'PAY1').workers[0];
    console.log('SQLite worker payroll after actual feed application', JSON.stringify({ gross: afterFeed.gross, net: afterFeed.net,
      accountingStatus: afterFeed.accountingStatus, syncStatus: afterFeed.syncStatus, reasons: afterFeed.accountingReasons,
      acceptance: localDb.prepare('SELECT accepted_server_revision,accepted_change_id FROM local_outbox WHERE operation_id=?')
        .get(command.operationId) }));
    assert.deepEqual({ gross: afterFeed.gross, net: afterFeed.net, syncStatus: afterFeed.syncStatus,
      accountingStatus: afterFeed.accountingStatus },
    { gross: 2500000, net: 2125000, syncStatus: 'CURRENT', accountingStatus: 'COMPLETE' });
    assert.equal(localDb.prepare('SELECT accepted_change_id FROM local_outbox WHERE company_id=? AND operation_id=?')
      .get(company, command.operationId).accepted_change_id, head);
    // A duplicate change delivery is idempotent at the fact boundary.
    const { applyWorkerChange } = require('../../apps/desktop/electron/sync/changeFeedApplier.cjs');
    applyWorkerChange(localDb, company, '7', 'UPDATE', items[0].payload, items[0].entityRevision);
    assert.equal(localDb.prepare('SELECT COUNT(*) AS n FROM worker_adjustments WHERE company_id=?').get(company).n, 4);

    const latestBootstrap = await withCompanyBootstrapSnapshot(guardedPool, company);
    const bootstrapData = fs.mkdtempSync(path.join(os.tmpdir(), 'hisob-money-1b-bootstrap-latest-'));
    try {
      databaseManager.closeAllCompanyDatabases();
      const freshLocal = databaseManager.getCompanyDatabase(bootstrapData, company);
      applyBootstrapSnapshot(freshLocal, company, { success: true, ...latestBootstrap,
        feedBaseline: { protocolVersion: 1, companyId: company, headCursor: latestBootstrap.cursor } });
      const bootstrapped = readWorkbookPayrollProjection(freshLocal, company).payrollValuation.workers[0];
      assert.deepEqual({ gross: bootstrapped.gross, net: bootstrapped.net, accountingStatus: bootstrapped.accountingStatus },
        { gross: 2500000, net: 2125000, accountingStatus: 'COMPLETE' });
    } finally {
      databaseManager.closeAllCompanyDatabases();
      fs.rmSync(bootstrapData, { recursive: true, force: true });
    }

    // A failed operation after the worker row/facts/change were staged must roll back as one PG transaction.
    const failurePayload = { commandId: 'failure-cmd', operationId: '30000000-0000-4000-8000-000000000001',
      companyId: company, workerId: 7, name: 'Must roll back', staj: 25000, role: null, status: 'ACTIVE',
      balanceAdjustments: [{ adjustmentId: '10000000-0000-4000-8000-000000000005', type: 'OKLAD', amountDelta: 1, periodId: 'PAY1' }] };
    const failureOp = { operationId: failurePayload.operationId, companyId: company, commandType: 'UpsertWorker',
      entityType: 'worker', entityId: '7', baseRevision: 2, payload: failurePayload,
      payloadHash: computePayloadHash(canonicalStringify(failurePayload)) };
    await assert.rejects(processSingleOperation(serverPool, req, failureOp, { testHookBeforeCommit: () => { throw new Error('synthetic rollback'); } }), /synthetic rollback/);
    assert.equal((await db.query('SELECT name,server_revision FROM workers WHERE company_id=$1 AND id=7', [company])).rows[0].name, 'Sync worker');
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM worker_adjustments WHERE company_id=$1', [company])).rows[0].n, 4);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM operations_dedup WHERE company_id=$1 AND operation_id=$2',
      [company, failurePayload.operationId])).rows[0].n, 0);

    const wrongCompany = 'hisob_test_other_company';
    const wrongPayload = { commandId: 'wrong-company-cmd', operationId: '60000000-0000-4000-8000-000000000001',
      companyId: wrongCompany, workerId: 7, name: 'Wrong scope', staj: 25000, role: null, status: 'ACTIVE', balanceAdjustments: [] };
    const wrongScope = await processSingleOperation(serverPool, req, { operationId: wrongPayload.operationId,
      companyId: wrongCompany, commandType: 'UpsertWorker', entityType: 'worker', entityId: '7', baseRevision: 2,
      payload: wrongPayload, payloadHash: computePayloadHash(canonicalStringify(wrongPayload)) });
    assert.deepEqual({ status: wrongScope.status, code: wrongScope.error?.code },
      { status: 'REJECTED', code: 'COMPANY_SCOPE_MISMATCH' });
    assert.equal((await db.query('SELECT name,server_revision FROM workers WHERE company_id=$1 AND id=7', [company])).rows[0].name, 'Sync worker');

    // Concurrent stale base revisions have exactly one successful CAS winner.
    const clientA = new Client({ connectionString: fixtureUrl });
    const clientB = new Client({ connectionString: fixtureUrl });
    secondaryClients = [clientA, clientB];
    await Promise.all(secondaryClients.map(client => client.connect()));
    const opFor = (operationId, name) => {
      const payload = { commandId: `${operationId}-cmd`, operationId, companyId: company, workerId: 7,
        name, staj: 25000, role: null, status: 'ACTIVE', balanceAdjustments: [] };
      return { operationId, companyId: company, commandType: 'UpsertWorker', entityType: 'worker', entityId: '7',
        baseRevision: 2, payload, payloadHash: computePayloadHash(canonicalStringify(payload)) };
    };
    const race = await Promise.all([
      processSingleOperation({ connect: async () => ({ query: clientA.query.bind(clientA), release: () => {} }) }, req,
        opFor('40000000-0000-4000-8000-000000000001', 'Race A')),
      processSingleOperation({ connect: async () => ({ query: clientB.query.bind(clientB), release: () => {} }) }, req,
        opFor('40000000-0000-4000-8000-000000000002', 'Race B'))
    ]);
    assert.deepEqual(race.map(result => result.status).sort(), ['APPLIED', 'CONFLICT']);
    await Promise.all(secondaryClients.map(client => client.end())); secondaryClients = [];
    const closedRevision = Number((await db.query('SELECT server_revision FROM workers WHERE company_id=$1 AND id=7', [company])).rows[0].server_revision);
    await db.query("UPDATE periods SET is_closed=1,status='CLOSED' WHERE company_id=$1 AND id='PAY1'", [company]);
    const closedPayload = { commandId: 'closed-cmd', operationId: '50000000-0000-4000-8000-000000000001',
      companyId: company, workerId: 7, name: 'Sync worker', staj: 25000, role: null, status: 'ACTIVE',
      balanceAdjustments: [{ adjustmentId: '10000000-0000-4000-8000-000000000006', type: 'MAGAZIN', amountDelta: 10, periodId: 'PAY1' }] };
    const closed = await processSingleOperation(serverPool, req, { operationId: closedPayload.operationId, companyId: company,
      commandType: 'UpsertWorker', entityType: 'worker', entityId: '7', baseRevision: closedRevision,
      payload: closedPayload, payloadHash: computePayloadHash(canonicalStringify(closedPayload)) });
    assert.deepEqual({ status: closed.status, code: closed.error?.code }, { status: 'REJECTED', code: 'PERIOD_CLOSED' });
    assert.equal((await db.query('SELECT server_revision FROM workers WHERE company_id=$1 AND id=7', [company])).rows[0].server_revision, closedRevision);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM worker_adjustments WHERE company_id=$1', [company])).rows[0].n, 4);
    console.log(`actual SQLite restart/lost-ACK replay, guarded PG CAS/rollback, feed/bootstrap readback ${suffix}: 2500000/2125000`);
  } finally {
    if (secondaryClients.length) await Promise.all(secondaryClients.map(client => client.end().catch(() => {})));
    databaseManager.closeAllCompanyDatabases();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}
function expectCursor(value) {
  assert.match(String(value), /^\d+$/);
  return String(value);
}
async function main() {
  assert(!process.env.DATABASE_URL && !process.env.NOVDA_PG_URL && !process.env.NOVDA_LOCAL_TEST_PG_URL,
    'ambient database URLs forbidden');
  try {
    assert.equal(docker(['inspect','--format','{{.Id}}',container]), identity);
    assert.equal(docker(['inspect','--format','{{.State.Status}}',container]), 'running');
    const binding = docker(['port',container,'5432/tcp']);
    assert.match(binding, /^127\.0\.0\.1:\d+$/);
    const port = binding.split(':')[1];
    // Guard precedes *any* PostgreSQL socket, including local Unix socket provisioning.
    process.env.NOVDA_LOCAL_TEST_PG_URL = `postgresql://${ownRole}:${password}@127.0.0.1:${port}/${ownRole}`;
    const guarded = spawnSync(process.execPath, [path.join(root,'.opencode/deep-audit/output/local-test-db/assert-local-pg.cjs')], {
      env: { NOVDA_LOCAL_TEST_PG_URL: process.env.NOVDA_LOCAL_TEST_PG_URL }, encoding:'utf8'
    });
    assert.equal(guarded.status, 0, 'local PG guard failed');
    // Only the documented initial role in the exact owned container; never modify existing databases.
    socketSql(`CREATE ROLE ${ownRole} LOGIN PASSWORD '${password}';\n`);
    for (const suffix of ['', '_old']) socketSql(`CREATE DATABASE ${ownRole}${suffix} OWNER ${ownRole};\n`);
    await withDb(ownRole, async (db, fixtureUrl) => {
      await applyMigrations(db);
      await versions(db, MIGRATIONS.length);
      await applyMigrations(db);
      await versions(db, MIGRATIONS.length);
      await assertManualPayrollTypeCompatibility(db, 'fresh');
      await verifyManualPayrollRead(db, 'fresh');
      await verifyWorkerCommandDurability(db, fixtureUrl, 'fresh');
      console.log(`fresh schema: ${MIGRATIONS.length} contiguous migrations, rerun unchanged`);
    });
    let retained;
    await withDb(`${ownRole}_old`, async db => {
      const fake = { query: (sql, params) => db.query(sql, params) };
      // Stop at v22 using the real runner with a synthetic interruption at the v23 lookup.
      await assert.rejects(applyMigrations({ query: (sql, params) => {
        if (sql === 'SELECT name FROM schema_migrations WHERE version = $1' && params[0] === 23)
          throw new Error('synthetic pause before v23');
        return fake.query(sql, params);
      } }), /synthetic pause/);
      await versions(db, 22);
      const { ticket,hash } = await seed(db);
      const before = await facts(db);
      assert.equal(Number(before.ticket[0].qty) + Number(before.correction[0].qty), 10);
      assert.equal((Number(before.ticket[0].qty) + Number(before.correction[0].qty)) * before.archive[0].archive_json.models[0].operations[0].rate, 70);
      assert.equal(before.entry[0].rate, '5');
      assert.equal(before.archive[0].sha256, hash);
      assert.equal(before.archive[0].sha256, computePayloadHash(canonicalStringify(before.archive[0].archive_json)));
      assert.equal(before.audit[0].synchronized_device_count, 3);
      // Fault after the actual v23 DDL through the production runner, inside its transaction.
      const v23 = fs.readFileSync(path.join(migrations, MIGRATIONS[22]), 'utf8');
      await assert.rejects(applyMigrations(db, { readFile: file => file.endsWith(MIGRATIONS[22])
        ? v23.replace(/COMMIT;\s*$/, 'SELECT 1/0;\nCOMMIT;') : fs.readFileSync(file, 'utf8') }), /division by zero/);
      await db.query('ROLLBACK');
      await versions(db, 22);
      assert.equal((await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='production_adjustments' AND column_name='attribution_status'")).rowCount, 0);
      assert.deepEqual(await facts(db), before);
      await applyMigrations(db);
      await versions(db, MIGRATIONS.length);
      await assertManualPayrollTypeCompatibility(db, 'upgrade');
      await verifyManualPayrollRead(db, 'upgrade');
      assert.deepEqual(await facts(db), before);
      assert.deepEqual((await db.query("SELECT original_ticket_id,original_period_id,attribution_status FROM production_adjustments WHERE company_id='hisob_test_9a'")).rows,
        [{ original_ticket_id: null, original_period_id: null, attribution_status: 'UNRESOLVED' }]);
      const badCount = await db.query("SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conrelid='activation_policy_events'::regclass AND conname='activation_policy_events_sync_count_check'");
      assert.equal(badCount.rows[0].n, 1);
      await assert.rejects(db.query(`INSERT INTO activation_policy_events(company_id,actor_telegram_id,previous_require_ticket_validation,require_ticket_validation,policy_revision,synchronized_device_count)
        VALUES ('hisob_test_9a','1',TRUE,FALSE,3,-1)`), /check constraint/);
      await applyMigrations(db);
      assert.deepEqual(await facts(db), before);
      await versions(db, MIGRATIONS.length);
      retained = before;
      console.log(`older schema: v22 -> v${MIGRATIONS.length}; fault rollback, strict count, idempotency, all facts preserved`);
    });
    await withDb(`${ownRole}_old`, async db => {
      await versions(db, MIGRATIONS.length);
      assert.deepEqual(await facts(db), retained);
      console.log('reconnected older schema: identical financial/audit/dedup facts');
    });
  } finally {
    // Stop only the named, documented owned container; no other Docker resources.
    if (docker(['inspect','--format','{{.Id}}',container]) === identity) docker(['stop',container]);
  }
}
main().catch(error => { console.error(error.stack?.split('\n').slice(0, 5).join('\n') || error.code || error.message); process.exitCode = 1; });
