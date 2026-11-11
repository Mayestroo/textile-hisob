'use strict';
// Actual PostgreSQL -> production worker route/admin payroll service -> loopback browser runners.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const Fastify = require('fastify');
const { Pool } = require('pg');
const { registerWorkerRoutes, signableWorkerRequest } = require('../../../apps/server/modules/workers/workerRoutes.cjs');
const { createAdminDashboardService } = require('../../../apps/server/modules/admin/adminDashboard.cjs');
const manager = require('../../../apps/desktop/electron/database/core/databaseManager.cjs');
const { loadPayrollValuationFromSqlite } = require('../../../apps/desktop/electron/database/readers/payrollReader.cjs');
const { canonicalStringify, computePayloadHash } = require('../../../apps/desktop/electron/database/core/canonicalPayload.cjs');

const root = path.resolve(__dirname, '../../..');
const fixtureDb = process.env.MONEY_1D_FIXTURE_DB;
const tenant = 'hisob_test_money_1d';
const noPeriodCompany = 'hisob_test_money_no_period';
const workerId = 731;
const zeroWorkerId = 732;
const unknownWorkerId = 733;
const activePeriod = 'M2';
const closedPeriod = 'P';
const telegramId = '123456789';
const workerTelegramIds = new Map([[workerId,'123456789'],[zeroWorkerId,'123456780'],[unknownWorkerId,'123456781']]);
const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;
const hmac = crypto.randomBytes(32).toString('hex');
const apiToken = crypto.randomBytes(32).toString('hex');
const admin = { company: 'fixture-company', global: 'fixture-global' };
const screenshots = path.join(root, '.opencode/deep-audit/output/post-redesign-money-1d-pg-screenshots');
fs.mkdirSync(screenshots, { recursive: true });
const guard = spawnSync(process.execPath, [path.join(__dirname, 'assert-local-pg.cjs')],
  { encoding: 'utf8', env: { NOVDA_LOCAL_TEST_PG_URL: process.env.NOVDA_LOCAL_TEST_PG_URL } });
assert.equal(guard.status, 0, 'explicit local PG guard must pass before PG Pool construction');
assert(fixtureDb && new URL(process.env.NOVDA_LOCAL_TEST_PG_URL).pathname === `/${fixtureDb}`);
assert(!process.env.DATABASE_URL && !process.env.NOVDA_PG_URL, 'ambient database URLs forbidden');
const pool = new Pool({ connectionString: process.env.NOVDA_LOCAL_TEST_PG_URL, max: 3 });
const app = Fastify({ logger: false });
const dashboard = createAdminDashboardService({ pool });
const workerWebAppPath = path.join(root, 'apps/webapps/worker/index.html');
app.addHook('onSend', async (request, reply, payload) => {
  if (request.url.startsWith('/worker-app') && typeof payload === 'string') {
    return payload.replace(/\s*<script src="https:\/\/telegram\.org\/js\/telegram-web-app\.js"><\/script>/,
      `<script>window.Telegram={WebApp:{ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},initDataUnsafe:{user:{id:${telegramId}}},HapticFeedback:{impactOccurred(){},notificationOccurred(){}}}};</script>`);
  }
  return payload;
});
registerWorkerRoutes(app, { pool, workerApiToken: apiToken, workerAuthHmacSecret: hmac, workerWebAppPath });
app.get('/fixture/admin/payroll', async (request, reply) => {
  const scope = request.headers['x-fixture-admin-scope'];
  if (!['company', 'global'].includes(scope)) return reply.code(401).send({ error: 'SESSION_REQUIRED' });
  if (scope === 'company' && request.query.companyId !== tenant) return reply.code(403).send({ error: 'COMPANY_SCOPE_REQUIRED' });
  if (request.method !== 'GET') return reply.code(405).send({ error: 'READ_ONLY' });
  return dashboard.getPayroll({ companyId: request.query.companyId, periodId: request.query.periodId });
});
app.get('/fixture/admin/workers', async (request, reply) => {
  if (!['company', 'global'].includes(request.headers['x-fixture-admin-scope'])) return reply.code(401).send({ error: 'SESSION_REQUIRED' });
  if (request.headers['x-fixture-admin-scope'] === 'company' && request.query.companyId !== tenant) return reply.code(403).send({ error: 'COMPANY_SCOPE_REQUIRED' });
  return dashboard.listWorkers({ companyId: request.query.companyId, limit: 100 });
});

