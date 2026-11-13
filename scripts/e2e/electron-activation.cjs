'use strict';

// Real Electron activation acceptance. The only trust substitution happens in
// an ephemeral source copy outside the repository; the checked-in trust bundle
// and production packaging inputs are never modified.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '../..');
const COMPANY_ID = 'novda_e2e_activation';
const COMPANY_NAME = 'NOVDA Disposable E2E';
const ADMIN_ID = '10001';
const MACHINE_ID = 'E2E0-0000-0000-0001';
const PATTA_MODE = process.argv.includes('--patta');
const PATTA_MODEL_NAME = 'E2E-PATTA-001';
const E2E_PERIOD_ID = 'novda-e2e-open-period-2026';
const OPERATOR_ID = 'e2e-accountant';
const OPERATOR_PASSWORD = crypto.randomBytes(24).toString('hex');
let activeStage = 'runner-start';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return String(result.stdout || '').trim();
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startLoopbackProxy(upstream) {
  let online = true;
  let dropNextSyncResponse = false;
  let deviceAuthorization = null;
  const requests = [];
  const upstreamUrl = new URL(upstream);
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, online, at: new Date().toISOString() });
    if (request.url === '/api/sync/operations' && typeof request.headers.authorization === 'string') {
      deviceAuthorization = request.headers.authorization;
    }
    if (!online) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: false, error: { code: 'E2E_CLIENT_OFFLINE' } }));
      return;
    }
    const forwarded = http.request({ hostname: '127.0.0.1', port: Number(upstreamUrl.port),
      method: request.method, path: request.url, headers: { ...request.headers, host: upstreamUrl.host } }, (upstreamResponse) => {
      if (dropNextSyncResponse && request.url === '/api/sync/operations') {
        dropNextSyncResponse = false;
        upstreamResponse.resume();
        upstreamResponse.on('end', () => response.destroy(new Error('E2E_DROP_ACCEPTED_SYNC_RESPONSE')));
        return;
      }
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    forwarded.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(forwarded);
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}`,
    setOnline(value) { online = value === true; }, get requests() { return requests; },
    get deviceAuthorization() { return deviceAuthorization; },
    dropNextSyncResponse() { dropNextSyncResponse = true; },
    close() { return new Promise(resolve => server.close(resolve)); } };
}

async function waitFor(check, label, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try { last = await check(); if (last) return last; } catch (error) { last = error; }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}: ${last?.message || JSON.stringify(last)}`);
}

async function startPostgres(secretDir) {
  const image = 'postgres:16';
  const digest = run('docker', ['image', 'inspect', image, '--format', '{{.Id}} {{json .RepoDigests}}']);
  assert.match(digest, /sha256:/, 'Pinned local postgres:16 image is required');
  const suffix = crypto.randomBytes(6).toString('hex');
  const container = `novda-e2e-pg-${suffix}`;
  const user = `novda_e2e_${suffix}`;
  const password = crypto.randomBytes(24).toString('hex');
  const database = 'novda_activation_disposable';
  run('docker', ['run', '-d', '--rm', '--name', container,
    '--label', 'novda.disposable-test=electron-activation',
    '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw,size=1073741824',
    '--env', `POSTGRES_USER=${user}`, '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${database}`, image]);
  try {
  const mapping = await waitFor(() => {
    const output = run('docker', ['port', container, '5432/tcp']);
    const match = output.match(/^127\.0\.0\.1:(\d+)$/m);
    return match ? Number(match[1]) : null;
  }, 'dynamic localhost PostgreSQL port');
  const inspect = JSON.parse(run('docker', ['inspect', container]))[0];
  assert.equal(inspect.Config.Image, image);
  assert.equal(inspect.HostConfig.Binds?.length || 0, 0, 'Disposable database must not mount persistent volumes');
  assert.ok(inspect.HostConfig.Tmpfs?.['/var/lib/postgresql/data'], 'PostgreSQL data must use tmpfs');
  assert.equal(inspect.NetworkSettings.Ports['5432/tcp'][0].HostIp, '127.0.0.1');
  const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${mapping}/${database}`;
  await waitFor(() => {
    const result = spawnSync('docker', ['exec', container, 'pg_isready', '-U', user, '-d', database], { encoding: 'utf8' });
    return result.status === 0;
  }, 'PostgreSQL readiness');
  let client;
  await waitFor(async () => {
    const candidate = new (require('pg').Client)({ connectionString: url, connectionTimeoutMillis: 1500 });
    try { await candidate.connect(); client = candidate; return true; }
    catch { await candidate.end().catch(() => {}); return false; }
  }, 'host-mapped PostgreSQL connection');
  const identity = (await client.query(`SELECT current_database() database, current_user username,
    current_setting('server_version_num') version, (SELECT count(*) FROM information_schema.tables WHERE table_schema='public') tables`)).rows[0];
  await client.end();
  assert.equal(identity.database, database);
  assert.equal(identity.username, user);
  assert.ok(identity.version.startsWith('16'));
  assert.equal(Number(identity.tables), 0, 'Must start with an empty public schema');
  const credentialPath = path.join(secretDir, 'disposable-pg-target.json');
  fs.writeFileSync(credentialPath, JSON.stringify({ url, container, port: mapping, identity }), { mode: 0o600, flag: 'wx' });
    return { container, url, port: mapping, identity, digest };
  } catch (error) {
    try { run('docker', ['stop', container]); } catch {}
    throw error;
  }
}

function makeArtifact(tempDir, publicKey) {
  const artifact = path.join(tempDir, 'electron-test-artifact');
  fs.mkdirSync(artifact);
  for (const entry of ['apps', 'packages', 'public', 'index.html', 'vite.config.mts',
    'tsconfig.json', 'tsconfig.node.json', 'package.json']) {
    fs.cpSync(path.join(ROOT, entry), path.join(artifact, entry), { recursive: true, dereference: false });
  }
  const sourceTrust = path.join(artifact, 'packages/contracts/keys/licensePublicKey.cjs');
  fs.writeFileSync(sourceTrust,
    `'use strict';\n// Ephemeral E2E artifact trust. Generated outside the repository.\nmodule.exports = { NOVDA_LICENSE_ED25519_PUBLIC_KEY: ${JSON.stringify(publicKey)}, NOVDA_LEGACY_LICENSE_ED25519_PUBLIC_KEY: ${JSON.stringify(publicKey)} };\n`,
    { mode: 0o600 });

  // Assign this disposable artifact its own valid-format device identity. This
  // replacement is confined to the copied artifact and leaves production
  // hardware binding code byte-for-byte unchanged.
  const licensePath = path.join(artifact, 'apps/desktop/electron/license/license.cjs');
  let licenseSource = fs.readFileSync(licensePath, 'utf8');
  const start = licenseSource.indexOf('function getHardwareId() {');
  const end = licenseSource.indexOf('\n}\n\nfunction isValidCompanyId', start);
  assert.ok(start >= 0 && end > start, 'Unexpected hardware identity implementation; refusing unsafe transform');
  licenseSource = licenseSource.slice(0, start)
    + `function getHardwareId() { return '${MACHINE_ID}';` + licenseSource.slice(end);
  fs.writeFileSync(licensePath, licenseSource, { mode: 0o600 });

  // Defense in depth: renderer-origin network requests from this disposable
  // artifact can reach only its local API. Main-process activation code also
  // checks loopback before enabling the test-only HTTP transport.
  const mainPath = path.join(artifact, 'apps/desktop/electron/main.cjs');
  let mainSource = fs.readFileSync(mainPath, 'utf8');
  const importLine = "const { app, BrowserWindow, ipcMain, shell } = require('electron');";
  assert.ok(mainSource.includes(importLine), 'Unexpected Electron main import; refusing to skip egress guard');
  mainSource = mainSource.replace(importLine, "const { app, BrowserWindow, ipcMain, shell, session } = require('electron');\n"
    + "if (process.env.NOVDA_E2E_ARTIFACT === '1' && process.env.NODE_ENV === 'test') app.whenReady().then(() => {\n"
    + "  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {\n"
    + "    let allowed = false; try { const u = new URL(details.url); allowed = u.protocol === 'file:' || (u.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(u.hostname)); } catch {}\n"
    + "    callback({ cancel: !allowed });\n  });\n});\n");
  const licenseRegistration = `  rejectRendererLicenseSettings\n});`;
  assert.ok(mainSource.includes(licenseRegistration), 'Unexpected license IPC registration; refusing to skip isolated local activation transport');
  mainSource = mainSource.replace(licenseRegistration, `  rejectRendererLicenseSettings,\n  isolatedActivationOptions: () => {\n    if (app.isPackaged || process.env.NODE_ENV !== 'test' || process.env.NOVDA_E2E_ARTIFACT !== '1') return {};\n    try { const u = new URL(process.env.NOVDA_SYNC_SERVER_URL || '');\n      if (u.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(u.hostname)) return {};\n      return { baseUrl: u.toString().replace(/\\/$/, ''), allowHttp: true };\n    } catch { return {}; }\n  }\n});`);
  const printHandler = "ipcMain.handle('print-html', async (event, { html, title }) => {\n  return new Promise((resolve) => {";
  assert.ok(mainSource.includes(printHandler), 'Unexpected print handler; refusing to patch physical printer boundary');
  mainSource = mainSource.replace(printHandler, "ipcMain.handle('print-html', async (event, { html, title }) => {\n  // E2E-only physical printer substitute; issuance business command remains real.\n  if (process.env.NOVDA_E2E_ARTIFACT === '1' && process.env.NODE_ENV === 'test') return { success: true, physicalPrinter: 'isolated-test-sink' };\n  return new Promise((resolve) => {");
  fs.writeFileSync(mainPath, mainSource, { mode: 0o600 });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(artifact, 'node_modules'), 'junction');
  return artifact;
}

function createCdp(target) {
  assert.equal(typeof WebSocket, 'function', 'Node with built-in WebSocket is required for CDP');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const [requestId, item] of pending) {
      clearTimeout(item.timer);
      pending.delete(requestId);
      item.reject(new Error('CDP_SOCKET_CLOSED'));
    }
  });
  socket.addEventListener('error', () => {
    for (const [requestId, item] of pending) {
      clearTimeout(item.timer);
      pending.delete(requestId);
      item.reject(new Error('CDP_SOCKET_ERROR'));
    }
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return { socket, ready, call(method, params = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        reject(new Error(`CDP_TIMEOUT method=${method} timeoutMs=${timeoutMs}`));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ id: requestId, method, params })); }
      catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error); }
    });
  } };
}

