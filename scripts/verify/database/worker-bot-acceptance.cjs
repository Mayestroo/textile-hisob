'use strict';
// Standalone synthetic acceptance; requires explicit NOVDA_LOCAL_TEST_PG_URL.
// Never invokes either bot entrypoint, ambient server configuration, or real Telegram.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const Fastify = require('fastify');
const { Pool } = require('pg');
const { registerWorkerRoutes } = require('../../apps/server/modules/workers/workerRoutes.cjs');
const { registerAdminDashboardRoutes } = require('../../apps/server/modules/admin/adminDashboardRoutes.cjs');
const manager = require('../../apps/desktop/electron/database/databaseManager.cjs');
const { loadPayrollValuationFromSqlite } = require('../../apps/desktop/electron/database/payrollReader.cjs');
const { canonicalStringify, computePayloadHash } = require('../../apps/desktop/electron/database/canonicalPayload.cjs');

const root = path.resolve(__dirname, '../../..');
const guard = spawnSync(process.execPath, [path.join(root, '.opencode/deep-audit/output/local-test-db/assert-local-pg.cjs')], {
  env: { NOVDA_LOCAL_TEST_PG_URL: process.env.NOVDA_LOCAL_TEST_PG_URL }, encoding: 'utf8'
});
assert.equal(guard.status, 0, guard.stderr || 'local PG guard failed');
const url = new URL(process.env.NOVDA_LOCAL_TEST_PG_URL);
assert.match(url.pathname, /^\/hisob_test_bot8[ab][12]_[a-z]+$/);
assert(!process.env.DATABASE_URL && !process.env.NOVDA_PG_URL, 'ambient DB credentials forbidden');
const pool = new Pool({ connectionString: url.href, max: 2 });
const app = Fastify();
const token = crypto.randomBytes(24).toString('hex');
const hmac = crypto.randomBytes(32).toString('hex');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hisob-test-bot8a1-'));
const tenant = 'hisob_test_bot_a';
const other = 'hisob_test_bot_b';
const id = '123456789';
const companyAdminId = '274466315';
const globalAdminId = '1526974123';
const sqlite = manager.getCompanyDatabase(directory, tenant);
const now = '2026-10-12T12:00:00Z';
const tid = '00000000-0000-4000-8000-000000000081';
async function extraTicket(company, ticketId, operation, qty) {
  await pool.query(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,party_record_id,patta_number,qty,status,submitted_at)
    VALUES ($1,$2,'m','P','1','synthetic-party',$3,$4,'CONFIRMED',$5)`, [ticketId, company, qty, qty, now]);
  await pool.query(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,rate_snapshot,qty)
    VALUES ($1,$2,$3,$4,7,5,$5)`, [`entry-${qty}`, ticketId, company, operation, qty]);
  sqlite.prepare(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,patta_number,qty,status,submitted_at,created_at,provenance)
    VALUES (?,?,'m','P','1',?,?, 'CONFIRMED',?,?,'REMOTE_SYNC')`).run(ticketId, company, qty, qty, now, now);
  sqlite.prepare(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,rate_snapshot,qty,created_at)
    VALUES (?,?,?, ?,7,5,?,?)`).run(`entry-${qty}`, ticketId, company, operation, qty, now);
}

function bot(updates, base, staleBinding = null) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', ['-B', path.join(root, 'apps/bots/worker/test_worker_acceptance_driver.py')], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' }
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill(), 12000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timeout);
      try { assert.equal(code, 0, stderr || 'worker acceptance driver failed'); resolve(JSON.parse(stdout)); }
      catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ base, token, hmac, updates, stale_binding: staleBinding }));
  });
}
const update = (text, overrides = {}) => ({ user_id: Number(id), text, ...overrides });
const texts = (run) => run.replies.filter(r => r.method === 'sendMessage').map(r => r.payload.text);