function queryClient(sql) { return pool.query(sql); }
async function setupPg() {
  await queryClient(fs.readFileSync(path.join(root, 'apps/server/database/schema.sql'), 'utf8'));
  for (const name of ['deploy_activation_migration.sql', 'deploy_business_mutations_migration.sql',
    'deploy_worker_adjustment_manual_payroll_types.sql', 'deploy_production_adjustment_provenance_migration.sql',
    'deploy_production_adjustment_attribution_migration.sql']) {
    await queryClient(fs.readFileSync(path.join(root, 'apps/server/database/migrations', name), 'utf8'));
  }
  await pool.query(`INSERT INTO models(id,company_id,name,operations_json) VALUES($1,$2,$3,$4::jsonb)`,
    ['m', tenant, 'Synthetic model', JSON.stringify([
      { name: 'Sew', rate: 50000 }, { name: 'Zero', rate: 0 }, { name: 'Unknown operation', rate: null }
    ])]);
  await pool.query(`INSERT INTO workers(id,company_id,name,staj) VALUES
    ($1,$2,'Synthetic Worker 731',25000),($3,$2,'Synthetic Worker 732',0),($4,$2,'Synthetic Worker 733',1)`,
  [workerId, tenant, zeroWorkerId, unknownWorkerId]);
  await pool.query(`INSERT INTO workers(id,company_id,name,staj) VALUES(731,$1,'No Period Worker',0)`, [noPeriodCompany]);
  for (const [id,tg] of workerTelegramIds) await pool.query(`INSERT INTO worker_telegram_bindings(telegram_id,company_id,worker_id,username) VALUES($1,$2,$3,'fixture')`,
    [tg,tenant,id]);
  await pool.query(`INSERT INTO periods(id,company_id,name,start_date,end_date,is_closed) VALUES
    ('P',$1,'Original period P','2026-09-01','2026-09-30',1),('M2',$1,'Synthetic period P','2026-11-01',NULL,0)`, [tenant]);
  await pool.query(`INSERT INTO parties(id,company_id,party_number,physical_party_number,model_id)
    VALUES('party',$1,'1','1','m')`, [tenant]);
  async function ticket(id, periodId, op, quantity, worker = workerId, partyNumber = 'TEST-PARTY-4101') {
    await pool.query(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,party_record_id,patta_number,qty,status,submitted_at)
      VALUES($1,$2,'m',$3,$4,'party',$5,$6,'CONFIRMED',$7)`,
    [id, tenant, periodId, partyNumber, quantity, quantity, periodId === 'P' ? '2026-09-15T10:00:00Z' : '2026-11-06T10:00:00Z']);
    await pool.query(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,rate_snapshot,qty)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [`entry-${id}`, id, tenant, op, worker, op === 'Sew' ? 50000 : op === 'Zero' ? 0 : null, quantity]);
  }
  await ticket('00000000-0000-4000-8000-000000000731', 'M2', 'Sew', 10, workerId, 'TEST-PARTY-4101');
  await ticket('00000000-0000-4000-8000-000000000732', 'M2', 'Unknown operation', 1, workerId, 'TEST-PARTY-5202');
  await ticket('00000000-0000-4000-8000-000000000733', 'M2', 'Zero', 4, workerId, 'TEST-PARTY-6303');
  await ticket('00000000-0000-4000-8000-000000000734', 'M2', 'Zero', 4, zeroWorkerId);
  await ticket('00000000-0000-4000-8000-000000000735', 'M2', 'Unknown operation', 3, unknownWorkerId);
  await ticket('00000000-0000-4000-8000-000000000736', 'P', 'Sew', 10);
  const facts = [
    ['p-oklad','P','OKLAD',1100000],['p-shop','P','MAGAZIN',50000],['p-avans','P','AVANS',100000],['p-fine','P','JARIMA',10000],
    ['m-oklad','M2','OKLAD',2000000],['m-shop','M2','MAGAZIN',100000],['m-avans','M2','AVANS',200000],['m-fine','M2','JARIMA',50000]
  ];
  for (const [id, periodId, type, amount] of facts) await pool.query(`INSERT INTO worker_adjustments
    (id,company_id,worker_id,period_id,type,amount,source_id,provenance,status)
    VALUES($1,$2,$3,$4,$5,$6,$1,'REMOTE_SYNC','POSTED')`, [id, tenant, workerId, periodId, type, amount]);
  await pool.query(`INSERT INTO production_adjustments(adjustment_id,company_id,model_id,worker_id,op_name,delta_qty,reason,status,created_by,original_period_id,attribution_status)
    VALUES('unresolved',$1,'m',$2,'Unknown operation',1,'fixture','APPROVED','fixture',NULL,'UNRESOLVED')`, [tenant, workerId]);
  const archive = { period: { id: 'P', companyId: tenant, name: 'Original period P' },
    models: [{ id: 'm', operations: [{ name: 'Sew', rate: 40000 }, { name: 'Zero', rate: 0 }, { name: 'Unknown operation', rate: null }] }],
    workers: [{ id: workerId, name: 'Synthetic Worker 731', staj: 25000 }] };
  await pool.query(`INSERT INTO period_archives(company_id,period_id,archive_json,sha256) VALUES($1,'P',$2::jsonb,$3)`,
    [tenant, JSON.stringify(archive), computePayloadHash(canonicalStringify(archive))]);
}

function signedWorkerToken(companyId, id, tg, expiry) {
  return crypto.createHmac('sha256', hmac).update(signableWorkerRequest({ companyId, workerId: String(id), telegramId: tg, expiresAt: expiry }), 'utf8').digest('hex');
}
async function actualWorkerProfile(id = workerId, periodId = activePeriod, tg = workerTelegramIds.get(id)) {
  const token = signedWorkerToken(tenant, id, tg, expiresAt);
  const url = `http://127.0.0.1:${app.server.address().port}/api/worker/profile?companyId=${tenant}&workerId=${id}&telegramId=${tg}&expiresAt=${expiresAt}${periodId ? `&periodId=${periodId}` : ''}`;
  return fetch(url, { headers: { 'x-worker-auth-token': token } });
}
async function verifyHttp() {
  const currentResponse = await actualWorkerProfile();
  assert.equal(currentResponse.status, 200);
  const current = (await currentResponse.json()).profile;
  assert.deepEqual([current.pieceworkGross,current.oklad,current.gross,current.magazin,current.avans,current.jarima,current.staj,current.net],
    [500000,2000000,2500000,100000,200000,50000,25000,2125000]);
  assert.equal(current.models_breakdown.m.earnings, 500000);
  assert.equal(current.accountingStatus, 'INCOMPLETE');
  assert(current.unknownEntryCount > 0 && current.unresolvedAdjustmentCount > 0);
  const closedResponse = await actualWorkerProfile(workerId, closedPeriod);
  assert.equal(closedResponse.status, 200);
  const closed = (await closedResponse.json()).profile;
  assert.deepEqual([closed.pieceworkGross,closed.oklad,closed.gross,closed.magazin,closed.avans,closed.jarima,closed.staj,closed.net],
    [400000,1100000,1500000,50000,100000,10000,25000,1315000]);
  assert(closed.accountingReasons.includes('HISTORICAL_BASELINE_UNVERIFIED'));
  const zeroResponse = await actualWorkerProfile(zeroWorkerId, activePeriod, workerTelegramIds.get(zeroWorkerId));
  assert.equal(zeroResponse.status, 200);
  const zero = (await zeroResponse.json()).profile;
  assert.deepEqual([zero.pieceworkGross,zero.oklad,zero.gross,zero.net,zero.accountingStatus,zero.unknownEntryCount], [0,0,0,0,'COMPLETE',0]);
  const unknownResponse = await actualWorkerProfile(unknownWorkerId, activePeriod, workerTelegramIds.get(unknownWorkerId));
  assert.equal(unknownResponse.status, 200);
  const unknown = (await unknownResponse.json()).profile;
  assert.equal(unknown.unknownEntryCount, 1);
  assert.equal(unknown.accountingStatus, 'INCOMPLETE');
  const unscoped = await fetch(`http://127.0.0.1:${app.server.address().port}/api/worker/profile?companyId=${tenant}&workerId=${zeroWorkerId}&telegramId=${telegramId}&expiresAt=${expiresAt}`,
    { headers: { 'x-worker-auth-token': signedWorkerToken(tenant, zeroWorkerId, telegramId, expiresAt) } });
  assert.equal(unscoped.status, 403, 'a different worker cannot use the bound worker profile token');
  const globalPayroll = await dashboard.getPayroll({ companyId: tenant, periodId: activePeriod });
  const globalRow = globalPayroll.workers.find(row => row.workerId === workerId);
  assert.deepEqual([globalRow.pieceworkGross,globalRow.oklad,globalRow.gross,globalRow.magazin,globalRow.avans,globalRow.jarima,globalRow.staj,globalRow.net],
    [500000,2000000,2500000,100000,200000,50000,25000,2125000]);
  const noPeriodPayroll = await dashboard.getPayroll({ companyId: noPeriodCompany });
  assert.equal(noPeriodPayroll.period, null);
  assert.equal(noPeriodPayroll.accountingStatus, 'UNAVAILABLE');
  assert.equal(noPeriodPayroll.workers[0].accountingStatus, 'UNAVAILABLE');
  const unauthorized = await fetch(`http://127.0.0.1:${app.server.address().port}/fixture/admin/payroll?companyId=${tenant}&periodId=${activePeriod}`);
  assert.equal(unauthorized.status, 401);
  const denied = await fetch(`http://127.0.0.1:${app.server.address().port}/fixture/admin/payroll?companyId=hisob_test_other&periodId=${activePeriod}`,
    { headers: { 'x-fixture-admin-scope': 'company' } });
  assert.equal(denied.status, 403);
  return { current, closed, zero, unknown, noPeriod: noPeriodPayroll, adminRow: globalRow };
}

async function verifyDesktop(current, closed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hisob-money-1d-sqlite-'));
  try {
    const db = manager.getCompanyDatabase(dir, tenant);
    const now = '2026-11-06T10:00:00.000Z';
    db.prepare(`INSERT INTO models(id,company_id,name,operations_json,created_at,updated_at) VALUES('m',?,'Synthetic model',?,?,?)`)
      .run(tenant, JSON.stringify([{ name:'Sew',rate:50000 },{ name:'Zero',rate:0 },{ name:'Unknown operation',rate:null }]), now, now);
    db.prepare(`INSERT INTO workers(id,company_id,name,staj,created_at,updated_at) VALUES(731,?,'Synthetic Worker 731',25000,?,?)`).run(tenant,now,now);
    for (const [id,name,start,closedFlag] of [['M2','Synthetic period P','2026-11-01',0],['P','Original period P','2026-09-01',1]])
      db.prepare(`INSERT INTO periods(id,company_id,name,start_date,is_closed,created_at) VALUES(?,?,?,?,?,?)`).run(id,tenant,name,start,closedFlag,now);
    function addTicket(id, periodId, op, qty, rate) {
      db.prepare(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,patta_number,qty,status,submitted_at,created_at,provenance)
        VALUES(?,?,'m',?,'1',1,?,'CONFIRMED',?,?,'REMOTE_SYNC')`).run(id,tenant,periodId,qty,now,now);
      db.prepare(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,rate_snapshot,qty,created_at)
        VALUES(?,?,?, ?,731,?,?,?)`).run(`e-${id}`,id,tenant,op,rate,qty,now);
    }
    addTicket('desktop-m2','M2','Sew',10,50000); addTicket('desktop-m2-unknown','M2','Unknown operation',1,null);
    addTicket('desktop-p','P','Sew',10,40000);
    for (const row of [['m-oklad','M2','OKLAD',2000000],['m-shop','M2','MAGAZIN',100000],['m-avans','M2','AVANS',200000],['m-fine','M2','JARIMA',50000],
      ['p-oklad','P','OKLAD',1100000],['p-shop','P','MAGAZIN',50000],['p-avans','P','AVANS',100000],['p-fine','P','JARIMA',10000]])
      db.prepare(`INSERT INTO worker_adjustments(id,company_id,worker_id,period_id,type,amount,provenance,created_at,status) VALUES(?,?,731,?,?,?,'REMOTE_SYNC',?,'POSTED')`)
        .run(row[0],tenant,row[1],row[2],row[3],now);
    for (const [p,rate] of [['M2',50000],['P',40000]]) {
      const archive = { period:{ id:p,companyId:tenant },models:[{ id:'m',operations:[{name:'Sew',rate},{name:'Zero',rate:0},{name:'Unknown operation',rate:null}] }],workers:[{id:731,name:'Synthetic Worker 731',staj:25000}] };
      db.prepare(`INSERT INTO period_archives(company_id,period_id,archive_json,sha256,archived_at) VALUES(?,?,?,?,?)`)
        .run(tenant,p,JSON.stringify(archive),computePayloadHash(canonicalStringify(archive)),now);
    }
    const actual = loadPayrollValuationFromSqlite(db,tenant,activePeriod).workers.find(w=>w.workerId===workerId);
    const actualClosed = loadPayrollValuationFromSqlite(db,tenant,closedPeriod).workers.find(w=>w.workerId===workerId);
    assert.deepEqual([actual.pieceworkGross,actual.oklad,actual.gross,actual.magazin,actual.avans,actual.jarima,actual.staj,actual.net],
      [current.pieceworkGross,current.oklad,current.gross,current.magazin,current.avans,current.jarima,current.staj,current.net]);
    assert.deepEqual([actualClosed.pieceworkGross,actualClosed.oklad,actualClosed.gross,actualClosed.magazin,actualClosed.avans,actualClosed.jarima,actualClosed.staj,actualClosed.net],
      [closed.pieceworkGross,closed.oklad,closed.gross,closed.magazin,closed.avans,closed.jarima,closed.staj,closed.net]);
    return { active:actual, closed:actualClosed };
  } finally { manager.closeAllCompanyDatabases(); fs.rmSync(dir,{recursive:true,force:true}); }
}