async function closeElectronWindow(cdp, exited, label) {
  // Chromium commonly closes the DevTools websocket before replying to
  // Browser.close. Do not await that protocol response; process exit is the
  // authoritative shutdown signal.
  void cdp.call('Browser.close', {}, 1500).catch(() => {});
  const result = await Promise.race([
    exited,
    delay(10_000).then(() => { throw new Error(`${label}_ELECTRON_EXIT_TIMEOUT`); })
  ]);
  assert.equal(result.code, 0, `${label} Electron exit was not clean: ${JSON.stringify(result)}`);
}

async function activateViaIssuer(pool, apiBase, keyPair, adminApiToken) {
  const request = await waitFor(async () => {
    const result = await pool.query(`SELECT request_id,machine_id,status FROM activation_requests
      WHERE machine_id=$1 ORDER BY requested_at DESC LIMIT 1`, [MACHINE_ID]);
    return result.rows[0]?.status === 'PENDING' ? result.rows[0] : null;
  }, 'real Electron activation request');
  const payload = {
    activationId: crypto.randomUUID(), companyId: COMPANY_ID, companyName: COMPANY_NAME,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), issuedAt: new Date().toISOString(),
    machineId: request.machine_id, requireTicketValidation: PATTA_MODE, role: 'admin',
    schema: 'novda-license-v1', status: 'active'
  };
  const fields = ['activationId', 'companyId', 'companyName', 'expiresAt', 'issuedAt', 'machineId',
    'requireTicketValidation', 'role', 'schema', 'status'];
  const canonical = JSON.stringify(Object.fromEntries(fields.map(field => [field, payload[field]])));
  const signedActivation = { payload, signature: crypto.sign(null, Buffer.from(canonical), keyPair.privateKey).toString('base64') };
  const response = await fetch(`${apiBase}/api/admin/activation/requests/${request.request_id}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-novda-admin-token': adminApiToken },
    body: JSON.stringify({ adminTelegramId: ADMIN_ID, companyId: COMPANY_ID, role: 'admin', signedActivation })
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, `Local issuer approval failed: ${responseText}`);
  const body = JSON.parse(responseText);
  assert.equal(body.request.status, 'APPROVED');
  const replay = await fetch(`${apiBase}/api/admin/activation/requests/${request.request_id}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-novda-admin-token': adminApiToken },
    body: JSON.stringify({ adminTelegramId: ADMIN_ID, companyId: COMPANY_ID, role: 'admin', signedActivation })
  });
  assert.equal(replay.status, 409, 'An already-used activation request must not be approved a second time');
  const replayBody = await replay.json();
  assert.equal(replayBody.error.code, 'ACTIVATION_REQUEST_NOT_PENDING');
  return { request, signedActivation };
}