async function main() {
  try {
    // Only the dedicated database may receive schema and synthetic facts.
    await pool.query(fs.readFileSync(path.join(root, 'apps/server/database/schema.sql'), 'utf8'));
    for (const migration of ['deploy_activation_migration.sql', 'deploy_business_mutations_migration.sql']) {
      await pool.query(fs.readFileSync(path.join(root, 'apps/server/database/migrations', migration), 'utf8'));
    }
    await pool.query(`INSERT INTO company_batch_settings(company_id) VALUES ($1),($2)`, [tenant, other]);
    for (const migration of ['deploy_activation_company_scope_migration.sql', 'deploy_production_adjustment_provenance_migration.sql',
      'deploy_production_adjustment_attribution_migration.sql', 'deploy_activation_policy_revision_migration.sql',
      'deploy_activation_policy_sync_count_migration.sql', 'deploy_company_admin_scope_migration.sql',
      'deploy_worker_telegram_unbind_migration.sql']) {
      await pool.query(fs.readFileSync(path.join(root, 'apps/server/database/migrations', migration), 'utf8'));
    }
    await pool.query(`INSERT INTO activation_companies(company_id, company_name, updated_by_telegram_id)
      VALUES ($1, 'Synthetic A', '1'), ($2, 'Synthetic B', '1') ON CONFLICT (company_id) DO UPDATE
      SET company_name=EXCLUDED.company_name, updated_by_telegram_id=EXCLUDED.updated_by_telegram_id,
          updated_by_source='TELEGRAM_ADMIN'`, [tenant, other]);
    await pool.query(`INSERT INTO activation_company_admins(company_id,telegram_id,is_active,assignment_source)
      VALUES ($1,$2,TRUE,'OWNER_BOOTSTRAP')`, [tenant, companyAdminId]);
    await pool.query(`INSERT INTO activation_requests(request_id,machine_id,request_token_hash,client_context)
      VALUES ($1,'A1B2-C3D4-E5F6-A7B8',$2,'{"source":"synthetic-8b2"}'::jsonb),
             ($3,'B1C2-D3E4-F5A6-B7C8',$4,'{"source":"synthetic-8b2"}'::jsonb),
             ($5,'C1D2-E3F4-A5B6-C7D8',$6,'{"source":"synthetic-8b2"}'::jsonb)`, [
      '00000000-0000-4000-8000-000000000101', crypto.createHash('sha256').update('synthetic-token-a').digest('hex'),
      '00000000-0000-4000-8000-000000000102', crypto.createHash('sha256').update('synthetic-token-b').digest('hex'),
      '00000000-0000-4000-8000-000000000103', crypto.createHash('sha256').update('synthetic-token-c').digest('hex')
    ]);
    await pool.query(`INSERT INTO models(id,company_id,name,operations_json) VALUES
      ('m',$1,'Synthetic model',$3::jsonb),('m',$2,'Foreign model',$4::jsonb)`,
    [tenant, other, JSON.stringify([{ name: 'Sew', rate: 9 }, { name: 'Unknown', rate: null }, { name: 'Zero', rate: 0 }]),
      JSON.stringify([{ name: 'Sew', rate: 900 }])]);
    await pool.query(`INSERT INTO workers(id,company_id,name,staj) VALUES (7,$1,'Synthetic Worker',1),(7,$2,'Foreign Worker',0)`, [tenant, other]);
    await pool.query(`INSERT INTO periods(id,company_id,name,start_date,is_closed) VALUES
      ('P',$1,'Open P','2026-10-01',0),('P',$2,'Foreign P','2026-10-01',0)`, [tenant, other]);
    await pool.query(`INSERT INTO parties(id,company_id,party_number,physical_party_number,model_id)
      VALUES ('foreign-party',$1,'1','1','m')`, [other]);
    await pool.query(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,party_record_id,patta_number,qty,status,submitted_at)
      VALUES ('00000000-0000-4000-8000-000000000091',$1,'m','P','1','foreign-party',1,10,'CONFIRMED',$2)`, [other, now]);
    await pool.query(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,rate_snapshot,qty)
      VALUES ('foreign-entry','00000000-0000-4000-8000-000000000091',$1,'Sew',7,5,10)`, [other]);
    await pool.query(`INSERT INTO worker_adjustments(id,company_id,worker_id,period_id,type,amount,source_id,provenance)
      VALUES ('foreign-av',$1,7,'P','AVANS',4,'foreign-av','REMOTE_SYNC'),('foreign-ja',$1,7,'P','JARIMA',3,'foreign-ja','REMOTE_SYNC')`, [other]);
    await pool.query(`INSERT INTO parties(id,company_id,party_number,physical_party_number,model_id)
      VALUES ('synthetic-party',$1,'1','1','m')`, [tenant]);
    await pool.query(`INSERT INTO worker_telegram_bindings(telegram_id,company_id,worker_id,username)
      VALUES ($1,$2,7,'synthetic')`, [id, tenant]);
    await pool.query(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,party_record_id,patta_number,qty,status,submitted_at)
      VALUES ($1,$2,'m','P','1','synthetic-party',1,10,'CONFIRMED',$3)`, [tid, tenant, now]);
    await pool.query(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,rate_snapshot,qty)
      VALUES ('e-sew',$1,$2,'Sew',7,5,10)`, [tid, tenant]);
    await pool.query(`INSERT INTO production_adjustments(adjustment_id,company_id,model_id,worker_id,op_name,delta_qty,reason,status,created_by,original_ticket_id,original_entry_id,original_period_id,original_rate_snapshot,attribution_status)
      VALUES ('plus',$1,'m',7,'Sew',2,'synthetic','APPROVED','fixture',$2,'e-sew','P',5,'RESOLVED'),
             ('minus',$1,'m',7,'Sew',-3,'synthetic','APPROVED','fixture',$2,'e-sew','P',5,'RESOLVED')`, [tenant, tid]);
    await pool.query(`INSERT INTO worker_adjustments(id,company_id,worker_id,period_id,type,amount,source_id,provenance)
      VALUES ('av',$1,7,'P','AVANS',4,'av','REMOTE_SYNC'),('ja',$1,7,'P','JARIMA',3,'ja','REMOTE_SYNC')`, [tenant]);

    sqlite.prepare(`INSERT INTO models(id,company_id,name,operations_json,created_at,updated_at) VALUES ('m',?,?,?,?,?)`)
      .run(tenant, 'Synthetic model', JSON.stringify([{ name: 'Sew', rate: 9 }, { name: 'Unknown', rate: null }, { name: 'Zero', rate: 0 }]), now, now);
    sqlite.prepare(`INSERT INTO workers(id,company_id,name,staj,created_at,updated_at) VALUES (7,?,?,1,?,?)`).run(tenant, 'Synthetic Worker', now, now);
    sqlite.prepare(`INSERT INTO periods(id,company_id,name,start_date,is_closed,created_at) VALUES ('P',?,'Open P','2026-10-01',0,?)`).run(tenant, now);
    sqlite.prepare(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,patta_number,qty,status,submitted_at,created_at,provenance)
      VALUES (? ,?,'m','P','1',1,10,'CONFIRMED',?,?,'REMOTE_SYNC')`).run(tid, tenant, now, now);
    sqlite.prepare(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,rate_snapshot,qty,created_at)
      VALUES ('e-sew',?,?,'Sew',7,5,10,?)`).run(tid, tenant, now);
    for (const [adjustment, qty] of [['plus', 2], ['minus', -3]]) {
      sqlite.prepare(`INSERT INTO production_adjustments(adjustment_id,company_id,model_id,worker_id,op_name,delta_qty,reason,status,provenance,created_at,created_by,original_ticket_id,original_entry_id,original_period_id,original_rate_snapshot,attribution_status)
        VALUES (?,?,'m',7,'Sew',?,'synthetic','APPROVED','REMOTE_SYNC',?,'fixture',?,'e-sew','P',5,'RESOLVED')`).run(adjustment, tenant, qty, now, tid);
    }
    for (const [name, type, amount] of [['av', 'AVANS', 4], ['ja', 'JARIMA', 3]]) {
      sqlite.prepare(`INSERT INTO worker_adjustments(id,company_id,worker_id,period_id,type,amount,provenance,created_at,status)
        VALUES (?,?,7,'P',?,?,'REMOTE_SYNC',?,'POSTED')`).run(name, tenant, type, amount, now);
    }

    registerWorkerRoutes(app, { pool, workerApiToken: token, workerAuthHmacSecret: hmac });
    const adminServiceToken = crypto.randomBytes(24).toString('hex');
    const adminSessionSecret = crypto.randomBytes(32).toString('hex');
    const activationSigner = crypto.generateKeyPairSync('ed25519');
    const activationPrivatePem = activationSigner.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const activationPublicPem = activationSigner.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    let adminHttpBase = '';
    registerAdminDashboardRoutes(app, {
      pool,
      adminApiToken: adminServiceToken,
      allowedAdminIds: new Set([globalAdminId]),
      sessionSecret: adminSessionSecret,
      publicKey: activationPublicPem,
      adminBotInternalUrl: 'http://novda-admin-bot:8080',
      fetchImpl: async (input, init) => {
        const requested = new URL(String(input));
        assert.equal(requested.origin, 'http://novda-admin-bot:8080');
        assert(['/internal/admin/webapp/session', '/internal/admin/webapp/sign-activation'].includes(requested.pathname));
        const local = new URL(requested.pathname, adminHttpBase);
        assert.equal(local.hostname, '127.0.0.1');
        return fetch(local, init);
      }
    });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const open = await bot([update('/start'), update('/operatsiyalar'), update('/pattalar')], base);
    const shown = texts(open);
    assert(shown.some(t => t.includes('81 so\'m') && t.includes('73 so\'m') && t.includes('9 dona')), JSON.stringify(shown));
    assert(shown.some(t => t.includes('9 so\'m') && t.includes('81 so\'m')), JSON.stringify(shown));
    assert(shown.some(t => t.includes('Patta #1')), JSON.stringify(shown));
    assert(open.requests.includes('/api/worker/profile') && open.requests.includes('/api/worker/tickets'));
    assert.deepEqual(loadPayrollValuationFromSqlite(sqlite, tenant, 'P').workers[0].gross, 81);
    assert.deepEqual(loadPayrollValuationFromSqlite(sqlite, tenant, 'P').workers[0].net, 73);
    await extraTicket(tenant, '00000000-0000-4000-8000-000000000082', 'Zero', 3);
    const zero = await bot([update('/hisob'), update('/operatsiyalar')], base);
    assert(texts(zero).some(t => t.includes('Sof foyda: 73 so\'m') && t.includes('12 dona')));
    assert(texts(zero).some(t => t.includes('Zero: 3 dona × 0 so\'m = <b>0 so\'m</b>')));
    assert.equal(loadPayrollValuationFromSqlite(sqlite, tenant, 'P').workers[0].unknownEntryCount, 0);
    await extraTicket(tenant, '00000000-0000-4000-8000-000000000083', 'Unknown', 2);
    const unknown = await bot([update('/hisob'), update('/operatsiyalar')], base);
    assert(texts(unknown).some(t => t.includes('Hisoblangan oraliq summa: 81 so\'m') && t.includes('Hisob to‘liq emas')));
    assert(texts(unknown).some(t => t.includes('narx noma’lum = <b>summa noma’lum</b>')));
    assert(!texts(unknown).some(t => t.includes('Sof foyda: 73 so\'m')));
    assert.equal(loadPayrollValuationFromSqlite(sqlite, tenant, 'P').workers[0].unknownEntryCount, 1);
    const link = open.replies[0].payload.reply_markup.keyboard[0][0].web_app.url;
    const signed = new URL(link);
    assert.equal(signed.hostname, '127.0.0.1');
    assert.equal(signed.searchParams.get('companyId'), tenant);
    assert.equal(signed.searchParams.get('telegramId'), id);
    const webParams = new URLSearchParams(signed.searchParams);
    webParams.set('periodId', 'P');
    const webUrl = new URL(`/api/worker/profile?${webParams}`, base);
    const webHeaders = { 'x-worker-auth-token': signed.searchParams.get('authToken') };
    assert.equal((await fetch(webUrl, { headers: webHeaders })).status, 200);
    const crossWebParams = new URLSearchParams(webParams);
    crossWebParams.set('companyId', other);
    assert.equal((await fetch(new URL(`/api/worker/profile?${crossWebParams}`, base), { headers: webHeaders })).status, 401);
    const archive = { period: { id: 'P', companyId: tenant }, models: [{ id: 'm', operations: [
      { name: 'Sew', rate: 7 }, { name: 'Unknown', rate: null }, { name: 'Zero', rate: 0 }
    ] }] };
    await pool.query(`UPDATE periods SET is_closed=1 WHERE company_id=$1 AND id='P'`, [tenant]);
    await pool.query(`INSERT INTO periods(id,company_id,name,start_date,is_closed) VALUES ('Q',$1,'Open Q','2026-11-01',0)`, [tenant]);
    sqlite.prepare(`INSERT INTO periods(id,company_id,name,start_date,is_closed,created_at) VALUES ('Q',?,'Open Q','2026-11-01',0,?)`)
      .run(tenant, now);
    const qTicket = '00000000-0000-4000-8000-000000000084';
    await pool.query(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,party_record_id,patta_number,qty,status,submitted_at)
      VALUES ($1,$2,'m','Q','1','synthetic-party',2,4,'CONFIRMED',$3)`, [qTicket, tenant, now]);
    await pool.query(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,rate_snapshot,qty)
      VALUES ('q-entry',$1,$2,'Sew',7,5,4)`, [qTicket, tenant]);
    sqlite.prepare(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,patta_number,qty,status,submitted_at,created_at,provenance)
      VALUES (? ,?,'m','Q','1',2,4,'CONFIRMED',?,?,'REMOTE_SYNC')`).run(qTicket, tenant, now, now);
    sqlite.prepare(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,rate_snapshot,qty,created_at)
      VALUES ('q-entry',?,?,'Sew',7,5,4,?)`).run(qTicket, tenant, now);
    for (const [adjustmentId, type, amount] of [['q-av', 'AVANS', 2], ['q-ja', 'JARIMA', 1]]) {
      await pool.query(`INSERT INTO worker_adjustments(id,company_id,worker_id,period_id,type,amount,source_id,provenance)
        VALUES ($1,$2,7,'Q',$3,$4,$1,'REMOTE_SYNC')`, [adjustmentId, tenant, type, amount]);
      sqlite.prepare(`INSERT INTO worker_adjustments(id,company_id,worker_id,period_id,type,amount,provenance,created_at,status)
        VALUES (?,?,7,'Q',?,?,'REMOTE_SYNC',?,'POSTED')`).run(adjustmentId, tenant, type, amount, now);
    }
    await pool.query(`INSERT INTO period_archives(company_id,period_id,archive_json,sha256)
      VALUES ($1,'P',$2::jsonb,$3)`, [tenant, JSON.stringify(archive), computePayloadHash(canonicalStringify(archive))]);
    sqlite.prepare(`UPDATE periods SET is_closed=1 WHERE company_id=? AND id='P'`).run(tenant);
    sqlite.prepare(`INSERT INTO period_archives(company_id,period_id,archive_json,sha256,archived_at)
      VALUES (?,'P',?,?,?)`).run(tenant, JSON.stringify(archive), computePayloadHash(canonicalStringify(archive)), now);
    const closedResponse = await fetch(webUrl, { headers: webHeaders });
    assert.equal(closedResponse.status, 200);
    const closed = (await closedResponse.json()).profile;
    assert.equal(closed.gross, 63);
    assert.equal(closed.net, 55);
    assert.equal(closed.pieces, 14);
    assert.equal(closed.unknownEntryCount, 1);
    assert(closed.accountingReasons.includes('HISTORICAL_BASELINE_UNVERIFIED'));
    assert.equal(loadPayrollValuationFromSqlite(sqlite, tenant, 'P').workers[0].gross, 63);
    assert.equal(loadPayrollValuationFromSqlite(sqlite, tenant, 'P').workers[0].net, 55);
    await pool.query(`DELETE FROM period_archives WHERE company_id=$1 AND period_id='P'`, [tenant]);
    sqlite.prepare(`DELETE FROM period_archives WHERE company_id=? AND period_id='P'`).run(tenant);
    const missing = (await (await fetch(webUrl, { headers: webHeaders })).json()).profile;
    const missingDesktop = loadPayrollValuationFromSqlite(sqlite, tenant, 'P').workers[0];
    assert.equal(missing.gross, 0);
    assert(missing.unknownEntryCount >= 2 && missing.accountingReasons.includes('CLOSED_TARIFF_UNAVAILABLE'));
    assert.equal(missingDesktop.gross, 0);
    assert(missingDesktop.accountingReasons.includes('CLOSED_TARIFF_UNAVAILABLE'));
    await pool.query(`INSERT INTO period_archives(company_id,period_id,archive_json,sha256)
      VALUES ($1,'P',$2::jsonb,$3)`, [tenant, JSON.stringify(archive), computePayloadHash(canonicalStringify(archive))]);
    sqlite.prepare(`INSERT INTO period_archives(company_id,period_id,archive_json,sha256,archived_at)
      VALUES (?,'P',?,?,?)`).run(tenant, JSON.stringify(archive), computePayloadHash(canonicalStringify(archive)), now);
    const group = await bot([update('/hisob', { type: 'group', chat_id: -100123 }),
      update('/hisob', { chat_id: 999 }), update('/hisob', { user_id: 999, chat_id: Number(id) })], base);
    assert.deepEqual(group, { requests: [], replies: [] });
    const foreign = await app.inject({ method: 'GET', url: `/api/worker/profile?companyId=${other}&workerId=7&telegramId=${id}`,
      headers: { 'x-novda-worker-token': token } });
    assert.equal(foreign.statusCode, 403);
    assert.equal(foreign.json().error.code, 'WORKER_BINDING_REQUIRED');
    await pool.query('DELETE FROM worker_telegram_bindings WHERE telegram_id=$1', [id]);
    const revokedWeb = await fetch(webUrl, { headers: webHeaders });
    assert.equal(revokedWeb.status, 403);
    assert.equal((await revokedWeb.json()).error.code, 'WORKER_BINDING_REQUIRED');
    const stale = await bot([update('/help'), update('/hisob')], base,
      { telegram_id: id, company_id: tenant, worker_id: 7, worker_name: 'Synthetic Worker' });
    assert(!texts(stale).some(t => t.includes('81 so\'m') || t.includes('73 so\'m')));
    assert(!JSON.stringify(stale.replies).includes('authToken'));
    assert(!stale.requests.includes('/api/worker/profile'));

    async function adminProcess(telegramId, globalMode, updates = undefined) {
      const child = spawn('python', ['-B', path.join(root, 'apps/bots/admin/test_admin_acceptance_driver.py')], {
        cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, APPDATA: process.env.APPDATA, PYTHONDONTWRITEBYTECODE: '1',
          HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' }
      });
      let stdout = '';
      let stderr = '';
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => child.kill(), 15000);
        child.stdout.on('data', chunk => {
          stdout += chunk;
          const newline = stdout.indexOf('\n');
          if (newline >= 0) {
            clearTimeout(timeout);
            const result = JSON.parse(stdout.slice(0, newline));
            adminHttpBase = result.admin_http_base;
            resolve({ child, result, finish: () => child.stdin.end('\n') });
          }
        });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => {
          clearTimeout(timeout);
          if (code !== 0 && code !== null) reject(new Error(stderr || `admin test driver exited ${code}`));
        });
        child.stdin.write(JSON.stringify({ api_base: base, service_token: adminServiceToken,
          session_secret: adminSessionSecret, telegram_id: telegramId, global_id: globalAdminId,
          license_private_key: activationPrivatePem, global_mode: globalMode, updates }) + '\n');
      });
    }
    async function adminRequest(route, sessionToken = null, method = 'GET', body = undefined) {
      const requestUrl = new URL(route, base);
      assert.equal(requestUrl.hostname, '127.0.0.1');
      const headers = sessionToken ? { authorization: `Bearer ${sessionToken}` } : {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(requestUrl, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    }
    let issuedCompanySessionToken = '';
    async function exerciseAdmin(telegramId, globalMode) {
      const running = await adminProcess(telegramId, globalMode);
      try {
        const replies = running.result.replies;
        assert.equal(replies.length, 1);
        assert.match(replies[0].payload.text, /WebApp/);
        assert.equal(replies[0].payload.chat_id, Number(telegramId));
        const keyboardUrl = replies[0].payload.reply_markup.inline_keyboard[0][0].web_app.url;
        assert.equal(new URL(keyboardUrl).hostname, '127.0.0.1');
        const sessionResponse = await fetch(new URL('/api/admin/webapp/session', base), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ initData: running.result.init_data })
        });
        assert.equal(sessionResponse.status, 200);
        const session = await sessionResponse.json();
        assert.equal(session.success, true);
        assert.equal(session.access.isGlobalAdmin, globalMode);
        assert.deepEqual(session.access.companyIds, globalMode ? null : [tenant]);
        const sessionToken = session.session.token;
        if (!globalMode) issuedCompanySessionToken = sessionToken;
        const own = await adminRequest(`/api/admin/webapp/payroll?companyId=${tenant}&periodId=P`, sessionToken);
        assert.equal(own.status, 200);
        assert.equal(own.body.payroll.workers[0].gross, 63);
        assert.equal(own.body.payroll.workers[0].net, 55);
        assert.equal(own.body.payroll.workers[0].pieces, 14);
        const companies = await adminRequest('/api/admin/webapp/companies', sessionToken);
        assert.equal(companies.status, 200);
        assert.deepEqual(companies.body.companies.map(c => c.companyId).sort(), globalMode ? [other, tenant].sort() : [tenant]);
        const foreign = await adminRequest(`/api/admin/webapp/payroll?companyId=${other}&periodId=P`, sessionToken);
        if (globalMode) {
          assert.equal(foreign.status, 200);
          assert.equal(foreign.body.payroll.workers[0].gross, 9000);
          assert.equal(foreign.body.payroll.workers[0].net, 8993);
        }
        else {
          assert.equal(foreign.status, 403);
          assert.equal(foreign.body.error.code, 'ADMIN_COMPANY_SCOPE_REQUIRED');
        }
        const unauthenticated = await adminRequest(`/api/admin/webapp/payroll?companyId=${tenant}&periodId=P`);
        assert.equal(unauthenticated.status, 401);
        assert.equal(unauthenticated.body.error.code, 'ADMIN_SESSION_REQUIRED');
        const expired = await adminRequest(`/api/admin/webapp/payroll?companyId=${tenant}&periodId=P`, running.result.expired_session);
        assert.equal(expired.status, 401);
        assert.equal(expired.body.error.code, 'ADMIN_SESSION_EXPIRED');
        if (!globalMode) {
          const globalOnly = await adminRequest('/api/admin/webapp/companies/' + tenant + '/admins', sessionToken);
          assert.equal(globalOnly.status, 403);
          assert.equal(globalOnly.body.error.code, 'ADMIN_GLOBAL_SCOPE_REQUIRED');
        }
        return { reply: replies[0].payload.text, requests: running.result.api_requests,
          access: session.access, payroll: own.body.payroll.workers[0], companies: companies.body.companies.map(c => c.companyId),
          foreign: foreign.status === 403 ? foreign.body.error.code : `GLOBAL_HTTP_${foreign.status}`,
          unauthenticated: unauthenticated.body.error.code, expired: expired.body.error.code };
      } finally {
        running.finish();
      }
    }
    async function exerciseAdminWrites() {
      await pool.query(`UPDATE activation_company_admins SET is_active=TRUE WHERE company_id=$1 AND telegram_id=$2`, [tenant, companyAdminId]);
      const running = await adminProcess(companyAdminId, false);
      try {
        const sessionResponse = await fetch(new URL('/api/admin/webapp/session', base), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ initData: running.result.init_data })
        });
        assert.equal(sessionResponse.status, 200);
        const bearer = (await sessionResponse.json()).session.token;
        const guid = () => crypto.randomUUID();
        const rates = (sew) => [{ name: 'Sew', rate: sew }, { name: 'Unknown', rate: 0 }, { name: 'Zero', rate: 0 }];
        const ratePath = (company) => `/api/admin/webapp/companies/${company}/models/m/rates`;
        const workerPath = (company) => `/api/admin/webapp/companies/${company}/workers/7`;
        const statusPath = (company) => `${workerPath(company)}/status`;
        const unbindPath = (company) => `${workerPath(company)}/unbind`;
        const closePath = (company, period) => `/api/admin/webapp/companies/${company}/periods/${period}/close`;
        const foreignBefore = (await pool.query(`SELECT m.server_revision AS model_revision,m.operations_json,
          w.name,w.staj,w.status,w.server_revision AS worker_revision,p.is_closed
          FROM models m JOIN workers w ON w.company_id=m.company_id AND w.id=7
          JOIN periods p ON p.company_id=m.company_id AND p.id='P'
          WHERE m.company_id=$1 AND m.id='m'`, [other])).rows[0];
        const denied = [
          await adminRequest(ratePath(other), bearer, 'PUT', { baseRevision: 1, operationId: guid(), commandId: guid(), operations: rates(1) }),
          await adminRequest(workerPath(other), bearer, 'PUT', { baseRevision: 1, operationId: guid(), commandId: guid(), name: 'NOPE', staj: 99 }),
          await adminRequest(statusPath(other), bearer, 'PUT', { status: 'INACTIVE', baseRevision: 1, operationId: guid(), commandId: guid() }),
          await adminRequest(unbindPath(other), bearer, 'POST', { telegramId: id }),
          await adminRequest(closePath(other, 'P'), bearer, 'POST', { baseRevision: 1, operationId: guid(), commandId: guid(), endDate: '2026-10-31', nextPeriod: { id: 'denied', name: 'Denied', startDate: '2026-11-01' } })
        ];
        assert(denied.every(row => row.status === 403 && row.body.error.code === 'ADMIN_COMPANY_SCOPE_REQUIRED'), JSON.stringify(denied));
        const foreignAfter = (await pool.query(`SELECT m.server_revision AS model_revision,m.operations_json,
          w.name,w.staj,w.status,w.server_revision AS worker_revision,p.is_closed
          FROM models m JOIN workers w ON w.company_id=m.company_id AND w.id=7
          JOIN periods p ON p.company_id=m.company_id AND p.id='P'
          WHERE m.company_id=$1 AND m.id='m'`, [other])).rows[0];
        assert.deepEqual(foreignAfter, foreignBefore);

        const qBefore = await adminRequest(`/api/admin/webapp/payroll?companyId=${tenant}&periodId=Q`, bearer);
        assert.deepEqual([qBefore.body.payroll.workers[0].gross, qBefore.body.payroll.workers[0].net], [36, 32]);
        const modelBefore = (await pool.query(`SELECT server_revision FROM models WHERE company_id=$1 AND id='m'`, [tenant])).rows[0];
        const rateWrite = await adminRequest(ratePath(tenant), bearer, 'PUT', {
          baseRevision: Number(modelBefore.server_revision), operationId: guid(), commandId: guid(), operations: rates(11)
        });
        assert.equal(rateWrite.status, 200, JSON.stringify(rateWrite.body));
        const modelAt11 = (await pool.query(`SELECT server_revision,operations_json FROM models WHERE company_id=$1 AND id='m'`, [tenant])).rows[0];
        assert.equal(Number(modelAt11.server_revision), Number(modelBefore.server_revision) + 1);
        assert.equal(modelAt11.operations_json.find(operation => operation.name === 'Sew').rate, 11);
        assert.equal((await pool.query(`SELECT operations_json FROM models WHERE company_id=$1 AND id='m'`, [other])).rows[0].operations_json.find(operation => operation.name === 'Sew').rate, 900);
        const qAt11 = await adminRequest(`/api/admin/webapp/payroll?companyId=${tenant}&periodId=Q`, bearer);
        assert.deepEqual([qAt11.body.payroll.workers[0].gross, qAt11.body.payroll.workers[0].net], [44, 40]);

        const workerRevision = Number((await pool.query(`SELECT server_revision FROM workers WHERE company_id=$1 AND id=7`, [tenant])).rows[0].server_revision);
        const adminAdjustmentId = guid();
        const workerEdit = await adminRequest(workerPath(tenant), bearer, 'PUT', {
          baseRevision: workerRevision, operationId: guid(), commandId: guid(), name: 'Synthetic Revised Worker', role: 'Bichuvchi', staj: 2,
          adjustment: { adjustmentId: adminAdjustmentId, type: 'AVANS', periodId: 'Q', amountDelta: 2, description: 'synthetic admin adjustment' }
        });
        assert.equal(workerEdit.status, 200, JSON.stringify(workerEdit.body));
        assert.deepEqual((await pool.query(`SELECT name,role,staj,status,server_revision FROM workers WHERE company_id=$1 AND id=7`, [tenant])).rows[0],
          { name: 'Synthetic Revised Worker', role: 'Bichuvchi', staj: '2', status: 'ACTIVE', server_revision: 2 });
        assert.deepEqual((await pool.query(`SELECT type,amount,period_id,provenance FROM worker_adjustments WHERE id=$1`, [adminAdjustmentId])).rows[0],
          { type: 'AVANS', amount: '2', period_id: 'Q', provenance: 'ADMIN_WEBAPP' });
        const qAfterEdit = await adminRequest(`/api/admin/webapp/payroll?companyId=${tenant}&periodId=Q`, bearer);
        assert.deepEqual([qAfterEdit.body.payroll.workers[0].gross, qAfterEdit.body.payroll.workers[0].net], [44, 37]);
        sqlite.prepare(`UPDATE models SET operations_json=? WHERE company_id=? AND id='m'`).run(JSON.stringify(rates(11)), tenant);
        sqlite.prepare(`UPDATE workers SET name='Synthetic Revised Worker',role='Bichuvchi',staj=2 WHERE company_id=? AND id=7`).run(tenant);
        sqlite.prepare(`INSERT INTO worker_adjustments(id,company_id,worker_id,period_id,type,amount,provenance,created_at,status)
          VALUES (?, ?, 7, 'Q', 'AVANS', 2, 'REMOTE_SYNC', ?, 'POSTED')`).run(adminAdjustmentId, tenant, now);

        const periodRevision = Number((await pool.query(`SELECT server_revision FROM periods WHERE company_id=$1 AND id='Q'`, [tenant])).rows[0].server_revision);
        const close = await adminRequest(closePath(tenant, 'Q'), bearer, 'POST', {
          baseRevision: periodRevision, operationId: guid(), commandId: guid(), endDate: '2026-11-30', archiveFilename: 'synthetic-Q.json',
          nextPeriod: { id: 'R', name: 'Synthetic R', startDate: '2026-12-01' }
        });
        assert.equal(close.status, 200, JSON.stringify(close.body));
        assert.deepEqual((await pool.query(`SELECT is_closed FROM periods WHERE company_id=$1 AND id='Q'`, [tenant])).rows[0], { is_closed: 1 });
        assert.deepEqual((await pool.query(`SELECT is_closed FROM periods WHERE company_id=$1 AND id='R'`, [tenant])).rows[0], { is_closed: 0 });
        const archiveRow = (await pool.query(`SELECT archive_json,sha256 FROM period_archives WHERE company_id=$1 AND period_id='Q'`, [tenant])).rows[0];
        const archive = typeof archiveRow.archive_json === 'string' ? JSON.parse(archiveRow.archive_json) : archiveRow.archive_json;
        assert.equal(archive.models.find(model => model.id === 'm').operations.find(operation => operation.name === 'Sew').rate, 11);
        assert.equal(archiveRow.sha256, computePayloadHash(canonicalStringify(archive)));
        sqlite.prepare(`UPDATE periods SET is_closed=1 WHERE company_id=? AND id='Q'`).run(tenant);
        sqlite.prepare(`INSERT INTO period_archives(company_id,period_id,archive_json,sha256,archived_at) VALUES (?,'Q',?,?,?)`)
          .run(tenant, JSON.stringify(archive), archiveRow.sha256, now);

        const currentRate = await adminRequest(ratePath(tenant), bearer, 'PUT', {
          baseRevision: Number(modelAt11.server_revision), operationId: guid(), commandId: guid(), operations: rates(13)
        });
        assert.equal(currentRate.status, 200, JSON.stringify(currentRate.body));
        const closedQ = await adminRequest(`/api/admin/webapp/payroll?companyId=${tenant}&periodId=Q`, bearer);
        assert.deepEqual([closedQ.body.payroll.workers[0].gross, closedQ.body.payroll.workers[0].net,
          closedQ.body.payroll.workers[0].pieces], [44, 37, 4]);
        const closedP = await adminRequest(`/api/admin/webapp/payroll?companyId=${tenant}&periodId=P`, bearer);
        assert.deepEqual([closedP.body.payroll.workers[0].gross, closedP.body.payroll.workers[0].net], [63, 54]);
        const desktopQ = loadPayrollValuationFromSqlite(sqlite, tenant, 'Q').workers[0];
        const desktopP = loadPayrollValuationFromSqlite(sqlite, tenant, 'P').workers[0];
        assert.deepEqual([desktopQ.gross, desktopQ.net, desktopQ.pieces], [44, 37, 4]);
        assert.deepEqual([desktopP.gross, desktopP.net], [63, 54]);

        await pool.query(`INSERT INTO worker_telegram_bindings(telegram_id,company_id,worker_id,username) VALUES ($1,$2,7,'synthetic')`, [id, tenant]);
        const unbind = await adminRequest(unbindPath(tenant), bearer, 'POST', { telegramId: id });
        assert.equal(unbind.status, 200, JSON.stringify(unbind.body));
        assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS n FROM worker_telegram_bindings WHERE telegram_id=$1`, [id])).rows[0].n), 0);
        assert.equal((await pool.query(`SELECT actor_telegram_id FROM worker_telegram_binding_events WHERE company_id=$1 AND worker_id=7 AND telegram_id=$2 ORDER BY event_id DESC LIMIT 1`, [tenant, id])).rows[0].actor_telegram_id, companyAdminId);
        const oldWorkerLink = await fetch(webUrl, { headers: webHeaders });
        assert([401, 403].includes(oldWorkerLink.status));
        assert(!(await oldWorkerLink.text()).includes('Synthetic Revised Worker'));

        const workerStatus = await adminRequest(statusPath(tenant), bearer, 'PUT', {
          status: 'INACTIVE', baseRevision: workerRevision + 1, operationId: guid(), commandId: guid()
        });
        assert.equal(workerStatus.status, 200, JSON.stringify(workerStatus.body));
        const statusReadback = (await pool.query(`SELECT status,server_revision FROM workers WHERE company_id=$1 AND id=7`, [tenant])).rows[0];
        assert.equal(statusReadback.status, 'INACTIVE');
        assert.equal(Number(statusReadback.server_revision), workerRevision + 2);

        await pool.query(`UPDATE activation_company_admins SET is_active=FALSE WHERE company_id=$1 AND telegram_id=$2`, [tenant, companyAdminId]);
        const modelBeforeStale = (await pool.query(`SELECT server_revision,operations_json FROM models WHERE company_id=$1 AND id='m'`, [tenant])).rows[0];
        const staleWrite = await adminRequest(ratePath(tenant), bearer, 'PUT', {
          baseRevision: Number(modelBeforeStale.server_revision), operationId: guid(), commandId: guid(), operations: rates(77)
        });
        assert.equal(staleWrite.status, 403);
        assert.equal(staleWrite.body.error.code, 'ADMIN_TELEGRAM_ID_NOT_AUTHORIZED');
        assert.deepEqual((await pool.query(`SELECT server_revision,operations_json FROM models WHERE company_id=$1 AND id='m'`, [tenant])).rows[0], modelBeforeStale);
        return { denied: denied.map(result => result.body.error.code), deniedScopeNoMutation: true,
          modelRates: [9, 11, 13], qBefore: [36, 32], qAt11: [44, 40], qAfterWorkerEdit: [44, 37], adminAdjustment: [2, 'Q', 'ADMIN_WEBAPP'],
          qCloseRate: 11, qClosedAfterCurrent13: [closedQ.body.payroll.workers[0].gross, closedQ.body.payroll.workers[0].net, closedQ.body.payroll.workers[0].pieces],
          pAfterCurrent13: [closedP.body.payroll.workers[0].gross, closedP.body.payroll.workers[0].net],
          desktopQ: [desktopQ.gross, desktopQ.net, desktopQ.pieces], desktopP: [desktopP.gross, desktopP.net],
          unbindStatus: oldWorkerLink.status, workerStatus: statusReadback.status, staleWrite: staleWrite.body.error.code };
      } finally { running.finish(); }
    }
    async function exerciseActivationAndCompanyWrites() {
      await pool.query(`UPDATE activation_company_admins SET is_active=TRUE WHERE company_id=$1 AND telegram_id=$2`, [tenant, companyAdminId]);
      const companyRun = await adminProcess(companyAdminId, false);
      let companyEvidence;
      try {
        const sessionResponse = await fetch(new URL('/api/admin/webapp/session', base), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ initData: companyRun.result.init_data })
        });
        assert.equal(sessionResponse.status, 200);
        const bearer = (await sessionResponse.json()).session.token;
        async function exerciseFinancialUiRetry() {
          // Actual WebApp handlers and session-scoped intent module, against the signed route and owned PG.
          await pool.query(`INSERT INTO workers(id,company_id,name,staj) VALUES (8,$1,'Retry Worker',0)`, [tenant]);
          await pool.query(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,party_record_id,patta_number,qty,status,submitted_at)
            VALUES ('00000000-0000-4000-8000-0000000000f8',$1,'m','R','1','synthetic-party',8,2,'CONFIRMED',$2)`, [tenant, now]);
          await pool.query(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,rate_snapshot,qty)
            VALUES ('retry-entry','00000000-0000-4000-8000-0000000000f8',$1,'Sew',8,13,2)`, [tenant]);
          const source = fs.readFileSync(path.join(root, 'apps/server/static/admin-webapp/admin.js'), 'utf8');
          const boot = '  enforceLightModeTheme();\n  bindEvents();\n  void beginAuthentication();\n})();';
          assert(source.includes(boot), 'actual UI entrypoint changed');
          const script = source.replace(boot, `  window.fixture = { state, companyPanel, submitQuickAdjustment, giveCompanyAdvance };\n})();`);
          const intentApi = require('../../apps/server/static/admin-webapp/financial-intent.js');
          const cells = new Map();
          const element = (key) => {
            if (!cells.has(key)) cells.set(key, { disabled: false, hidden: false, value: '', fields: {},
              addEventListener() {}, close() {}, classList: { toggle() {}, add() {}, remove() {} } });
            return cells.get(key);
          };
          const data = new Map();
          const storage = { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value),
            removeItem: key => data.delete(key) };
          const queues = new Map();
          const locks = { request(key, _options, action) {
            const previous = queues.get(key) || Promise.resolve();
            const next = previous.catch(() => {}).then(action);
            queues.set(key, next);
            void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
            return next;
          } };
          const requests = [];
          let drop = false;
          let prompts = [];
          let confirms = [];
          const fetchUi = async (route, init) => {
            const url = new URL(route, base);
            assert.equal(url.hostname, '127.0.0.1');
            assert(url.pathname.startsWith('/api/admin/webapp/'));
            if (init.method === 'PUT') requests.push(JSON.parse(init.body));
            const response = await fetch(url, init);
            if (init.method === 'PUT' && drop) {
              if (response.status !== 200) {
                console.error(`fixture PUT rejected ${response.status} ${((await response.json()).error || {}).code || ''}`);
                throw new Error('fixture expected committed PUT');
              }
              await response.text(); drop = false;
              throw new Error('synthetic lost HTTP response after commit');
            }
            return response;
          };
          function ui(actor = companyAdminId, options = {}) {
            const submitButton = { disabled: false };
            const tabElement = (key) => key === 'submitQuickAdj' ? submitButton : element(key);
            const win = { NovdaFinancialIntent: intentApi, localStorage: options.storage || storage,
              setTimeout: () => 1, clearTimeout() {}, prompt: () => prompts.shift() ?? null,
              confirm: () => confirms.shift() ?? false };
            const context = { window: win, document: { getElementById: tabElement, querySelectorAll: () => [], addEventListener() {} },
              fetch: fetchUi, Headers, FormData: class { constructor(form) { this.fields = form.fields; } get(key) { return this.fields[key]; } },
              URL, URLSearchParams, crypto, console, navigator: { locks: options.noLocks ? null : locks } };
            vm.runInNewContext(script, context, { filename: 'admin-webapp/admin.js', timeout: 3000 });
            const fixture = win.fixture;
            fixture.state.sessionToken = bearer;
            fixture.state.user = { id: actor };
            fixture.state.sessionActorId = companyAdminId;
            fixture.state.access = { isGlobalAdmin: false, companyIds: [tenant] };
            fixture.companyPanel.companyId = tenant;
            fixture.companyPanel.periods = [{ periodId: 'R', isClosed: false }];
            fixture.companyPanel.selectedWorker = { companyId: tenant, workerId: 8, name: 'Retry Worker', staj: 0, serverRevision: 1 };
            return fixture;
          }
          const read = async () => {
            const row = (await adminRequest(`/api/admin/webapp/payroll?companyId=${tenant}&periodId=R`, bearer)).body.payroll.workers.find(w => Number(w.workerId) === 8);
            const facts = (await pool.query(`SELECT id,type,amount::text AS amount,period_id FROM worker_adjustments
              WHERE company_id=$1 AND worker_id=8 ORDER BY id`, [tenant])).rows;
            const revision = Number((await pool.query(`SELECT server_revision FROM workers WHERE company_id=$1 AND id=8`, [tenant])).rows[0].server_revision);
            return { gross: row.gross, net: row.net, facts, revision };
          };
          assert.deepEqual([ (await read()).gross, (await read()).net ], [26, 26]);
          const quick = element('quickAdjustmentForm');
          quick.fields = { workerId: '8', companyId: tenant, type: 'JARIMA', periodId: 'R', amountDelta: '3', description: 'retry quick' };
          const first = ui();
          drop = true;
          const opening = first.submitQuickAdjustment({ preventDefault() {} });
          await first.submitQuickAdjustment({ preventDefault() {} }); // double-click cannot create another intent.
          await opening;
          assert.equal(requests.length, 1);
          assert.deepEqual([ (await read()).gross, (await read()).net, (await read()).facts.length ], [26, 23, 1]);
          assert.equal(data.size, 1);
          const wrongActor = ui('999999999');
          await wrongActor.submitQuickAdjustment({ preventDefault() {} });
          assert.equal(requests.length, 1, 'other actor cannot dispatch prior intent');
          const switched = ui();
          switched.state.selectedCompanyId = other;
          await switched.submitQuickAdjustment({ preventDefault() {} });
          assert.equal(requests.length, 1, 'changed company cannot dispatch old intent');
          const recovered = ui(); // Closed tab/new VM: localStorage persists; sessionStorage does not.
          const concurrent = ui();
          await Promise.all([recovered.submitQuickAdjustment({ preventDefault() {} }),
            concurrent.submitQuickAdjustment({ preventDefault() {} })]);
          assert.equal(requests.length, 2);
          assert.deepEqual(requests[1], requests[0]);
          assert.deepEqual([ (await read()).net, (await read()).facts.length, (await read()).revision ], [23, 1, 2]);
          assert.equal(data.size, 1, 'resolved marker stops stale tab from opening the same draft as new money');
          const persisted = intentApi.create(storage, locks);
          const scope = { actor: companyAdminId, companyId: tenant, kind: 'quick-adjustment' };
          assert.throws(() => persisted.complete(scope, requests[0].operationId), /FINANCIAL_INTENT_CHANGED/);
          assert.equal(data.size, 1, 'old completion cannot remove the current resolved marker');
          const broken = { getItem() { throw new Error('storage disabled'); }, setItem() { throw new Error('storage disabled'); }, removeItem() { throw new Error('storage disabled'); } };
          await ui(companyAdminId, { storage: broken }).submitQuickAdjustment({ preventDefault() {} });
          await ui(companyAdminId, { noLocks: true }).submitQuickAdjustment({ preventDefault() {} });
          assert.equal(requests.length, 2, 'unavailable storage/coordination fails closed before PUT');

          // A different explicit intent after successful receipt gets new IDs; first rejection is definite.
          quick.fields = { ...quick.fields, periodId: 'closed-invalid', amountDelta: '2' };
          await recovered.submitQuickAdjustment({ preventDefault() {} });
          assert.equal(data.size, 0);
          assert.equal((await read()).facts.length, 1);
          quick.fields = { ...quick.fields, periodId: 'R', amountDelta: '2', description: 'second quick' };
          await recovered.submitQuickAdjustment({ preventDefault() {} });
          assert.equal(requests.length, 4);
          assert.notEqual(requests[3].operationId, requests[0].operationId);
          assert.deepEqual([ (await read()).net, (await read()).facts.length ], [21, 2]);

          const advance = ui();
          prompts = ['5', 'retry advance']; drop = true;
          await advance.giveCompanyAdvance(advance.companyPanel.selectedWorker);
          assert.equal(data.size, 1);
          assert.deepEqual([ (await read()).net, (await read()).facts.length ], [16, 3], element('companyToast').textContent);
          const changed = ui(); changed.state.sessionToken = 'other-session';
          // The actor/session authorization guard rejects a company switch before dispatch.
          changed.state.selectedCompanyId = other;
          prompts = ['5', 'retry advance'];
          await changed.giveCompanyAdvance(changed.companyPanel.selectedWorker);
          assert.equal(requests.length, 5);
          const restored = ui(); prompts = ['5', 'retry advance'];
          await restored.giveCompanyAdvance(restored.companyPanel.selectedWorker);
          assert.equal(requests.length, 6);
          assert.deepEqual(requests[5], requests[4]);
          assert.deepEqual([ (await read()).gross, (await read()).net, (await read()).facts.length, (await read()).revision ], [26, 16, 3, 4]);
          assert.equal(data.size, 1, 'completed advance keeps a resolved marker across tabs');
          const advanceScope = { actor: companyAdminId, companyId: tenant, kind: 'company-advance' };
          assert.throws(() => persisted.complete(advanceScope, requests[4].operationId), /FINANCIAL_INTENT_CHANGED/);
          const oldTab = ui(); prompts = ['5', 'retry advance'];
          await oldTab.giveCompanyAdvance(oldTab.companyPanel.selectedWorker);
          assert.equal(requests.length, 6, 'a stale tab cannot silently create a fourth identical deduction');
          assert.deepEqual([ (await read()).net, (await read()).facts.length ], [16, 3]);
          assert.deepEqual((await pool.query(`SELECT amount::text,period_id,provenance FROM worker_adjustments WHERE company_id=$1 AND worker_id=8 ORDER BY amount`, [tenant])).rows,
            [{ amount: '2', period_id: 'R', provenance: 'ADMIN_WEBAPP' }, { amount: '3', period_id: 'R', provenance: 'ADMIN_WEBAPP' }, { amount: '5', period_id: 'R', provenance: 'ADMIN_WEBAPP' }]);
          console.log('FINANCIAL_UI_RETRY quick 26->23->21, advance 21->16; lost responses, exact bodies replayed, 3 facts once');
        }
        await exerciseFinancialUiRetry();
        const expiredApprove = await adminRequest(`/api/admin/webapp/activations/00000000-0000-4000-8000-000000000101/approve`,
          companyRun.result.expired_session, 'POST', { companyId: tenant, role: 'admin' });
        assert.equal(expiredApprove.status, 401);
        assert.equal(expiredApprove.body.error.code, 'ADMIN_SESSION_EXPIRED');
        const crossApprove = await adminRequest(`/api/admin/webapp/activations/00000000-0000-4000-8000-000000000102/approve`,
          bearer, 'POST', { companyId: other, role: 'admin' });
        assert.equal(crossApprove.status, 403);
        assert.equal(crossApprove.body.error.code, 'ADMIN_COMPANY_SCOPE_REQUIRED');
        const approveBefore = (await pool.query(`SELECT status,company_id,signed_payload FROM activation_requests
          WHERE request_id='00000000-0000-4000-8000-000000000101'`)).rows[0];
        assert.deepEqual(approveBefore, { status: 'PENDING', company_id: null, signed_payload: null });
        assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS n FROM activation_events
          WHERE request_id='00000000-0000-4000-8000-000000000101'`)).rows[0].n), 0);

        const approve = await adminRequest(`/api/admin/webapp/activations/00000000-0000-4000-8000-000000000101/approve`,
          bearer, 'POST', { companyId: tenant, role: 'admin' });
        assert.equal(approve.status, 200, JSON.stringify(approve.body));
        assert.equal(approve.body.activation.activation.payload.status, 'active');
        assert.equal(approve.body.activation.activation.payload.companyId, tenant);
        const approved = (await pool.query(`SELECT status,company_id,role,signed_payload,signature,approved_by_telegram_id
          FROM activation_requests WHERE request_id='00000000-0000-4000-8000-000000000101'`)).rows[0];
        assert.equal(approved.status, 'APPROVED');
        assert.equal(approved.company_id, tenant);
        assert.equal(approved.role, 'admin');
        assert.equal(approved.signed_payload.status, 'active');
        assert.equal(approved.approved_by_telegram_id, companyAdminId);
        assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS n FROM activation_events
          WHERE request_id='00000000-0000-4000-8000-000000000101' AND event_type='APPROVED'`)).rows[0].n), 1);
        assert.deepEqual((await pool.query(`SELECT device_id,company_id,is_revoked FROM server_devices WHERE device_id='A1B2-C3D4-E5F6-A7B8'`)).rows[0],
          { device_id: 'A1B2-C3D4-E5F6-A7B8', company_id: tenant, is_revoked: false });
        const duplicateApprove = await adminRequest(`/api/admin/webapp/activations/00000000-0000-4000-8000-000000000101/approve`,
          bearer, 'POST', { companyId: tenant, role: 'admin' });
        assert.equal(duplicateApprove.status, 409);
        assert.equal(duplicateApprove.body.error.code, 'ACTIVATION_REQUEST_NOT_PENDING');
        assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS n FROM activation_events
          WHERE request_id='00000000-0000-4000-8000-000000000101'`)).rows[0].n), 1);

        const reject = await adminRequest(`/api/admin/webapp/activations/00000000-0000-4000-8000-000000000103/reject`,
          bearer, 'POST', { companyId: tenant, reason: 'synthetic rejection' });
        assert.equal(reject.status, 200, JSON.stringify(reject.body));
        assert.deepEqual((await pool.query(`SELECT status,rejection_reason,rejected_by_telegram_id FROM activation_requests
          WHERE request_id='00000000-0000-4000-8000-000000000103'`)).rows[0],
          { status: 'REJECTED', rejection_reason: 'synthetic rejection', rejected_by_telegram_id: companyAdminId });
        const duplicateReject = await adminRequest(`/api/admin/webapp/activations/00000000-0000-4000-8000-000000000103/reject`,
          bearer, 'POST', { companyId: tenant, reason: 'duplicate synthetic rejection' });
        assert.equal(duplicateReject.status, 409);
        assert.equal(duplicateReject.body.error.code, 'ACTIVATION_REQUEST_NOT_PENDING');
        assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS n FROM activation_events
          WHERE request_id='00000000-0000-4000-8000-000000000103'`)).rows[0].n), 1);

        const revoke = await adminRequest(`/api/admin/webapp/activations/00000000-0000-4000-8000-000000000101/revoke`, bearer, 'POST', {});
        assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
        assert.equal(revoke.body.activation.activation.payload.status, 'revoked');
        const revokedRow = (await pool.query(`SELECT status,signed_payload,revoked_by_telegram_id FROM activation_requests
          WHERE request_id='00000000-0000-4000-8000-000000000101'`)).rows[0];
        assert.equal(revokedRow.status, 'REVOKED');
        assert.equal(revokedRow.signed_payload.status, 'revoked');
        assert.equal(revokedRow.revoked_by_telegram_id, companyAdminId);
        const duplicateRevoke = await adminRequest(`/api/admin/webapp/activations/00000000-0000-4000-8000-000000000101/revoke`, bearer, 'POST', {});
        assert.equal(duplicateRevoke.status, 409);
        assert.equal(duplicateRevoke.body.error.code, 'ACTIVATION_NOT_REVOCABLE');
        assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS n FROM activation_events
          WHERE request_id='00000000-0000-4000-8000-000000000101'`)).rows[0].n), 2);

        const companyGrantBefore = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM activation_company_admins
          WHERE company_id=$1 AND telegram_id='778899001'`, [tenant])).rows[0].n);
        assert.equal(companyGrantBefore, 0);
        const nonGlobalGrant = await adminRequest(`/api/admin/webapp/companies/${tenant}/admins/778899001`, bearer, 'PUT', { isActive: true });
        assert.equal(nonGlobalGrant.status, 403);
        assert.equal(nonGlobalGrant.body.error.code, 'ADMIN_GLOBAL_SCOPE_REQUIRED');
        const nonGlobalCompanyPolicy = await adminRequest('/api/admin/webapp/companies', bearer, 'POST', {
          companyId: other, companyName: 'Must not change', allowedRoles: ['admin'], isActive: true
        });
        assert.equal(nonGlobalCompanyPolicy.status, 403);
        assert.equal(nonGlobalCompanyPolicy.body.error.code, 'ADMIN_COMPANY_SCOPE_REQUIRED');
        const nonGlobalStrictMode = await adminRequest(`/api/admin/webapp/companies/${other}/strict-mode`, bearer, 'PUT', { strictMode: false });
        assert.equal(nonGlobalStrictMode.status, 403);
        assert.equal(nonGlobalStrictMode.body.error.code, 'ADMIN_COMPANY_SCOPE_REQUIRED');
        const foreignPolicy = (await pool.query(`SELECT company_name,is_active,allowed_roles FROM activation_companies WHERE company_id=$1`, [other])).rows[0];
        assert.equal(foreignPolicy.company_name, 'Synthetic B');
        assert.equal(foreignPolicy.is_active, true);
        companyEvidence = { expired: expiredApprove.body.error.code, crossApprove: crossApprove.body.error.code,
          approve: approved.status, duplicateApprove: duplicateApprove.body.error.code, reject: 'REJECTED',
          duplicateReject: duplicateReject.body.error.code, revoke: 'REVOKED', duplicateRevoke: duplicateRevoke.body.error.code,
          companyScopeDenials: [nonGlobalGrant.body.error.code, nonGlobalCompanyPolicy.body.error.code,
            nonGlobalStrictMode.body.error.code] };
      } finally { companyRun.finish(); }

      const globalRun = await adminProcess(globalAdminId, true);
      try {
        const sessionResponse = await fetch(new URL('/api/admin/webapp/session', base), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ initData: globalRun.result.init_data })
        });
        assert.equal(sessionResponse.status, 200);
        const bearer = (await sessionResponse.json()).session.token;
        const companyPolicy = await adminRequest('/api/admin/webapp/companies', bearer, 'POST', {
          companyId: tenant, companyName: 'Synthetic A Policy', allowedRoles: ['admin', 'type', 'print'], isActive: true
        });
        assert.equal(companyPolicy.status, 200, JSON.stringify(companyPolicy.body));
        assert.deepEqual((await pool.query(`SELECT company_name,allowed_roles,is_active,updated_by_telegram_id
          FROM activation_companies WHERE company_id=$1`, [tenant])).rows[0], {
          company_name: 'Synthetic A Policy', allowed_roles: ['admin', 'type', 'print'], is_active: true, updated_by_telegram_id: globalAdminId
        });
        const strictMode = await adminRequest(`/api/admin/webapp/companies/${tenant}/strict-mode`, bearer, 'PUT', { strictMode: false });
        assert.equal(strictMode.status, 200, JSON.stringify(strictMode.body));
        assert.deepEqual((await pool.query(`SELECT require_ticket_validation,policy_revision FROM activation_companies WHERE company_id=$1`, [tenant])).rows[0],
          { require_ticket_validation: false, policy_revision: 2 });
        assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS n FROM activation_policy_events WHERE company_id=$1`, [tenant])).rows[0].n), 1);
        const grantPath = `/api/admin/webapp/companies/${tenant}/admins/778899001`;
        const granted = await adminRequest(grantPath, bearer, 'PUT', { isActive: true });
        assert.equal(granted.status, 200, JSON.stringify(granted.body));
        assert.deepEqual((await pool.query(`SELECT telegram_id,is_active,assigned_by_telegram_id,assignment_source
          FROM activation_company_admins WHERE company_id=$1 AND telegram_id='778899001'`, [tenant])).rows[0], {
          telegram_id: '778899001', is_active: true, assigned_by_telegram_id: globalAdminId, assignment_source: 'TELEGRAM_ADMIN'
        });
        const idempotentGrant = await adminRequest(grantPath, bearer, 'PUT', { isActive: true });
        assert.equal(idempotentGrant.status, 200);
        assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS n FROM activation_company_admins WHERE telegram_id='778899001'`)).rows[0].n), 1);
        const conflictingGrant = await adminRequest(`/api/admin/webapp/companies/${other}/admins/778899001`, bearer, 'PUT', { isActive: true });
        assert.equal(conflictingGrant.status, 409);
        assert.equal(conflictingGrant.body.error.code, 'COMPANY_ADMIN_ALREADY_ASSIGNED');
        assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS n FROM activation_company_admins WHERE company_id=$1 AND telegram_id='778899001'`, [other])).rows[0].n), 0);
        const disabledGrant = await adminRequest(grantPath, bearer, 'PUT', { isActive: false });
        assert.equal(disabledGrant.status, 200);
        assert.deepEqual((await pool.query(`SELECT is_active,assigned_by_telegram_id,assignment_source FROM activation_company_admins
          WHERE company_id=$1 AND telegram_id='778899001'`, [tenant])).rows[0], {
          is_active: false, assigned_by_telegram_id: globalAdminId, assignment_source: 'TELEGRAM_ADMIN'
        });
        return { company: companyEvidence, global: { companyPolicy: companyPolicy.status, companyPolicyPersisted: true,
          strictModeApi: strictMode.status, strictModePersisted: false, grantPersisted: true,
          idempotentGrant: idempotentGrant.status, conflictingGrant: conflictingGrant.body.error.code,
          deniedConflictNoMutation: true, disabledGrant: disabledGrant.status, targetInactive: true } };
      } finally { globalRun.finish(); }
    }
    const companyAdmin = await exerciseAdmin(companyAdminId, false);
    await pool.query(`UPDATE activation_company_admins SET is_active=FALSE WHERE company_id=$1 AND telegram_id=$2`,
      [tenant, companyAdminId]);
    const revokedSession = await adminRequest(`/api/admin/webapp/payroll?companyId=${tenant}&periodId=P`, issuedCompanySessionToken);
    assert.equal(revokedSession.status, 403);
    assert.equal(revokedSession.body.error.code, 'ADMIN_TELEGRAM_ID_NOT_AUTHORIZED');
    const globalAdmin = await exerciseAdmin(globalAdminId, true);
    const unauthorisedProcess = await adminProcess('99887766', false);
    try {
      assert(unauthorisedProcess.result.replies[0].payload.text.includes('Ruxsat berilmagan'));
      assert(!unauthorisedProcess.result.replies[0].payload.reply_markup);
    } finally { unauthorisedProcess.finish(); }
    const privateGuards = await adminProcess(companyAdminId, false, [
      { chat_id: -100123, type: 'group', user_id: Number(companyAdminId), text: '/start' },
      { chat_id: 999, type: 'private', user_id: Number(companyAdminId), text: '/start' }
    ]);
    try {
      assert.equal(privateGuards.result.replies.length, 0);
      assert.deepEqual(privateGuards.result.api_requests, []);
    } finally { privateGuards.finish(); }
    const adminWrites = await exerciseAdminWrites();
    const adminLifecycleWrites = await exerciseActivationAndCompanyWrites();
    const desktopAdmin = loadPayrollValuationFromSqlite(sqlite, tenant, 'P').workers[0];
    assert.deepEqual([desktopAdmin.gross, desktopAdmin.net, desktopAdmin.pieces], [63, 54, 14]);
    process.stdout.write(JSON.stringify({ open: shown, requests: open.requests, zero: texts(zero), unknown: texts(unknown),
      closed: { gross: closed.gross, net: closed.net, pieces: closed.pieces, status: closed.accountingStatus,
        reasons: closed.accountingReasons }, missing: { gross: missing.gross, unknownEntryCount: missing.unknownEntryCount,
        reasons: missing.accountingReasons }, group, foreign: foreign.json().error.code,
      stale: texts(stale), revokedWeb: 'WORKER_BINDING_REQUIRED', admin: { company: companyAdmin,
        global: globalAdmin, unauthorised: unauthorisedProcess.result.replies[0].payload.text,
        revokedSession: revokedSession.body.error.code,
        privateGuards: { api_requests: privateGuards.result.api_requests, replies: privateGuards.result.replies } },
      adminWrites, adminLifecycleWrites, desktop: {
        open: [81, 73, 9], closed: [63, 55, 14], missing: [missingDesktop.gross, missingDesktop.unknownEntryCount],
        postAdminP: [desktopAdmin.gross, desktopAdmin.net]
      } }, null, 2) + '\n');
  } finally {
    await app.close();
    await pool.end();
    manager.closeAllCompanyDatabases();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