function render(name, env) {
  return new Promise((resolve,reject)=>{
    // The Edge/render children need no database URL or PG credentials.
    const childEnv={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,APPDATA:process.env.APPDATA,
      HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'*',...env};
    const child=spawn(process.execPath,[path.join(root,`scripts/verify/render/${name}`)],
      {cwd:root,stdio:['ignore','pipe','pipe'],env:childEnv});
    let stdout='',stderr='';
    const timeout=setTimeout(()=>child.kill(),90000);
    child.stdout.on('data',chunk=>{stdout+=chunk;}); child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',error=>{clearTimeout(timeout);reject(error);});
    child.on('close',code=>{clearTimeout(timeout);if(code!==0) reject(new Error(`${name} failed: ${`${stdout}\n${stderr}`.slice(0,5000)}`));
      else {process.stdout.write(stdout);resolve();}});
  });
}
async function main() {
  try {
    await setupPg();
    await app.listen({host:'127.0.0.1',port:0});
    const base=`http://127.0.0.1:${app.server.address().port}`;
    const actual=await verifyHttp();
    const sqlite=await verifyDesktop(actual.current,actual.closed);
    const expiry=String(expiresAt);
    const token=signedWorkerToken(tenant,workerId,telegramId,expiresAt);
    const liveEnv={ MONEY_1D_API_BASE:base, MONEY_1D_COMPANY_ID:tenant, MONEY_1D_PERIOD_ID:activePeriod,
      MONEY_1D_WORKER_ID:String(workerId), MONEY_1D_WORKER_TOKEN:token, MONEY_1D_EXPIRES_AT:expiry,
      MONEY_1D_CLOSED_PERIOD_ID:closedPeriod,
      MONEY_1D_NO_PERIOD_COMPANY:noPeriodCompany,
      MONEY_1D_SCREENSHOTS:screenshots };
    await render('worker-webapp-local-render.cjs',liveEnv);
    await render('admin-webapp-local-render.cjs',liveEnv);
    const missing=await dashboard.getPayroll({companyId:tenant,periodId:'not-a-period'}).catch(error=>({error:error.code}));
    assert.equal(missing.error,'PERIOD_NOT_FOUND');
    console.log(JSON.stringify({stage:'money-1d',pgDatabase:fixtureDb,companyId:tenant,active:actual.current,closed:actual.closed,
      zero:actual.zero,unknown:actual.unknown,sqlite:{active:sqlite.active,closed:sqlite.closed},screenshots},null,2));
  } finally { await app.close().catch(()=>{}); await pool.end().catch(()=>{}); }
}
main().catch(error=>{console.error(String(error.stack||error).split('\n').slice(0,10).join('\n'));process.exitCode=1;});