async function runPattaBusinessWorkflow({ pool, evaluate, profile, proxy }) {
  const clickText = async (text, selector = 'button') => evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})]
    .find(x=>x.getClientRects().length&&x.innerText.trim().includes(${JSON.stringify(text)}));if(!e)return false;e.click();return true})()`);
  const setValue = async (selector, value, index = 0) => evaluate(`(()=>{const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}];if(!e)return false;
    const setter=Object.getOwnPropertyDescriptor(e.constructor.prototype,'value')?.set;setter?setter.call(e,${JSON.stringify(String(value))}):e.value=${JSON.stringify(String(value))};
    e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  const pgModel = async () => (await pool.query('SELECT id,name,operations_json FROM models WHERE company_id=$1 AND name=$2',
    [COMPANY_ID, PATTA_MODEL_NAME])).rows[0] || null;
  const pgWorker = async (name) => (await pool.query('SELECT id,name,status FROM workers WHERE company_id=$1 AND name=$2',
    [COMPANY_ID, name])).rows[0] || null;

  if (await evaluate("Boolean(document.querySelector('button[aria-label=\"Varaqlar menyusini ochish\"]'))")) {
    await evaluate("document.querySelector('button[aria-label=\"Varaqlar menyusini ochish\"]').click()");
    await waitFor(async () => evaluate("[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Model')"), 'model creation control');
  }
  assert.equal(await clickText('Model'), true, 'Model create button was not visible');
  await waitFor(async () => evaluate("[...document.querySelectorAll('input')].some(i=>i.placeholder.includes('Masalan:'))"), 'new model form');
  await setValue('input[placeholder^="Masalan:"]', PATTA_MODEL_NAME);
  assert.equal(await clickText('Modelni Yaratish'), true, 'Model creation form did not submit');
  try { await waitFor(pgModel, 'canonical PostgreSQL model creation', 30_000); }
  catch (error) {
    const db = new (require('better-sqlite3'))(path.join(profile, 'NovdaData', 'companies', COMPANY_ID, 'hisob.sqlite'),
      { readonly: true, fileMustExist: true });
    let localOutbox;
    try { localOutbox = db.prepare(`SELECT command_type,status,entity_id,last_error,error_message
      FROM local_outbox WHERE company_id=? ORDER BY causal_sequence DESC LIMIT 12`).all(COMPANY_ID); }
    finally { db.close(); }
    const serverCommands = (await pool.query(`SELECT command_type,entity_id,accepted_at FROM operations_dedup
      WHERE company_id=$1 ORDER BY accepted_at DESC LIMIT 12`, [COMPANY_ID])).rows;
    const ui = await evaluate('document.body.innerText');
    throw new Error(`${error.message}\nPATTA_DIAGNOSTIC=${JSON.stringify({ ui: ui.slice(-1200), localOutbox, serverCommands,
      localApiRequests: proxy.requests.map(({ method, path: route, online }) => ({ method, path: route, online })).slice(-30) })}`);
  }
  const model = await pgModel();
  const operations = typeof model.operations_json === 'string' ? JSON.parse(model.operations_json) : model.operations_json;
  assert.ok(Array.isArray(operations) && operations.length > 0, 'Created model has no canonical operation');
  const operationName = typeof operations[0] === 'string' ? operations[0] : operations[0].name;
  assert.ok(operationName, 'Canonical model operation name missing');

  const managerButton = 'button[title^="Ishchilar ro\'yxati"]';
  await waitFor(async () => evaluate(`Boolean(document.querySelector(${JSON.stringify(managerButton)}))`), 'worker manager control');
  await evaluate(`document.querySelector(${JSON.stringify(managerButton)}).click()`);
  for (const name of ['Ali', 'Vali']) {
    await waitFor(async () => evaluate("Boolean(document.querySelector('input[placeholder^=\"Yangi ishchi F.I.O\"]'))"), 'worker creation form');
    await setValue('input[placeholder^="Yangi ishchi F.I.O"]', name);
    await clickText("Qo'shish");
    try { await waitFor(() => pgWorker(name), `server-authoritative worker ${name}`, 30_000); }
    catch (error) {
      const db = new (require('better-sqlite3'))(path.join(profile, 'NovdaData', 'companies', COMPANY_ID, 'hisob.sqlite'),
        { readonly: true, fileMustExist: true });
      let outbox;
      try { outbox = db.prepare(`SELECT command_type,status,entity_id,last_error,error_message FROM local_outbox
        WHERE company_id=? ORDER BY causal_sequence DESC LIMIT 12`).all(COMPANY_ID); } finally { db.close(); }
      const ui = await evaluate('document.body.innerText');
      throw new Error(`${error.message}\\nWORKER_DIAGNOSTIC=${JSON.stringify({ name, ui: ui.slice(0, 900), outbox,
        requests: proxy.requests.slice(-18).map(({ method, path: route, online }) => ({ method, path: route, online })) })}`);
    }
  }
  await evaluate("document.querySelector('button[aria-label=\"Oynani yopish\"]')?.click()");
  const ali = await pgWorker('Ali');
  const vali = await pgWorker('Vali');
  assert.ok(ali && vali && ali.id !== vali.id, 'Ali and Vali must be distinct server workers');

  assert.equal(await clickText('Patta chiqarish'), true, 'Could not navigate to Patta issuance');
  await waitFor(async () => evaluate(`Boolean(document.querySelector('[data-model-id="${model.id}"]'))`), 'real model card in Patta issuance');
  const setBatchInputs = await evaluate(`(()=>{const c=document.querySelector('[data-model-id="${model.id}"]');if(!c)return false;
    const nums=[...c.querySelectorAll('input[type=number]')];if(nums.length<2)return false;
    const put=(e,v)=>{const s=Object.getOwnPropertyDescriptor(e.constructor.prototype,'value')?.set;s?s.call(e,String(v)):e.value=String(v);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))};
    put(nums[0],100);const size=[...c.querySelectorAll('.patta-size-box')].find(x=>x.querySelector('.patta-size-label')?.innerText.trim()==='M');if(!size)return false;put(size.querySelector('input'),1);
    const color=c.querySelector('input[placeholder="Rang*"]');if(color)put(color,'Blue');return true})()`);
  assert.equal(setBatchInputs, true, 'Could not set 100 issued units in the real Patta form');
  await waitFor(async () => clickText('Pechat · 1 ta patta'), 'batch print preview control');
  await waitFor(async () => evaluate(`document.body.innerText.includes(${JSON.stringify("Pechat ko'rinishi")})`), 'print preview');
  assert.equal(await clickText('Pechat qilish (1 ta patta)'), true, 'Patta print/issue action was not available');
  const party = await waitFor(async () => {
    const result = await pool.query(`SELECT id,party_number,model_id,patta_count,ish_soni_per_patta,patta_start_number,patta_end_number
      FROM parties WHERE company_id=$1 AND model_id=$2 AND ish_soni_per_patta=100`, [COMPANY_ID, model.id]);
    return result.rows.length === 1 ? result.rows[0] : null;
  }, 'canonical 100-unit patta issuance accepted in PostgreSQL', 40_000);
  assert.equal(Number(party.patta_count), 1);
  assert.equal(Number(party.ish_soni_per_patta), 100);
  assert.ok(Number(party.patta_start_number) > 0 && Number(party.patta_end_number) >= Number(party.patta_start_number));
  const issuanceOutbox = (await pool.query(`SELECT command_type,entity_id FROM operations_dedup
    WHERE company_id=$1 AND command_type='CompletePattaBatch'`, [COMPANY_ID])).rows;
  assert.equal(issuanceOutbox.length, 1, 'Exactly one canonical batch issuance operation must be accepted');

  // The test artifact only substitutes the physical print sink; all issuance
  // commands still execute through React -> IPC -> SQLite -> outbox -> HTTP -> PG.
  const openedModel = await evaluate(`(()=>{const e=[...document.querySelectorAll('.excel-sidebar-model-item')]
    .find(x=>x.innerText.includes(${JSON.stringify(PATTA_MODEL_NAME)}));if(!e)return false;e.click();return true})()`);
  assert.equal(openedModel, true, 'Could not open the issued model sheet');
  await waitFor(async () => evaluate("Boolean(document.querySelector('.phase-b-patta-entry'))"), 'real Patta entry form');
  await setValue('.phase-b-patta-entry input[placeholder="Raqam"]', party.party_number, 0);
  await setValue('.phase-b-patta-entry input[placeholder="Raqam"]', party.patta_start_number, 1);
  await setValue('.patta-info-section input[type=number]', 100);
  const firstWorkerSelector = `select[aria-label=${JSON.stringify(`${operationName} worker 1`)}]`;
  assert.equal(await setValue(firstWorkerSelector, ali.id), true, 'Could not choose Ali for the issued operation');
  await setValue(`input[aria-label=${JSON.stringify(`${operationName} worker 1 quantity`)}]`, 40);
  assert.equal(await clickText("Jo'natish"), true, 'Could not submit Ali’s 40-unit patta allocation');
  let firstTicket;
  try { firstTicket = await waitFor(async () => {
    const row = (await pool.query(`SELECT t.id,t.qty,t.server_revision,t.party_record_id,t.period_id,
        COUNT(te.id)::int entry_count,COALESCE(SUM(te.qty),0)::int allocated
      FROM tickets t LEFT JOIN ticket_entries te ON te.company_id=t.company_id AND te.ticket_id=t.id
      WHERE t.company_id=$1 AND t.party_record_id=$2 AND t.patta_number=$3
      GROUP BY t.company_id,t.id,t.qty,t.server_revision,t.party_record_id,t.period_id`,
    [COMPANY_ID, party.id, party.patta_start_number])).rows[0];
    return row && Number(row.allocated) === 40 ? row : null;
  }, 'server acceptance of Ali’s 40-unit allocation', 40_000); }
  catch (error) {
    const db = new (require('better-sqlite3'))(path.join(profile, 'NovdaData', 'companies', COMPANY_ID, 'hisob.sqlite'),
      { readonly: true, fileMustExist: true });
    let localOutbox;
    try { localOutbox = db.prepare(`SELECT command_type,status,entity_id,last_error,error_message,payload_json
      FROM local_outbox WHERE company_id=? ORDER BY causal_sequence DESC LIMIT 12`).all(COMPANY_ID); }
    finally { db.close(); }
    const accepted = (await pool.query(`SELECT operation_id,command_type,entity_id,result_json FROM operations_dedup
      WHERE company_id=$1 ORDER BY accepted_at DESC LIMIT 12`, [COMPANY_ID])).rows;
    const ui = await evaluate('document.body.innerText');
    throw new Error(`${error.message}\\nALLOCATION_DIAGNOSTIC=${JSON.stringify({ ui: ui.slice(-1400), localOutbox,
      accepted, requests: proxy.requests.slice(-24).map(({ method, path: route, online }) => ({ method, path: route, online })) })}`);
  }
  assert.equal(Number(firstTicket.qty), 100);
  assert.equal(firstTicket.period_id, E2E_PERIOD_ID, 'Server must persist the verified open period selected at initial ticket entry');
  assert.equal(Number(firstTicket.entry_count), 1, 'First allocation must create exactly one work/earning entry');
  const firstEntry = (await pool.query(`SELECT worker_id,qty FROM ticket_entries WHERE company_id=$1 AND ticket_id=$2`,
    [COMPANY_ID, firstTicket.id])).rows[0];
  assert.equal(Number(firstEntry.worker_id), Number(ali.id));
  assert.equal(Number(firstEntry.qty), 40);

  const Database = require('better-sqlite3');
  const sqlitePath = path.join(profile, 'NovdaData', 'companies', COMPANY_ID, 'hisob.sqlite');
  let db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  let acceptedOperationId;
  try {
    const localTicket = db.prepare('SELECT id,qty,status FROM tickets WHERE company_id=? AND id=?').get(COMPANY_ID, firstTicket.id);
    const localEntries = db.prepare('SELECT worker_id,qty FROM ticket_entries WHERE company_id=? AND ticket_id=? ORDER BY rowid').all(COMPANY_ID, firstTicket.id);
    const localSubmit = db.prepare(`SELECT operation_id,status,payload_json FROM local_outbox WHERE company_id=? AND entity_id=? AND command_type='SubmitTicket'`).get(COMPANY_ID, firstTicket.id);
    acceptedOperationId = localSubmit.operation_id;
    assert.equal(Number(localTicket.qty), 100);
    assert.equal(localEntries.reduce((sum, e) => sum + Number(e.qty), 0), 40);
    assert.equal(localSubmit.status, 'SYNCED', 'Ali allocation must be durably accepted, not merely locally saved');
    assert.equal(JSON.parse(localSubmit.payload_json).periodId, E2E_PERIOD_ID,
      'Original durable SubmitTicket payload must retain its verified period ID');
  } finally { db.close(); }

  assert.equal(await clickText('Patta-hisob (jurnal)'), true, 'Could not open Patta journal');
  await waitFor(async () => evaluate(`Boolean([...document.querySelectorAll('.patta-hisob-model-row')].find(b=>b.innerText.includes(${JSON.stringify(PATTA_MODEL_NAME)})))`), 'Patta journal model row');
  await clickText(PATTA_MODEL_NAME, '.patta-hisob-model-row');
  await waitFor(async () => evaluate(`Boolean(document.querySelector('[data-party-id="${party.id}"]'))`), 'issued party row in journal');
  await evaluate(`document.querySelector('[data-party-id="${party.id}"]').click()`);
  await waitFor(async () => evaluate(`Boolean([...document.querySelectorAll('button[title="Tahrirlash"]')].find(b=>b.getClientRects().length))`), 'ticket edit action');
  await evaluate(`([...document.querySelectorAll('button[title="Tahrirlash"]')].find(b=>b.getClientRects().length)).click()`);
  await waitFor(async () => evaluate("document.body.innerText.includes('Patta #')&&document.body.innerText.includes('ni tahrirlash')"), 'single canonical patta allocation editor');
  assert.equal(await clickText('Ishchi taqsimoti qo‘shish'), true, 'Could not add a second worker allocation');
  const idInputs = 'input[placeholder="ID"]';
  await setValue(idInputs, vali.id, 1);
  const qtyInputs = `input[aria-label=${JSON.stringify(`${operationName} allocation quantity`)}]`;
  await setValue(qtyInputs, 61, 1);
  await clickText('Saqlash va hisoblarni yangilash');
  await waitFor(async () => evaluate("document.body.innerText.includes('oshmasligi kerak')"), '101-unit over-allocation rejection');
  const unchangedAfter101 = (await pool.query('SELECT COUNT(*)::int n FROM ticket_entries WHERE company_id=$1 AND ticket_id=$2',
    [COMPANY_ID, firstTicket.id])).rows[0].n;
  assert.equal(unchangedAfter101, 1, 'Over-allocation must not mutate canonical server work');
  await setValue(qtyInputs, 0, 1);
  await clickText('Saqlash va hisoblarni yangilash');
  await waitFor(async () => evaluate("document.body.innerText.includes('musbat butun son')"), 'invalid zero allocation rejection');
  const unchangedAfterInvalid = (await pool.query('SELECT COUNT(*)::int n FROM ticket_entries WHERE company_id=$1 AND ticket_id=$2',
    [COMPANY_ID, firstTicket.id])).rows[0].n;
  assert.equal(unchangedAfterInvalid, 1, 'Invalid allocation must not mutate canonical server work');

  proxy.setOnline(false);
  await setValue(qtyInputs, 60, 1);
  await evaluate("document.querySelectorAll('.toast-item button').forEach(button=>button.click())");
  const offlineSaveClicked = await clickText('Saqlash va hisoblarni yangilash');
  assert.equal(offlineSaveClicked, true, 'Offline allocation save control was not clicked');
  try {
    const saveOutcome = await waitFor(async () => evaluate(`(()=>{
      const modal=document.body.innerText.includes('Patta #${Number(party.patta_start_number)} ni tahrirlash');
      const toast=document.querySelector('.toast-container')?.innerText?.trim()||'';
      return !modal ? {closed:true} : toast ? {closed:false,toast} : null;
    })()`), 'offline allocation save result', 8_000);
    assert.equal(saveOutcome.closed, true, `Offline allocation save was rejected: ${saveOutcome.toast || 'modal remained open'}`);
  }
  catch (error) {
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    let outbox, ticketState, localEntries;
    try {
      outbox = db.prepare(`SELECT command_type,status,entity_id,last_error,error_message,payload_json FROM local_outbox
        WHERE company_id=? ORDER BY causal_sequence DESC LIMIT 10`).all(COMPANY_ID);
      ticketState = db.prepare('SELECT id,qty,status FROM tickets WHERE company_id=? AND id=?')
        .get(COMPANY_ID, firstTicket.id);
      localEntries = db.prepare('SELECT worker_id,qty FROM ticket_entries WHERE ticket_id=? ORDER BY rowid')
        .all(firstTicket.id);
    } finally { db.close(); }
    const ui = await evaluate('document.body.innerText');
    const saveButtons = await evaluate(`([...document.querySelectorAll('button')].filter(b=>b.getClientRects().length)
      .map(b=>({text:b.innerText.trim(),disabled:b.disabled})).filter(b=>b.text.includes('Saqlash')))`) ;
    const toasts = await evaluate("document.querySelector('.toast-container')?.innerText || ''");
    throw new Error(`${error.message}\\nOFFLINE_SAVE_DIAGNOSTIC=${JSON.stringify({ offlineSaveClicked, saveButtons, ui: ui.slice(-1800), outbox, ticketState, localEntries,
      toasts, offlineApiRequests: proxy.requests.filter(r => !r.online).map(({ method, path: route }) => ({ method, path: route })) })}`);
  }
  db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  let pendingUpdate;
  try {
    pendingUpdate = db.prepare(`SELECT operation_id,status,payload_json FROM local_outbox
      WHERE company_id=? AND entity_id=? AND command_type='UpdateTicket' ORDER BY causal_sequence DESC LIMIT 1`).get(COMPANY_ID, firstTicket.id);
    assert.ok(pendingUpdate, 'Offline Vali allocation did not create a durable UpdateTicket outbox command');
    assert.ok(['PENDING', 'SENDING'].includes(pendingUpdate.status), `Offline command unexpectedly has status ${pendingUpdate.status}`);
    const entries = db.prepare('SELECT worker_id,qty FROM ticket_entries WHERE company_id=? AND ticket_id=? ORDER BY rowid').all(COMPANY_ID, firstTicket.id);
    assert.equal(entries.reduce((sum, row) => sum + Number(row.qty), 0), 100);
    assert.deepEqual(entries.map(row => [Number(row.worker_id), Number(row.qty)]).sort((a,b)=>a[0]-b[0]),
      [[Number(ali.id),40],[Number(vali.id),60]].sort((a,b)=>a[0]-b[0]));
  } finally { db.close(); }
  const serverStillFirst = (await pool.query(`SELECT COUNT(*)::int n,COALESCE(SUM(te.qty),0)::int allocated
    FROM tickets t JOIN ticket_entries te ON te.company_id=t.company_id AND te.ticket_id=t.id
    WHERE t.company_id=$1 AND t.id=$2`, [COMPANY_ID, firstTicket.id])).rows[0];
  assert.equal(Number(serverStillFirst.allocated), 40, 'Offline Vali work must remain unaccepted by PostgreSQL');
  assert.ok(proxy.requests.some(r => !r.online && r.path.startsWith('/api/sync/')), 'Offline save did not exercise isolated client connectivity loss');
  return { modelId: model.id, operationName, partyId: party.id, partyNumber: party.party_number,
    pattaNumber: Number(party.patta_start_number), ticketId: firstTicket.id,
    ali: { id: Number(ali.id), name: ali.name, quantity: 40 },
    vali: { id: Number(vali.id), name: vali.name, quantity: 60 },
    acceptedOperationId,
    pendingOperationId: pendingUpdate.operation_id, sqlitePath };
}

async function runCancellationBusinessWorkflow({ pool, evaluate, profile, proxy, priorPattaNumber, modelId, workerId, acceptedOperationId }) {
  const clickText = async (text, selector = 'button') => evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})]
    .find(x=>x.getClientRects().length&&x.innerText.trim().includes(${JSON.stringify(text)}));if(!e)return false;e.click();return true})()`);
  const setValue = async (selector, value, index = 0) => evaluate(`(()=>{const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}];if(!e)return false;
    const setter=Object.getOwnPropertyDescriptor(e.constructor.prototype,'value')?.set;setter?setter.call(e,${JSON.stringify(String(value))}):e.value=${JSON.stringify(String(value))};
    e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);

  // Create a second genuinely issued patta through the real renderer workflow.
  // Its intentionally incorrect allocation quantity creates a server-observed
  // ALLOCATION_REVIEW_REQUIRED candidate; it is never an accepted work fact.
  assert.equal(await clickText('Patta chiqarish'), true, 'Could not reopen the real patta issuance view');
  await waitFor(async () => evaluate(`Boolean(document.querySelector('[data-model-id="${modelId}"]'))`), 'second issued model card');
  const issuanceRuntime = await evaluate('window.electronAPI.getRuntimeMode()');
  assert.equal(issuanceRuntime?.mode, 'sync', `Second patta must use authenticated sync runtime: ${JSON.stringify(issuanceRuntime)}`);
  const batchReady = await evaluate(`(()=>{const c=document.querySelector('[data-model-id="${modelId}"]');if(!c)return false;
    const nums=[...c.querySelectorAll('input[type=number]')];if(nums.length<2)return false;
    const put=(e,v)=>{const s=Object.getOwnPropertyDescriptor(e.constructor.prototype,'value')?.set;s?s.call(e,String(v)):e.value=String(v);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))};
    put(nums[0],100);const size=[...c.querySelectorAll('.patta-size-box')].find(x=>x.querySelector('.patta-size-label')?.innerText.trim()==='M');if(!size)return false;put(size.querySelector('input'),1);
    const color=c.querySelector('input[placeholder="Rang*"]');if(color)put(color,'Blue');return true})()`);
  assert.equal(batchReady, true, 'Could not configure the second disposable 100-unit issuance');
  await waitFor(async () => clickText('Pechat · 1 ta patta'), 'second patta batch preview');
  await waitFor(async () => evaluate(`document.body.innerText.includes(${JSON.stringify("Pechat ko'rinishi")})`), 'second patta print preview');
  // The real print action reserves issuance through the normal command path
  // before opening Electron's physical print dialog; acceptance is verified
  // from the resulting PostgreSQL party record, not from the dialog itself.
  const printButton = await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>x.getClientRects().length&&x.innerText.trim().includes('Pechat qilish (1 ta patta)'));return e?{disabled:e.disabled,text:e.innerText,html:e.outerHTML}:null})()`);
  assert.ok(printButton && !printButton.disabled, `Second patta print button is not actionable: ${JSON.stringify(printButton)}`);
  await evaluate(`(()=>{window.__novdaE2ePrintButtonTransitions=[];const e=[...document.querySelectorAll('button')].find(x=>x.getClientRects().length&&x.innerText.trim().includes('Pechat qilish (1 ta patta)'));if(!e)return false;
    const record=()=>window.__novdaE2ePrintButtonTransitions.push({disabled:e.disabled,text:e.innerText.trim(),at:Date.now()});record();
    new MutationObserver(record).observe(e,{attributes:true,childList:true,subtree:true});return true})()`);
  assert.equal(await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>x.getClientRects().length&&x.innerText.trim().includes('Pechat qilish (1 ta patta)'));if(!e||e.disabled)return false;e.click();return true})()`),
    true, 'Second genuine patta was not issued through the UI');
  let secondParty;
  let issuanceToasts = [];
  try {
    secondParty = await waitFor(async () => {
      const currentToasts = await evaluate("[...document.querySelectorAll('.toast-item')].map(x=>x.innerText)");
      for (const toast of currentToasts) if (!issuanceToasts.includes(toast)) issuanceToasts.push(toast);
      const result = await pool.query(`SELECT id,party_number,patta_start_number,patta_end_number,ish_soni_per_patta
        FROM parties WHERE company_id=$1 AND model_id=$2 AND patta_end_number > $3
        ORDER BY created_at DESC LIMIT 1`, [COMPANY_ID, modelId, priorPattaNumber]);
      return result.rows[0] || null;
    }, 'second canonical patta issuance accepted in PostgreSQL', 40_000);
  } catch (error) {
    const db = new (require('better-sqlite3'))(path.join(profile, 'NovdaData', 'companies', COMPANY_ID, 'hisob.sqlite'),
      { readonly: true, fileMustExist: true });
    let outbox;
    try { outbox = db.prepare(`SELECT command_type,status,entity_id,last_error,error_message,payload_json
      FROM local_outbox WHERE company_id=? ORDER BY rowid DESC LIMIT 20`).all(COMPANY_ID); }
    finally { db.close(); }
    const ui = await evaluate('document.body.innerText');
    const runtime = await evaluate('window.electronAPI.getRuntimeMode()');
    const license = await evaluate('window.electronAPI.getLicenseStatus()');
    const diagnostics = await evaluate(`window.electronAPI.OutboxDiagnostics(${JSON.stringify(COMPANY_ID)})`);
    const toasts = await evaluate("[...document.querySelectorAll('.toast-item')].map(x=>x.innerText)");
    const printTransitions = await evaluate('window.__novdaE2ePrintButtonTransitions || []');
    throw new Error(`${error.message}\nSECOND_ISSUANCE_DIAGNOSTIC=${JSON.stringify({ ui: ui.slice(-1600), outbox, runtime, license, diagnostics, toasts, issuanceToasts, printTransitions, printButton })}`);
  }
  assert.equal(Number(secondParty.ish_soni_per_patta), 100);

  const openedModel = await evaluate(`(()=>{const e=[...document.querySelectorAll('.excel-sidebar-model-item')]
    .find(x=>x.innerText.includes(${JSON.stringify(PATTA_MODEL_NAME)}));if(!e)return false;e.click();return true})()`);
  assert.equal(openedModel, true, 'Could not open the issued model sheet for the review scenario');
  await waitFor(async () => evaluate("Boolean(document.querySelector('.phase-b-patta-entry'))"), 'second real Patta entry form');
  await setValue('.phase-b-patta-entry input[placeholder="Raqam"]', secondParty.party_number, 0);
  await setValue('.phase-b-patta-entry input[placeholder="Raqam"]', secondParty.patta_start_number, 1);
  await setValue('.patta-info-section input[type=number]', 99);
  const operationName = await evaluate(`document.querySelector('.phase-b-patta-entry')?.querySelector('select[aria-label$="worker 1"]')?.getAttribute('aria-label')?.replace(/ worker 1$/,'')`);
  assert.ok(operationName, 'Real patta operation selector is missing');
  assert.equal(await setValue(`select[aria-label=${JSON.stringify(`${operationName} worker 1`)}]`, workerId), true,
    'Could not assign the controlled review operation to the authorized test worker');
  await setValue(`input[aria-label=${JSON.stringify(`${operationName} worker 1 quantity`)}]`, 99);
  assert.equal(await clickText("Jo'natish"), true, 'Could not submit the controlled review allocation');

  const sqlitePath = path.join(profile, 'NovdaData', 'companies', COMPANY_ID, 'hisob.sqlite');
  const Database = require('better-sqlite3');
  const conflict = await waitFor(async () => {
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    try {
    const row = db.prepare(`SELECT operation_id,status,last_error,payload_json,payload_hash,base_revision FROM local_outbox
        WHERE company_id=? AND command_type='SubmitTicket' AND status='CONFLICT'
        ORDER BY causal_sequence DESC LIMIT 1`).get(COMPANY_ID);
      let code;
      try { code = JSON.parse(row?.last_error || '{}').code; } catch { code = row?.last_error; }
      return code === 'ALLOCATION_REVIEW_REQUIRED' ? row : null;
    } finally { db.close(); }
  }, 'genuine server-observed allocation review conflict', 40_000);
  const conflictPayload = JSON.parse(conflict.payload_json);
  assert.equal(conflictPayload.periodId, E2E_PERIOD_ID, 'Review command lost its originally selected verified period');
  const candidate = (await pool.query(`SELECT command_type,entity_id,original_payload_hash,original_payload_json
    FROM allocation_review_candidates WHERE company_id=$1 AND original_operation_id=$2`,
  [COMPANY_ID, conflict.operation_id])).rows[0];
  assert.ok(candidate, 'PostgreSQL did not preserve immutable review evidence for the failed operation');
  assert.equal(candidate.original_payload_hash, conflict.payload_hash);
  assert.equal(JSON.parse(JSON.stringify(candidate.original_payload_json)).periodId, E2E_PERIOD_ID);

  assert.equal(await clickText('Patta-hisob (jurnal)'), true, 'Could not open allocation review panel surface');
  await waitFor(async () => evaluate(`Boolean([...document.querySelectorAll('section')].some(x=>x.getAttribute('aria-label')===${JSON.stringify('Taqsimot nizolarini ko‘rib chiqish')}))`),
    'real AllocationReviewPanel in Electron');
  await waitFor(async () => evaluate(`(()=>{const e=[...document.querySelectorAll('section[aria-label="Taqsimot nizolarini ko‘rib chiqish"] button')]
    .find(x=>x.getClientRects().length&&x.innerText.trim()==='Bekor qilish');return Boolean(e&&!e.disabled)})()`),
    'enabled authorized cancellation action in the real review panel');
  await evaluate("window.prompt=()=> 'Disposable E2E authorized cancellation; no work was accepted' ");
  assert.equal(await clickText('Bekor qilish'), true, 'Authorized accountant cancellation action was not available in the real renderer');
  const cancelled = await waitFor(async () => {
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare(`SELECT op.status,intent.status AS cancellation_status,intent.result_json AS cancellation_result_json
        FROM local_outbox op JOIN allocation_resolution_intents intent
          ON intent.company_id=op.company_id AND intent.original_operation_id=op.operation_id
        WHERE op.company_id=? AND op.operation_id=?`).get(COMPANY_ID, conflict.operation_id);
      return row?.status === 'SUPERSEDED' && row?.cancellation_status === 'ACKNOWLEDGED' ? row : null;
    } finally { db.close(); }
  }, 'server cancellation receipt applied to SQLite', 30_000).catch(async error => {
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    let row, intents;
    try {
      row = db.prepare('SELECT status,last_error FROM local_outbox WHERE company_id=? AND operation_id=?').get(COMPANY_ID, conflict.operation_id);
      intents = db.prepare('SELECT * FROM allocation_resolution_intents WHERE company_id=?').all(COMPANY_ID);
    } finally { db.close(); }
    throw new Error(`${error.message}\nCANCELLATION_DIAGNOSTIC=${JSON.stringify({ row, intents, ui: (await evaluate('document.body.innerText')).slice(-1200) })}`);
  });
  assert.equal(cancelled.cancellation_status, 'ACKNOWLEDGED');
  const serverEvidence = (await pool.query(`SELECT f.original_operation_id,f.original_payload_hash,f.resolution_operation_id,
      f.action,f.actor_id,f.original_payload_json,a.reviewer_id,a.resulting_status,a.reason,a.details_json
    FROM allocation_resolution_fences f JOIN allocation_resolution_audit a
      ON a.company_id=f.company_id AND a.original_operation_id=f.original_operation_id
      AND a.resolution_operation_id=f.resolution_operation_id
    WHERE f.company_id=$1 AND f.original_operation_id=$2`, [COMPANY_ID, conflict.operation_id])).rows;
  assert.equal(serverEvidence.length, 1, 'Cancellation must atomically create exactly one fence and audit record');
  assert.equal(serverEvidence[0].action, 'CANCEL');
  assert.equal(serverEvidence[0].actor_id, OPERATOR_ID);
  assert.equal(serverEvidence[0].reviewer_id, OPERATOR_ID);
  assert.equal(serverEvidence[0].resulting_status, 'CANCELLED');
  assert.equal(serverEvidence[0].original_payload_hash, conflict.payload_hash);
  assert.equal(serverEvidence[0].original_payload_json.periodId, E2E_PERIOD_ID);

  const retry = await evaluate(`window.electronAPI.AllocationReviewRetry({companyId:${JSON.stringify(COMPANY_ID)},operationId:${JSON.stringify(conflict.operation_id)}})`);
  assert.equal(retry?.success, false, 'A cancelled original command must not be requeued by the real Electron IPC');
  assert.match(proxy.deviceAuthorization || '', /^Bearer /, 'Replay verification requires the real device authorization observed from Electron HTTP traffic');
  const staleReplay = await fetch(`${proxy.baseUrl}/api/sync/operations`, {
    method: 'POST', headers: { authorization: proxy.deviceAuthorization, 'content-type': 'application/json' },
    body: JSON.stringify({ operations: [{ operationId: conflict.operation_id, companyId: COMPANY_ID,
      commandType: 'SubmitTicket', entityType: 'ticket', entityId: conflictPayload.ticketId,
      baseRevision: conflict.base_revision, payload: conflictPayload, payloadHash: conflict.payload_hash }] })
  });
  assert.equal(staleReplay.status, 200, 'Authenticated stale replay should receive a definitive server fence response');
  const staleReplayBody = await staleReplay.json();
  assert.equal(staleReplayBody.results?.[0]?.status, 'REJECTED');
  assert.equal(staleReplayBody.results?.[0]?.error?.code, 'ALLOCATION_CANCELLED');
  const noEarnings = (await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM tickets WHERE company_id=$1 AND id=$2) AS tickets,
    (SELECT COUNT(*)::int FROM ticket_entries WHERE company_id=$1 AND ticket_id=$2) AS entries`,
  [COMPANY_ID, conflictPayload.ticketId])).rows[0];
  assert.deepEqual(noEarnings, { tickets: 0, entries: 0 }, 'Cancelled review command must create no ticket earnings');
  const acceptedCancellation = await evaluate(`window.electronAPI.AllocationReviewCancel({companyId:${JSON.stringify(COMPANY_ID)},operationId:${JSON.stringify(acceptedOperationId)},reason:'must not cancel accepted work'})`);
  assert.equal(acceptedCancellation?.success, false, 'Real cancellation IPC must reject already accepted ticket work');
  assert.equal(acceptedCancellation?.code, 'ALLOCATION_NOT_CANCELLABLE',
    'Electron must refuse to create a cancellation intent for a server-accepted operation');
  assert.equal(Number((await pool.query(`SELECT COUNT(*)::int n FROM allocation_resolution_fences
    WHERE company_id=$1 AND original_operation_id=$2`, [COMPANY_ID, acceptedOperationId])).rows[0].n), 0,
  'Accepted work cancellation attempt must not create a fence');
  return { operationId: conflict.operation_id, ticketId: conflictPayload.ticketId, periodId: conflictPayload.periodId,
    status: 'CANCELLED', receipt: JSON.parse(cancelled.cancellation_result_json || '{}'),
    serverAuditAndFenceRows: serverEvidence.length, reviewerId: OPERATOR_ID, retryRejected: true, noTicketOrEarnings: true };
}

async function main() {
  activeStage = 'environment-preflight';
  if (process.env.DATABASE_URL || process.env.NOVDA_PG_URL) {
    throw new Error('Refusing inherited database environment; the E2E runner provisions its own PG16 target');
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-electron-e2e-'));
  const outputDir = path.join(tempDir, 'evidence');
  fs.mkdirSync(outputDir);
  let container, pool, api, proxy, electron, cdp;
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyFingerprint = crypto.createHash('sha256').update(keyPair.privateKey.export({ type: 'pkcs8', format: 'der' })).digest('hex');
  try {
    activeStage = 'start-disposable-postgres';
    container = await startPostgres(tempDir);
    const targetEnv = { ...process.env, NOVDA_PG_URL: container.url, NOVDA_DISPOSABLE_PG: '1' };
    delete targetEnv.DATABASE_URL;
    const { verifyFreshPostgres16TestEnvironment } = require('../verify/database/verify-pg16-test-env.cjs');
    await verifyFreshPostgres16TestEnvironment(container.url, { env: targetEnv });
    pool = new Pool({ connectionString: container.url, max: 8 });
    const { initServerDatabase } = require('../../apps/server/infrastructure/db.cjs');
    const { buildFastifyServer } = require('../../apps/server/app.cjs');
    activeStage = 'initialize-postgres-and-local-api';
    await initServerDatabase({ pool });
    const adminApiToken = crypto.randomBytes(32).toString('hex');
    const env = { NODE_ENV: 'test', NOVDA_PG_URL: container.url, NOVDA_DISPOSABLE_PG: '1',
      HOST: '127.0.0.1', ALLOW_TEST_TOKENS: 'false', LOG_LEVEL: 'silent' };
    await pool.query('INSERT INTO company_batch_settings(company_id) VALUES($1)', [COMPANY_ID]);
    if (PATTA_MODE) {
      // The worker-create authority requires an imported clean baseline. This
      // is a test-only empty ledger fixture for this freshly-created company,
      // not a claim about production history or trusted issuance evidence.
      const emptyBaseline = JSON.stringify({ fixture: 'novda-patta-e2e-empty-baseline-v1', companyId: COMPANY_ID,
        workers: [], models: [], parties: [], tickets: [], ticketEntries: [], adjustments: [] });
      const sourceSnapshotHash = crypto.createHash('sha256').update(emptyBaseline).digest('hex');
      const decidedAt = new Date().toISOString();
      await pool.query(`INSERT INTO migration_baseline_decisions
        (baseline_decision_id,company_id,decision,scope_json,source_path,source_size,source_mtime,source_snapshot_hash,decided_at)
        VALUES ($1,$2,'CLEAN_PRODUCTION_LEDGER_BASELINE',$3::jsonb,$4,$5,$6,$7,$8)`,
      [`${COMPANY_ID}:e2e-empty-baseline-v1`, COMPANY_ID,
        JSON.stringify({ fixture: true, entities: ['workers','models','parties','tickets','ticket_entries','adjustments'],
          counts: { workers: 0, models: 0, parties: 0, tickets: 0, ticketEntries: 0, adjustments: 0 } }),
        `novda-e2e://disposable/${COMPANY_ID}/empty-baseline-v1`, Buffer.byteLength(emptyBaseline), decidedAt,
        sourceSnapshotHash, decidedAt]);
      await pool.query(`INSERT INTO baseline_import_runs
        (baseline_import_run_id,company_id,source_snapshot_hash,baseline_decision_id,status,imported_at)
        VALUES ($1,$2,$3,$4,'APPLIED',$5)`,
      [`${COMPANY_ID}:e2e-empty-baseline-import-v1`, COMPANY_ID, sourceSnapshotHash,
        `${COMPANY_ID}:e2e-empty-baseline-v1`, decidedAt]);
      // A valid disposable open accounting period is part of the test fixture,
      // not inferred from ticket timestamps. Bootstrap makes it available to
      // the real renderer before the ticket is entered.
      await pool.query(`INSERT INTO periods (id, company_id, start_date, end_date, is_closed)
        VALUES ($1, $2, '2026-01-01', NULL, 0)`, [E2E_PERIOD_ID, COMPANY_ID]);
    }
    await pool.query(`INSERT INTO activation_companies(company_id,company_name,allowed_roles,require_ticket_validation,
      is_active,updated_by_telegram_id) VALUES($1,$2,ARRAY['admin']::text[],$4,true,$3)`,
    [COMPANY_ID, COMPANY_NAME, ADMIN_ID, PATTA_MODE]);
    api = buildFastifyServer({ pool, env, adminApiToken, allowedAdminIds: new Set([ADMIN_ID]),
      licensePublicKey: publicKey, logger: false,
      // This API and PG cluster are freshly created disposable E2E fixtures.
      // Production defaults remain fail-closed; only the isolated test server permits writes.
      businessMutationsEnabled: true });
    const apiAddress = await api.listen({ host: '127.0.0.1', port: 0 });
    const apiBase = apiAddress.replace(/\/$/, '');
    assert.ok(apiBase.startsWith('http://127.0.0.1:'), `Unexpected API listener: ${apiBase}`);
    if (PATTA_MODE) {
      const { provisionOperator } = require('../../apps/server/auth/operatorAuth.cjs');
      await provisionOperator(pool, { operatorId: OPERATOR_ID, companyId: COMPANY_ID,
        displayName: 'Disposable E2E Accountant', role: 'accountant', password: OPERATOR_PASSWORD });
    }
    proxy = await startLoopbackProxy(apiBase);

    activeStage = 'build-isolated-electron-artifact';
    const artifact = makeArtifact(tempDir, publicKey);
    const junction = path.join(artifact, 'node_modules');
    const buildEnv = { ...process.env, NODE_ENV: 'test', DATABASE_URL: '', NOVDA_PG_URL: '' };
    for (const [label, script] of [['TypeScript', 'typescript/bin/tsc'], ['Vite', 'vite/bin/vite.js']]) {
      const args = [path.join(junction, script), ...(label === 'Vite' ? ['build'] : [])];
      const build = spawnSync(process.execPath, args, { cwd: artifact, env: buildEnv,
        encoding: 'utf8', timeout: 300_000 });
      assert.equal(build.status, 0, `Isolated Electron ${label} build failed:\n${build.stdout}\n${build.stderr}`);
    }
    assert.ok(fs.lstatSync(junction).isSymbolicLink(), 'Dependencies must be linked read-only from the current repository install');

    // Production trust remains unchanged and must reject this run's test key.
    const prodLicense = require('../../apps/desktop/electron/license/license.cjs');
    const testArtifactLicense = require(path.join(artifact, 'apps/desktop/electron/license/license.cjs'));
    const samplePayload = { activationId: crypto.randomUUID(), companyId: COMPANY_ID, companyName: COMPANY_NAME,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), issuedAt: new Date().toISOString(), machineId: MACHINE_ID,
      requireTicketValidation: false, role: 'admin', schema: 'novda-license-v1', status: 'active' };
    const canonicalFields = ['activationId', 'companyId', 'companyName', 'expiresAt', 'issuedAt', 'machineId',
      'requireTicketValidation', 'role', 'schema', 'status'];
    const sampleSignature = crypto.sign(null, Buffer.from(JSON.stringify(Object.fromEntries(canonicalFields.map(k => [k, samplePayload[k]])))), keyPair.privateKey).toString('base64');
    const sample = { payload: samplePayload, signature: sampleSignature };
    activeStage = 'verify-test-key-rejection-and-negative-cases';
    assert.equal(testArtifactLicense.verifyActivationRecord(MACHINE_ID, sample).valid, true);
    assert.equal(prodLicense.verifyActivationRecord(MACHINE_ID, sample).valid, false, 'Production trust must reject E2E key');
    assert.equal(testArtifactLicense.verifyActivationRecord(MACHINE_ID, { ...sample, signature: 'A'.repeat(88) }).valid, false);
    assert.equal(testArtifactLicense.verifyActivationRecord('BEEF-BEEF-BEEF-BEEF', sample).valid, false);
    const expired = { ...sample, payload: { ...samplePayload, expiresAt: new Date(Date.now() - 60_000).toISOString() } };
    expired.signature = crypto.sign(null, Buffer.from(JSON.stringify(Object.fromEntries(canonicalFields.map(k => [k, expired.payload[k]])))), keyPair.privateKey).toString('base64');
    assert.equal(testArtifactLicense.verifyActivationRecord(MACHINE_ID, expired).valid, false);
    const untrusted = crypto.generateKeyPairSync('ed25519');
    const untrustedSignature = crypto.sign(null, Buffer.from(JSON.stringify(Object.fromEntries(canonicalFields.map(k => [k, samplePayload[k]])))), untrusted.privateKey).toString('base64');
    assert.equal(testArtifactLicense.verifyActivationRecord(MACHINE_ID, { payload: samplePayload, signature: untrustedSignature }).valid, false);

    activeStage = 'launch-first-electron-process';
    const debugPort = await unusedPort();
    const electronPath = require(path.join(ROOT, 'node_modules/electron'));
    assert.ok(fs.existsSync(electronPath), 'Electron executable unavailable');
    const profile = path.join(tempDir, 'isolated-user-data');
    fs.mkdirSync(profile);
    const electronEnv = { ...process.env, NODE_ENV: 'test', NOVDA_E2E_ARTIFACT: '1', NOVDA_SYNC_ENABLED: '1',
      NOVDA_SYNC_SERVER_URL: proxy.baseUrl, NOVDA_LICENSE_ED25519_PUBLIC_KEY: '',
      // Remove any inherited production endpoints and credentials.
      DATABASE_URL: '', NOVDA_PG_URL: '', NOVDA_API_TOKEN: '', NOVDA_ADMIN_API_TOKEN: '',
      HTTPS_PROXY: '', HTTP_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' };
    electron = spawn(electronPath, [artifact, `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${debugPort}`, '--no-first-run'], { cwd: artifact, env: electronEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    electron.stdout.on('data', chunk => { logs += chunk; });
    electron.stderr.on('data', chunk => { logs += chunk; });
    electron.on('error', error => { logs += `\nSPAWN_ERROR ${error.stack || error}`; });
    const exited = new Promise(resolve => electron.once('exit', (code, signal) => resolve({ code, signal })));
    let target;
    try { target = await waitFor(async () => {
      if (electron.exitCode !== null) throw new Error(`Electron exited before window: ${logs.slice(-1000)}`);
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
      if (!response?.ok) return null;
      return (await response.json()).find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl) || null;
    }, 'actual Electron renderer'); }
    catch (error) { throw new Error(`${error.message}\nElectron log:\n${logs.slice(-5000)}`); }
    cdp = createCdp(target);
    await cdp.ready;
    const pending = new Map();
    // CDP requests issued through call() are already correlated; enable domains
    // and drive the real preload API/UI, not a renderer replacement.
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    const evaluate = async expression => {
      const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert.ok(!result.exceptionDetails, `Renderer expression failed: ${JSON.stringify(result.exceptionDetails)}`);
      return result.result.value;
    };
    await waitFor(async () => (await evaluate('document.body.innerText')).length > 20, 'rendered NOVDA UI');
    const preActivation = await evaluate('window.electronAPI.getLicenseStatus()');
    assert.equal(preActivation.isActivated, false, 'Missing activation must remain unlicensed');
    assert.equal(preActivation.deviceCredentialReady, undefined, 'Missing device credential cannot be reported ready');
    assert.equal(fs.existsSync(path.join(profile, 'credentials', `${COMPANY_ID}.enc.json`)), false,
      'Unactivated profile must not have a device credential');
    const activation = await activateViaIssuer(pool, apiBase, keyPair, adminApiToken);
    assert.equal(activation.request.machine_id, MACHINE_ID);
    // Trigger the supported UI status action; it invokes license-status IPC,
    // real local API request/approval lookup, signature verification, safeStorage
    // provisioning, and device credential persistence.
    await waitFor(async () => evaluate(`[...document.querySelectorAll('button')].some(x=>x.innerText.includes('Holatni tekshirish'))`),
      'visible supported activation status control');
    activeStage = 'complete-activation-through-renderer-ipc';
    const activated = await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('Holatni tekshirish'));if(!b)return false;b.click();return true})()`);
    assert.equal(activated, true, `Activation control missing from renderer: ${await evaluate('document.body.innerText')}`);
    const activationStatus = await waitFor(async () => {
      const value = await evaluate('window.electronAPI.getLicenseStatus()');
      return value?.isActivated && value?.deviceCredentialReady ? value : null;
    }, 'valid signed activation and provisioned OS-encrypted device credential', 40_000);
    assert.equal(activationStatus.companyId, COMPANY_ID);
    assert.equal(activationStatus.machineId, MACHINE_ID);
    const uiText = await evaluate('document.body.innerText');
    assert.match(uiText, /NOVDA Disposable E2E/, `Actual renderer did not show activated disposable company. UI: ${uiText}`);
    assert.match(uiText, /Patta|Патта|Патта ҳисоб|Patta Hisob/i, 'Authenticated application did not expose the Patta workflow');
    let pattaResult = null;
    if (PATTA_MODE) {
      activeStage = 'restore-disposable-accountant-session';
      await waitFor(async () => {
        const readiness = await evaluate(`window.electronAPI.OutboxDiagnostics(${JSON.stringify(COMPANY_ID)})`);
        return readiness?.success === true ? readiness : null;
      }, 'authoritative bootstrap and outbox IPC readiness', 45_000);
      const operatorLogin = await evaluate(`window.electronAPI.OperatorLogin(${JSON.stringify(COMPANY_ID)}, ${JSON.stringify(OPERATOR_ID)}, ${JSON.stringify(OPERATOR_PASSWORD)})`);
      assert.equal(operatorLogin?.success, true, `Supported operator session login failed: ${JSON.stringify(operatorLogin)}`);
      activeStage = 'real-electron-patta-issuance-and-first-allocation';
      pattaResult = await runPattaBusinessWorkflow({ pool, evaluate, profile, proxy });
    }
    const dataDir = path.join(profile, 'NovdaData');
    assert.ok(fs.existsSync(dataDir), 'Isolated business data directory was not created');
    assert.ok(fs.existsSync(path.join(profile, 'credentials', `${COMPANY_ID}.enc.json`)), 'Device credential not encrypted into isolated profile');
    const encryptedCredential = JSON.parse(fs.readFileSync(path.join(profile, 'credentials', `${COMPANY_ID}.enc.json`), 'utf8'));
    assert.match(encryptedCredential.encryptedCredential, /^[a-f0-9]+$/i, 'safeStorage credential must be stored as ciphertext');
    assert.equal(Object.hasOwn(encryptedCredential, 'credential'), false, 'Device credential file must not contain plaintext credentials');

    activeStage = 'close-first-electron-process';
    await closeElectronWindow(cdp, exited, 'FIRST');
    electron = null;
    cdp.socket.close(); cdp = null;

    activeStage = 'restart-electron-with-same-profile';
    const secondPort = await unusedPort();
    electron = spawn(electronPath, [artifact, `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${secondPort}`, '--no-first-run'], { cwd: artifact, env: electronEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let restartLogs = '';
    electron.stdout.on('data', chunk => { restartLogs += chunk; });
    electron.stderr.on('data', chunk => { restartLogs += chunk; });
    const restartExit = new Promise(resolve => electron.once('exit', (code, signal) => resolve({ code, signal })));
    const secondTarget = await waitFor(async () => {
      if (electron.exitCode !== null) throw new Error(`Restarted Electron exited: ${restartLogs.slice(-1000)}`);
      const response = await fetch(`http://127.0.0.1:${secondPort}/json/list`).catch(() => null);
      if (!response?.ok) return null;
      return (await response.json()).find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl) || null;
    }, 'restarted Electron renderer');
    cdp = createCdp(secondTarget);
    await cdp.ready;
    await cdp.call('Runtime.enable');
    const evaluate2 = async expression => {
      const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 20_000);
      assert.ok(!result.exceptionDetails, `Restart renderer expression failed: ${JSON.stringify(result.exceptionDetails)}`);
      return result.result.value;
    };
    let finalElectronExit = restartExit;
    let finalEvaluate = evaluate2;
    activeStage = 'verify-restart-activation-and-device-binding';
    let restartedStatus;
    try {
      restartedStatus = await waitFor(async () => {
        const value = await evaluate2('window.electronAPI.getLicenseStatus()');
        return value?.isActivated ? value : null;
      }, 'persisted activation and device credential after process restart', 40_000);
      const restartReadiness = await waitFor(async () => {
        const value = await evaluate2(`window.electronAPI.OutboxDiagnostics(${JSON.stringify(COMPANY_ID)})`);
        return value?.success === true ? value : null;
      }, 'device credential and sync runtime readiness after process restart', 30_000);
      assert.equal(restartReadiness.success, true);
    } catch (error) {
      const statusProbe = await evaluate2('window.electronAPI.getLicenseStatus()').catch(cause => ({ error: cause.message }));
      const rendererProbe = await evaluate2('document.body.innerText').catch(cause => cause.message);
      throw new Error(`${error.message}\nRESTART_DIAGNOSTIC=${JSON.stringify({
        processExitCode: electron.exitCode, logs: restartLogs.slice(-3000),
        statusProbe, rendererText: typeof rendererProbe === 'string' ? rendererProbe.slice(0, 1200) : rendererProbe,
        profileCredentialExists: fs.existsSync(path.join(profile, 'credentials', `${COMPANY_ID}.enc.json`)),
        sqliteExists: fs.existsSync(pattaResult?.sqlitePath || '')
      })}`);
    }
    assert.equal(restartedStatus.companyId, COMPANY_ID);
    assert.equal(restartedStatus.machineId, MACHINE_ID);
    const restartUi = await waitFor(async () => {
      const text = await evaluate2('document.body.innerText');
      return /NOVDA Disposable E2E/.test(text) ? text : null;
    }, 'authenticated company UI after restart', 20_000);
    assert.match(restartUi, /NOVDA Disposable E2E/);
    if (PATTA_MODE) {
      activeStage = 'verify-offline-allocation-restart-restoration';
      const sqlite = new (require('better-sqlite3'))(pattaResult.sqlitePath, { readonly: true, fileMustExist: true });
      try {
        const pending = sqlite.prepare('SELECT status,payload_json FROM local_outbox WHERE company_id=? AND operation_id=?')
          .get(COMPANY_ID, pattaResult.pendingOperationId);
        assert.ok(pending && ['PENDING', 'SENDING'].includes(pending.status),
          `Restart did not preserve the offline Vali command: ${JSON.stringify(pending)}`);
        const payload = JSON.parse(pending.payload_json);
        assert.ok(payload.entries.some(entry => Number(entry.workerId) === pattaResult.vali.id && Number(entry.qty) === 60),
          'Restarted pending command lost Vali’s 60-unit allocation');
        const localEntries = sqlite.prepare('SELECT worker_id,qty FROM ticket_entries WHERE company_id=? AND ticket_id=? ORDER BY rowid')
          .all(COMPANY_ID, pattaResult.ticketId);
        assert.equal(localEntries.reduce((sum, entry) => sum + Number(entry.qty), 0), 100,
          'Restarted SQLite ticket projection must retain exactly 100 allocated units');
      } finally { sqlite.close(); }
      const beforeReconnect = (await pool.query(`SELECT COALESCE(SUM(te.qty),0)::int allocated FROM ticket_entries te
        WHERE te.company_id=$1 AND te.ticket_id=$2`, [COMPANY_ID, pattaResult.ticketId])).rows[0];
      assert.equal(Number(beforeReconnect.allocated), 40, 'PostgreSQL must remain unchanged while the client is offline');
      proxy.dropNextSyncResponse();
      proxy.setOnline(true);
      activeStage = 'reconnect-accept-and-replay-after-lost-response';
      const lostAckDispatch = await evaluate2(`window.electronAPI.SyncDispatch(${JSON.stringify(COMPANY_ID)})`);
      assert.equal(lostAckDispatch?.success, true, `Initial reconnect dispatch failed: ${JSON.stringify(lostAckDispatch)}`);
      assert.ok(proxy.requests.some(request => request.path === '/api/sync/operations' && request.online),
        'Restored client did not dispatch the persisted outbox command through the local API');
      await waitFor(async () => {
        const accepted = await pool.query(`SELECT d.operation_id,d.command_type,d.server_revision
          FROM operations_dedup d WHERE d.company_id=$1 AND d.operation_id=$2`, [COMPANY_ID, pattaResult.pendingOperationId]);
        return accepted.rows[0] || null;
      }, 'server acceptance despite dropped acknowledgement', 45_000);
      // The proxy deliberately destroys the first accepted response. Explicitly
      // kick the supported outbox dispatcher so this step proves idempotent
      // status/replay recovery rather than depending on a background timer race.
      const replayDispatch = await evaluate2(`window.electronAPI.SyncDispatch(${JSON.stringify(COMPANY_ID)})`);
      assert.equal(replayDispatch?.success, true, `Supported outbox replay dispatch failed: ${JSON.stringify(replayDispatch)}`);
      try {
        await waitFor(async () => {
          const db = new (require('better-sqlite3'))(pattaResult.sqlitePath, { readonly: true, fileMustExist: true });
          try { return db.prepare(`SELECT status,last_error,error_message,attempt_count,payload_json FROM local_outbox
            WHERE company_id=? AND operation_id=?`).get(COMPANY_ID, pattaResult.pendingOperationId)?.status === 'SYNCED'; }
          finally { db.close(); }
        }, 'outbox replay acknowledgement and local reconciliation', 45_000);
      } catch (error) {
        const db = new (require('better-sqlite3'))(pattaResult.sqlitePath, { readonly: true, fileMustExist: true });
        let row, cursor;
        try {
          row = db.prepare(`SELECT status,last_error,error_message,attempt_count,payload_json FROM local_outbox
            WHERE company_id=? AND operation_id=?`).get(COMPANY_ID, pattaResult.pendingOperationId);
          cursor = db.prepare('SELECT value FROM local_meta WHERE key=?').get('sync_cursor');
        } finally { db.close(); }
        const server = (await pool.query(`SELECT result_json FROM operations_dedup WHERE company_id=$1 AND operation_id=$2`,
          [COMPANY_ID, pattaResult.pendingOperationId])).rows[0] || null;
        throw new Error(`${error.message}\\nREPLAY_DIAGNOSTIC=${JSON.stringify({ row: row && { ...row, payload_json: undefined },
          cursor, server, requests: proxy.requests.slice(-40).map(({ method, path: route, online }) => ({ method, path: route, online })) })}`);
      }
      const acceptedRows = (await pool.query(`SELECT w.name,te.worker_id,te.qty,t.qty AS issued_qty,t.server_revision
        FROM ticket_entries te JOIN tickets t ON t.company_id=te.company_id AND t.id=te.ticket_id
        JOIN workers w ON w.company_id=te.company_id AND w.id=te.worker_id
        WHERE te.company_id=$1 AND t.id=$2 ORDER BY te.worker_id`, [COMPANY_ID, pattaResult.ticketId])).rows;
      assert.equal(acceptedRows.length, 2, 'Server must contain exactly two worker allocation entries');
      assert.deepEqual(acceptedRows.map(row => [row.name, Number(row.qty)]).sort((a,b)=>a[0].localeCompare(b[0])),
        [['Ali',40],['Vali',60]].sort((a,b)=>a[0].localeCompare(b[0])));
      assert.equal(acceptedRows.reduce((sum, row) => sum + Number(row.qty), 0), 100);
      assert.ok(acceptedRows.every(row => Number(row.issued_qty) === 100));
      const duplicateCounts = (await pool.query(`SELECT COUNT(DISTINCT t.id)::int tickets,COUNT(DISTINCT te.id)::int entries,
          COALESCE(SUM(te.qty),0)::int allocated
        FROM tickets t JOIN ticket_entries te ON te.company_id=t.company_id AND te.ticket_id=t.id
        WHERE t.company_id=$1 AND t.party_record_id=$2 AND t.patta_number=$3`,
      [COMPANY_ID, pattaResult.partyId, pattaResult.pattaNumber])).rows[0];
      if (Number(duplicateCounts.tickets) !== 1) {
        const ticketRows = (await pool.query(`SELECT t.id,t.party_number,t.party_record_id,t.patta_number,t.qty,t.status,
            COUNT(te.id)::int entry_count,COALESCE(SUM(te.qty),0)::int allocated
          FROM tickets t LEFT JOIN ticket_entries te ON te.company_id=t.company_id AND te.ticket_id=t.id
          WHERE t.company_id=$1 AND t.party_record_id=$2 AND t.patta_number=$3
          GROUP BY t.company_id,t.id,t.party_number,t.party_record_id,t.patta_number,t.qty,t.status ORDER BY t.id`,
        [COMPANY_ID, pattaResult.partyId, pattaResult.pattaNumber])).rows;
        const submissions = (await pool.query(`SELECT operation_id,entity_id,payload_hash,result_json,accepted_at
          FROM operations_dedup WHERE company_id=$1 AND command_type='SubmitTicket'
          ORDER BY accepted_at`, [COMPANY_ID])).rows;
        throw new Error(`Duplicate canonical ticket rows: ${JSON.stringify({ duplicateCounts, ticketRows, submissions })}`);
      }
      assert.deepEqual({ tickets: duplicateCounts.tickets, allocated: duplicateCounts.allocated }, { tickets: 1, allocated: 100 });
      const acceptedChange = (await pool.query(`SELECT operation_id,entity_revision FROM change_log
        WHERE company_id=$1 AND operation_id=$2`, [COMPANY_ID, pattaResult.pendingOperationId])).rows;
      assert.equal(acceptedChange.length, 1, 'Dropped response replay must produce one server change-feed event');
      const localFinal = new (require('better-sqlite3'))(pattaResult.sqlitePath, { readonly: true, fileMustExist: true });
      try {
        const finalEntries = localFinal.prepare('SELECT worker_id,qty FROM ticket_entries WHERE company_id=? AND ticket_id=? ORDER BY rowid').all(COMPANY_ID, pattaResult.ticketId);
        const pendingCount = localFinal.prepare("SELECT COUNT(*) n FROM local_outbox WHERE company_id=? AND status IN ('PENDING','SENDING')").get(COMPANY_ID).n;
        assert.equal(finalEntries.reduce((sum, row) => sum + Number(row.qty), 0), 100);
        assert.equal(pendingCount, 0, 'Successful reconciliation must leave no pending commands');
      } finally { localFinal.close(); }
      pattaResult.finalServerAllocations = acceptedRows.map(row => ({ worker: row.name, quantity: Number(row.qty) }));
      pattaResult.serverRevision = Number(acceptedRows[0].server_revision);
      pattaResult.changeFeedEventsForReplay = acceptedChange.length;
      pattaResult.pendingCommandsAfterReconcile = 0;
      activeStage = 'real-electron-authorized-allocation-cancellation';
      pattaResult.cancellation = await runCancellationBusinessWorkflow({ pool, evaluate: evaluate2, profile,
        proxy,
        priorPattaNumber: pattaResult.pattaNumber,
        modelId: pattaResult.modelId, workerId: pattaResult.ali.id,
        acceptedOperationId: pattaResult.acceptedOperationId });
      activeStage = 'restart-electron-and-verify-cancellation-convergence';
      await closeElectronWindow(cdp, restartExit, 'POST_CANCEL');
      electron = null;
      cdp.socket.close(); cdp = null;
      const thirdPort = await unusedPort();
      electron = spawn(electronPath, [artifact, `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${thirdPort}`, '--no-first-run'], { cwd: artifact, env: electronEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let thirdLogs = '';
      electron.stdout.on('data', chunk => { thirdLogs += chunk; });
      electron.stderr.on('data', chunk => { thirdLogs += chunk; });
      finalElectronExit = new Promise(resolve => electron.once('exit', (code, signal) => resolve({ code, signal })));
      const thirdTarget = await waitFor(async () => {
        if (electron.exitCode !== null) throw new Error(`Post-cancellation Electron exited: ${thirdLogs.slice(-1000)}`);
        const response = await fetch(`http://127.0.0.1:${thirdPort}/json/list`).catch(() => null);
        if (!response?.ok) return null;
        return (await response.json()).find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl) || null;
      }, 'post-cancellation Electron renderer');
      cdp = createCdp(thirdTarget);
      await cdp.ready;
      await cdp.call('Runtime.enable');
      finalEvaluate = async expression => {
        const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 20_000);
        assert.ok(!result.exceptionDetails, `Post-cancellation renderer expression failed: ${JSON.stringify(result.exceptionDetails)}`);
        return result.result.value;
      };
      await waitFor(async () => {
        const value = await finalEvaluate(`window.electronAPI.OutboxDiagnostics(${JSON.stringify(COMPANY_ID)})`);
        return value?.success === true ? value : null;
      }, 'post-cancellation SQLite/bootstrap readiness', 40_000);
      const restoredConflicts = await finalEvaluate(`window.electronAPI.AllocationReviewList({companyId:${JSON.stringify(COMPANY_ID)}})`);
      assert.equal(restoredConflicts?.success, true);
      const cancelledOperationId = pattaResult.cancellation.operationId;
      assert.equal(restoredConflicts.conflicts.find(row=>row.operation_id===cancelledOperationId)?.status,
        'SUPERSEDED', 'Cancelled command state must survive same-profile restart');
      const restoredHistory = await finalEvaluate(`window.electronAPI.AllocationReviewHistory({companyId:${JSON.stringify(COMPANY_ID)},operationId:${JSON.stringify(pattaResult.cancellation.operationId)}})`);
      assert.ok(restoredHistory?.history?.some(row=>row.action==='CANCEL'&&row.resultingStatus==='CANCELLED'),
        'Server cancellation receipt must converge after same-profile restart');
      pattaResult.cancellation.restartStatus = 'SUPERSEDED';
      pattaResult.cancellation.serverHistoryAfterRestart = restoredHistory.history.length;
    }
    const revokedPayload = { ...activation.signedActivation.payload,
      issuedAt: new Date(Date.now() + 1000).toISOString(), status: 'revoked' };
    const revokeCanonical = JSON.stringify(Object.fromEntries(canonicalFields.map(field => [field, revokedPayload[field]])));
    const revokedRecord = { payload: revokedPayload,
      signature: crypto.sign(null, Buffer.from(revokeCanonical), keyPair.privateKey).toString('base64') };
    const revokeResponse = await fetch(`${apiBase}/api/admin/activation/requests/${activation.request.request_id}/revoke`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-novda-admin-token': adminApiToken },
      body: JSON.stringify({ adminTelegramId: ADMIN_ID, signedActivation: revokedRecord })
    });
    const revokeText = await revokeResponse.text();
    assert.equal(revokeResponse.status, 200, `Local revoke failed: ${revokeText}`);
    const revokedStatus = await finalEvaluate('window.electronAPI.getLicenseStatus()');
    assert.equal(revokedStatus.isActivated, false, 'Revoked activation must fail the real status path');
    assert.equal(fs.existsSync(path.join(profile, 'credentials', `${COMPANY_ID}.enc.json`)), false,
      'Revoked activation must delete the isolated device credential');
    activeStage = 'close-restarted-electron-process';
    await closeElectronWindow(cdp, finalElectronExit, PATTA_MODE ? 'POST_CANCEL_RESTARTED' : 'RESTARTED');
    electron = null;
    cdp.socket.close(); cdp = null;

    const final = { status: 'PASS', scope: PATTA_MODE
        ? 'Real Electron signed activation plus Patta issuance, split allocation, offline SQLite outbox, same-profile restart, dropped-response replay and PostgreSQL/change-feed convergence'
        : 'Real Electron signed activation, safeStorage device credential, authenticated company UI, process restart; not PATTA business-flow E2E',
      postgres: container.identity, postgresPort: container.port, postgresImage: container.digest,
      api: apiBase, activationRequestId: activation.request.request_id, companyId: COMPANY_ID,
      machineId: MACHINE_ID, activationId: activationStatus.activationId,
      testPrivateKeySha256Ephemeral: privateKeyFingerprint, productionTrustedTestKey: false,
      testSignatureAccepted: true, badSignatureRejected: true, untrustedKeyRejected: true,
      expiredLicenseRejected: true, mismatchedDeviceRejected: true, isolatedProfile: profile,
      safeStorageCredentialPersisted: true, restartActivationAndCredentialValid: true, revokedActivationRejected: true,
      rendererDisplaysCompany: true, rendererExposesPattaWorkflow: true, profileUnderTemp: true };
    if (pattaResult) Object.assign(final, { pattaWorkflow: pattaResult });
    fs.writeFileSync(path.join(outputDir, 'activation-e2e.json'), JSON.stringify(final, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(final, null, 2));
  } finally {
    if (cdp?.socket) cdp.socket.close();
    if (electron && electron.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(electron.pid), '/T', '/F'], { stdio: 'ignore' });
      else electron.kill('SIGTERM');
    }
    if (proxy) await proxy.close().catch(() => {});
    if (api) await api.close().catch(() => {});
    if (pool) await pool.end().catch(() => {});
    if (container?.container) {
      try { run('docker', ['stop', container.container]); } catch {}
    }
    // This directory is created exclusively by this run. It contains the
    // isolated profile, generated test public trust and no persisted private key.
    if (process.env.NOVDA_E2E_KEEP_ARTIFACTS === '1') {
      process.stdout.write(`E2E_ARTIFACTS_RETAINED ${tempDir}\n`);
    } else {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  }
}

main().catch(error => { console.error(`E2E_FAILED stage=${activeStage}`); console.error(error.stack || error); process.exitCode = 1; });
