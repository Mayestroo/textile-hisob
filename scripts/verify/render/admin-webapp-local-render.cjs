'use strict';
// Real admin WebApp assets, isolated loopback-only synthetic Telegram and HTTP API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const root = path.resolve(__dirname, '../../..');
const assetDir = path.join(root, 'apps/server/static/admin-webapp');
const liveFixture = process.env.MONEY_1D_API_BASE || '';
const browser = process.env.ADMIN_RENDER_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
assert(fs.existsSync(browser), 'Installed Edge required; ADMIN_RENDER_BROWSER may name another installed Chromium');
const screenshotDir = process.env.MONEY_1D_SCREENSHOTS || path.join(root, '.opencode/deep-audit/output/post-redesign-filters-2e-screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hisob-admin-render-'));
const companyId = process.env.MONEY_1D_COMPANY_ID || 'hisob_test_admin_render';
const noPeriodCompany = process.env.MONEY_1D_NO_PERIOD_COMPANY || 'hisob_test_admin_no_period';
const otherCompanyId = 'hisob_test_admin_other';
const worker = { companyId, workerId: 731, name: 'Synthetic Worker 731', status: 'ACTIVE',
  accountingStatus: 'INCOMPLETE', unknownEntryCount: 1, unresolvedAdjustmentCount: 1,
  pieceworkGross: 500000, oklad: 2000000, gross: 2500000, magazin: 100000,
  net: 2125000, avans: 200000, jarima: 50000, staj: 25000, pieces: 10 };
const workers = [worker,
  { companyId, workerId: 732, name: 'Synthetic Worker 732', status: 'ACTIVE', pieceworkGross: 100000, gross: 100000, oklad: 0, magazin: 0, net: -10, avans: 0, jarima: 0, staj: 0, pieces: 2 },
  { companyId, workerId: 733, name: 'Synthetic Worker 733', status: 'ACTIVE', pieceworkGross: 0, gross: 0, oklad: 0, magazin: 0, net: 0, avans: 0, jarima: 0, staj: 0, pieces: 0 }
];
const company = { companyId, companyName: 'Synthetic Factory', activationConfigured: true, activationActive: true };
const otherCompany = { companyId: otherCompanyId, companyName: 'Synthetic Factory Other', activationConfigured: true, activationActive: true };
const party = { companyId, partyRecordId: 'fixture-party', partyNumber: 'TEST-PARTY', modelId: 'model-1', modelName: 'Synthetic Model', pattaCount: 1, ishSoni: 12, status: 'ACTIVE' };
const model = { companyId, modelId: 'model-1', name: 'Synthetic Model', operations: [{ operationId: 'op-1', name: 'Synthetic Operation', rate: null }] };
const ticket = { companyId, workerId: 731, partyRecordId: 'fixture-party', partyNumber: 'TEST-PARTY', pattaNumber: 4, ticketQty: 12, quantity: 12, rate: null, operation: 'Synthetic Operation', modelId: 'model-1', modelName: 'Synthetic Model' };
const currentPeriodId = process.env.MONEY_1D_PERIOD_ID || 'fixture-period-p';
const closedPeriodId = process.env.MONEY_1D_CLOSED_PERIOD_ID || 'fixture-period-q';
const periods = [
  { periodId: currentPeriodId, name: 'Synthetic Period P', startDate: '2026-11-01', isClosed: false },
  { periodId: closedPeriodId, name: 'Original period P', startDate: '2026-09-01', isClosed: true }
];
const period = periods[0];
const hits = { company: {}, 'company-alt': {}, 'company-other': {}, global: {} };
const writes = [];
const pages = new Set(['index.html', 'admin.css', 'company-admin.css', 'financial-intent.js', 'admin.js', 'IBMPlexSans[wdth,wght].ttf', 'Onest[wght].ttf']);
function json(res, code, data) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/admin-app' || url.pathname === '/admin-app/') {
     const mode = ['global', 'company-alt', 'company-other'].includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'company';
    let html = fs.readFileSync(path.join(assetDir, 'index.html'), 'utf8');
    html = html.replace(/\s*<link rel="preconnect"[^>]*>/g, '').replace(/\s*<link\s+href="https:\/\/fonts\.googleapis\.com[^>]*>/g, '');
    html = html.replace(/<script src="https:\/\/telegram\.org\/js\/telegram-web-app\.js"><\/script>/,
      `<script>window.Telegram={WebApp:{initData:'synthetic-${mode}',version:'fixture',ready(){},expand(){},enableClosingConfirmation(){},setHeaderColor(){},setBackgroundColor(){},onEvent(){},BackButton:{onClick(){},hide(){},show(){}},HapticFeedback:{notificationOccurred(){},impactOccurred(){}}}};</script>`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:" });
    res.end(html); return;
  }
  const filename = decodeURIComponent(url.pathname.replace('/admin-app/', ''));
  if (url.pathname.startsWith('/admin-app/') && pages.has(filename)) {
    res.writeHead(200, { 'content-type': filename.endsWith('.ttf') ? 'font/ttf' : filename.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(path.join(assetDir, filename))); return;
  }
  if (!url.pathname.startsWith('/api/admin/webapp/')) { res.writeHead(404); res.end(); return; }
  const apiPath = url.pathname.slice('/api/admin/webapp/'.length);
  if (apiPath === 'session' && req.method === 'POST') {
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      const initData = JSON.parse(body).initData;
       if (!['synthetic-company', 'synthetic-company-alt', 'synthetic-company-other', 'synthetic-global'].includes(initData)) { json(res, 403, { success: false }); return; }
       const mode = initData.slice('synthetic-'.length);
       const isGlobal = mode === 'global';
       json(res, 200, { success: true, session: { token: `fixture-${mode}`, expiresAt: 1893456000 },
         user: { id: mode === 'company-alt' ? '987654321' : '123456789', firstName: 'Synthetic Admin' },
         access: { isGlobalAdmin: isGlobal, companyIds: isGlobal ? null : [mode === 'company-other' ? otherCompanyId : companyId] } });
    }); return;
  }
   const mode = req.headers.authorization === 'Bearer fixture-company' ? 'company' : req.headers.authorization === 'Bearer fixture-company-alt' ? 'company-alt' : req.headers.authorization === 'Bearer fixture-company-other' ? 'company-other' : req.headers.authorization === 'Bearer fixture-global' ? 'global' : null;
  if (!mode) { json(res, 401, { success: false, error: { code: 'ADMIN_SESSION_REQUIRED' } }); return; }
  if (req.method !== 'GET') { writes.push(`${mode}:${req.method}:${apiPath}`); json(res, 405, { success: false, error: { code: 'FIXTURE_READ_ONLY' } }); return; }
  hits[mode][apiPath] = (hits[mode][apiPath] || 0) + 1;
   const requestedCompanyId = url.searchParams.get('companyId') || (apiPath.startsWith('companies/') ? decodeURIComponent(apiPath.split('/')[1]) : '');
   const expectedCompanyId = mode === 'company-other' ? otherCompanyId : companyId;
   if (mode !== 'global' && requestedCompanyId && requestedCompanyId !== expectedCompanyId) {
    json(res, 403, { success: false, error: { code: 'ADMIN_COMPANY_SCOPE_REQUIRED' } }); return;
  }
   if (mode !== 'global' && !['session', 'companies', `companies/${expectedCompanyId}/periods`, 'worker-bot-status'].includes(apiPath)
    && !url.searchParams.has('companyId')) { json(res, 403, { success: false, error: { code: 'ADMIN_COMPANY_SELECTION_REQUIRED' } }); return; }
   const scoped = mode !== 'global' ? { isGlobalAdmin: false, companyIds: [expectedCompanyId] } : { isGlobalAdmin: true, companyIds: null };
  const responses = {
     session: { session: { telegramId: mode === 'company-alt' ? '987654321' : '123456789' }, access: scoped },
     companies: { companies: [mode === 'company-other' ? otherCompany : company] },
      [`companies/${expectedCompanyId}/periods`]: { periods },
    'worker-bot-status': { status: 'UNKNOWN' },
    overview: { overview: { companies: 1, workers: 1, models: 1, parties: 1, devices: 0, pendingActivations: 0, workerBindings: 0, recentSyncAt: null } },
    activations: { activations: [] },
     workers: { workers, total: workers.length },
     payroll: { payroll: { period: periods.find(item => item.periodId === url.searchParams.get('periodId')) || period, accountingStatus: 'INCOMPLETE', workers } },
    parties: { parties: [party], total: 1 },
    models: { models: [model], total: 1 },
    tickets: { tickets: [ticket], total: 1 },
    devices: { devices: [], total: 0 },
    system: { system: { api: 'UNKNOWN', database: 'UNKNOWN' } }
  };
  if (liveFixture && apiPath === 'payroll') {
    fetch(`${liveFixture}/fixture/admin/payroll?${url.searchParams}`, {
      headers: { 'x-fixture-admin-scope': mode }
    }).then(async response => {
      res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ success: response.ok, payroll: await response.json() }));
    }).catch(() => json(res, 502, { success: false, error: { code: 'FIXTURE_UPSTREAM_UNAVAILABLE' } }));
    return;
  }
  json(res, 200, { success: true, ...(responses[apiPath] || {}) });
});
function cdp(ws) {
  let id = 0; const pending = new Map(); const listeners = new Map();
  ws.addEventListener('message', event => { const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) { const entry = pending.get(data.id); pending.delete(data.id); data.error ? entry.reject(Error(data.error.message)) : entry.resolve(data.result); }
    if (data.method) for (const fn of listeners.get(data.method) || []) fn(data.params);
  });
  return { send(method, params = {}) { const n = ++id; return new Promise((resolve, reject) => { pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); }); },
    on(method, fn) { listeners.set(method, [...(listeners.get(method) || []), fn]); } };
}
async function waitFor(fn, label, timeout = 20000) { const end = Date.now() + timeout; let lastError; while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch (error) { lastError = error; } await delay(100); } throw Error(`Timeout: ${label}${lastError ? ` (${lastError.message})` : ''}`); }
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/admin/webapp/payroll?companyId=${companyId}`)).status, 401, 'fixture rejects unauthenticated read');
  assert.equal((await fetch(`${base}/api/admin/webapp/payroll?companyId=wrong-company`, { headers: { Authorization: 'Bearer fixture-company' } })).status, 403, 'fixture rejects wrong company');
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-extensions', '--no-default-browser-check',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${userData}`, `${base}/admin-app/?mode=company`], { stdio: 'ignore', windowsHide: true });
  let ws;
  try {
    const activePortFile = path.join(userData, 'DevToolsActivePort');
    await waitFor(() => fs.existsSync(activePortFile), 'private Edge debugging port');
    const [debugPort] = fs.readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
    const target = await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r => r.json())).find(t => t.type === 'page'); } catch { return null; } }, 'Edge page');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const dev = cdp(ws); await dev.send('Page.enable'); await dev.send('Runtime.enable'); await dev.send('Network.enable');
    const external = [], errors = [];
    dev.on('Network.requestWillBeSent', e => { if (/^https?:/i.test(e.request.url) && !e.request.url.startsWith(base + '/')) external.push(e.request.url); });
    dev.on('Runtime.exceptionThrown', e => errors.push(e.exceptionDetails.text));
    async function evaluate(expression) { const result = await dev.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(`${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description || ''}`); return result.result.value; }
    async function capture(name) { await delay(260); await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); const result = await dev.send('Page.captureScreenshot'); fs.writeFileSync(path.join(screenshotDir, name), Buffer.from(result.data, 'base64')); }
    async function viewport(width, height, mobile) { await dev.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); }
    async function click(selector) { assert.equal(await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el || el.hidden)return false;el.click();return true})()`), true, `click ${selector}`); }
    async function text(selector) { return evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText || ''`); }
    await viewport(1440, 1000, false);
    const expectedCompanyNet = liveFixture ? '2 124 999' : '2 124 990';
    const expectedCompanyGross = liveFixture ? '2 500 000' : '2 600 000';
    await waitFor(() => evaluate(`!document.querySelector('#companyAdminApp').hidden && document.querySelector('#companyNet').textContent.includes(${JSON.stringify(expectedCompanyNet)})`), 'company payroll render');
    const values = { net: await text('#companyNet'), gross: await text('#companyGross'), count: await text('#companyWorkerCount') };
    assert(values.net.includes(expectedCompanyNet) && values.net.includes('oraliq'));
    assert(values.gross.includes(expectedCompanyGross) && values.gross.includes('oraliq'));
    assert(values.count.includes(`${liveFixture ? 2 : 1} ta ish narxi noma’lum`));
    assert.match(values.count, /1 ta tuzatish aniqlanmagan/);
    const fontEvidence = await evaluate(`(async()=>{await Promise.all([document.fonts.load('600 15px "IBM Plex Sans"','Шаҳноза'),document.fonts.load('800 34px "Onest"','Абдуллаева')]); await document.fonts.ready;
      return {status:document.fonts.status,plex:document.fonts.check('600 15px "IBM Plex Sans"','Шаҳноза'),onest:document.fonts.check('800 34px "Onest"','Абдуллаева'),
        loaded:[...document.fonts].filter(f=>f.status==='loaded').map(f=>f.family),resources:performance.getEntriesByType('resource').filter(e=>e.name.includes('.ttf')).map(e=>e.name)};})()`);
    assert(fontEvidence.plex && fontEvidence.onest && fontEvidence.loaded.some(f=>f.includes('IBM Plex Sans')) && fontEvidence.loaded.some(f=>f.includes('Onest')) && fontEvidence.resources.length===2, `admin font evidence ${JSON.stringify(fontEvidence)}`);
    assert.equal(await evaluate(`document.querySelector('#adminApp').hidden && document.querySelector('#companyBrandName').textContent === 'Synthetic Factory'`), true);
    await capture('company-desktop-home.png');
    const desktopFontStress = await evaluate(`(()=>{const name=document.querySelector('#companyBrandName'),value=document.querySelector('#companyNet');
      const original=[name.textContent,value.textContent];name.textContent='Шаҳноза Абдуллаева';value.textContent='12 345 678 901 (oraliq)';
      const data={scrollWidth:document.documentElement.scrollWidth,hero:document.querySelector('.co-profit').getBoundingClientRect().width};
      window.__visualFontRestore=()=>{name.textContent=original[0];value.textContent=original[1]};return data;})()`);
    assert(desktopFontStress.scrollWidth<=1440, `admin Cyrillic/amount 1440 ${JSON.stringify(desktopFontStress)}`);
    await capture('company-desktop-font-stress.png'); await evaluate('window.__visualFontRestore()');
    assert((await evaluate(`document.querySelector('.co-main').getBoundingClientRect().width`)) > 900, 'company desktop layout expands beyond old 520px canvas');
     await click('[data-co-tab="workers"]');
    await waitFor(() => evaluate(`document.querySelector('#companyWorkers')?.innerText.includes('Synthetic Worker 731')`), 'worker list');
    assert.match(await text('#companyWorkers'), /oraliq summa/);
    assert.equal(await evaluate(`document.querySelectorAll('#companyWorkers .co-worker-row').length`), 3, 'all synthetic fixture rows');
     assert((await text('#companyWorkerCaption')).startsWith('3 / 3'), 'unfiltered exact result count');
    const deniedStorage = await evaluate(`(() => {
      const target=window.sessionStorage, original={};
      const calls = {getItem:0,setItem:0,removeItem:0};
      for (const name of Object.keys(calls)) {const descriptor=Object.getOwnPropertyDescriptor(Storage.prototype,name);original[name]=descriptor;
        Object.defineProperty(Storage.prototype,name,{...descriptor,value:function(...args){if(this===target){calls[name]++;throw Error('fixture denied Storage.'+name)}return descriptor.value.apply(this,args)}});}
      window.__filters2gStorageDenied={target,original,calls};
      const input=document.querySelector('#companyWorkerSearch');
      const set=value=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};
      set('732'); const selected={workers:[...document.querySelectorAll('#companyWorkers .co-worker-row')].map(e=>e.innerText.trim()),count:document.querySelector('#companyWorkerCaption').textContent.trim()};
      return {selected};
    })()`);
    assert(deniedStorage.selected.workers.length === 1 && deniedStorage.selected.workers[0].includes('Synthetic Worker 732') && deniedStorage.selected.count.startsWith('1 / 3'));
    await capture('filters-2g-company-denied-storage.png');
    const deniedStorageRemainder = await evaluate(`(() => {
      const target=window.__filters2gStorageDenied.target;
      const input=document.querySelector('#companyWorkerSearch');
      const set=value=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};
       set('no-synthetic-match'); const empty={rows:document.querySelectorAll('#companyWorkers .co-worker-row').length,count:document.querySelector('#companyWorkerCaption').textContent.trim()};
       set(''); const cleared={rows:document.querySelectorAll('#companyWorkers .co-worker-row').length,count:document.querySelector('#companyWorkerCaption').textContent.trim()};
       let getDenied=false,removeDenied=false;try{target.getItem('fixture-probe')}catch{getDenied=true;}try{target.removeItem('fixture-probe')}catch{removeDenied=true;}
       const denied=window.__filters2gStorageDenied;
       for(const name of Object.keys(denied.original)) Object.defineProperty(Storage.prototype,name,denied.original[name]);
       return {empty,cleared,calls:denied.calls,getDenied,removeDenied};
     })()`);
    Object.assign(deniedStorage,deniedStorageRemainder);
    assert.equal(deniedStorage.empty.rows, 0); assert(deniedStorage.empty.count.startsWith('0 / 3'));
    assert.equal(deniedStorage.cleared.rows, 3); assert(deniedStorage.cleared.count.startsWith('3 / 3'));
    assert(deniedStorage.calls.setItem > 0 && deniedStorage.getDenied && deniedStorage.removeDenied, 'denied Storage get/set/remove paths were exercised');
    await evaluate(`(()=>document.querySelector('#companyWorkerSearch').focus())()`);
    await dev.send('Input.insertText', { text: '732' });
    await waitFor(() => evaluate(`document.querySelectorAll('#companyWorkers .co-worker-row').length === 1`), 'keyboard worker ID search');
    assert.equal(await evaluate(`document.querySelector('#companyWorkers').innerText.includes('Synthetic Worker 732')`), true);
    assert((await text('#companyWorkerCaption')).startsWith('1 / 3'), 'filtered exact result count');
    await capture('filters-2e-company-selected-worker.png');
    await evaluate(`(()=>{const input=document.querySelector('#companyWorkerSearch');input.value='no-synthetic-match';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    assert.equal(await evaluate(`document.querySelectorAll('#companyWorkers .co-worker-row').length === 0 && document.querySelector('#companyWorkers').innerText.includes('Ishchilar topilmadi.') && document.querySelector('#companyWorkerCaption').textContent.startsWith('0 / 3')`), true, 'no-match state');
    await evaluate(`(()=>{const input=document.querySelector('#companyWorkerSearch');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    assert.equal(await evaluate(`document.querySelectorAll('#companyWorkers .co-worker-row').length`), 3, 'clear restores all fixture rows');
    await click('#companyWorkerFilters [data-filter="negative"]');
    assert.equal(await evaluate(`document.querySelectorAll('#companyWorkers .co-worker-row').length`), 1, 'negative chip result');
    await click('#companyWorkerFilters [data-filter="zero"]');
    assert.equal(await evaluate(`document.querySelectorAll('#companyWorkers .co-worker-row').length`), 1, 'zero chip result');
    await click('#companyWorkerFilters [data-filter="all"]');
    await evaluate(`(()=>{const input=document.querySelector('#companyWorkerSearch');input.value='731';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await click('#companyWorkerFilters [data-filter="positive"]');
    assert.equal(await evaluate(`document.querySelectorAll('#companyWorkers .co-worker-row').length`), 1, 'search and Avansli chip combined');
    await viewport(390, 844, true); await capture('filters-2e-company-narrow.png');
    await dev.send('Page.reload');
    await waitFor(() => evaluate(`!document.querySelector('#companyAdminApp').hidden && document.querySelector('#companyWorkerSearch')?.value === '731' && document.querySelectorAll('#companyWorkers .co-worker-row').length === 1`), 'filter survives actual browser reload');
    await evaluate(`(()=>{const select=document.querySelector('#companyPeriodSelect');select.value=${JSON.stringify(closedPeriodId)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await waitFor(() => evaluate(`document.querySelector('#companyWorkerSearch')?.value === '' && document.querySelectorAll('#companyWorkers .co-worker-row').length === 3`), 'period-specific isolation');
    if (liveFixture) {
      await waitFor(() => evaluate(`document.querySelector('#companyGross')?.textContent.includes('1 500 000')`), 'closed-period actual payroll service read');
      assert.match(await text('#companyNet'), /1[\s\u00a0]?314[\s\u00a0]?999/);
      assert.match(await text('#companyPiecework'), /400[\s\u00a0]?000/);
      assert.match(await text('#companyOklad'), /1[\s\u00a0]?100[\s\u00a0]?000/);
      assert.match(await text('#companyMagazin'), /50[\s\u00a0]?000/);
    }
    await evaluate(`(()=>{const select=document.querySelector('#companyPeriodSelect');select.value=${JSON.stringify(currentPeriodId)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await waitFor(() => evaluate(`document.querySelector('#companyWorkerSearch')?.value === '731' && document.querySelectorAll('#companyWorkers .co-worker-row').length === 1`), 'period-scoped filter restores');
    if (!liveFixture) {
      await dev.send('Page.navigate', { url: `${base}/admin-app/?mode=company-alt` });
      await waitFor(() => evaluate(`!document.querySelector('#companyAdminApp').hidden && document.querySelector('#companyWorkerSearch')?.value === '' && document.querySelectorAll('#companyWorkers .co-worker-row').length === 3`), 'different authenticated actor filter isolation');
      await dev.send('Page.navigate', { url: `${base}/admin-app/?mode=company` });
      await waitFor(() => evaluate(`!document.querySelector('#companyAdminApp').hidden && document.querySelector('#companyWorkerSearch')?.value === '731' && document.querySelectorAll('#companyWorkers .co-worker-row').length === 1`), 'original actor filter restores');
      await dev.send('Page.navigate', { url: `${base}/admin-app/?mode=company-other` });
      await waitFor(() => evaluate(`!document.querySelector('#companyAdminApp').hidden && document.querySelector('#companyBrandName').textContent === 'Synthetic Factory Other' && document.querySelector('#companyWorkerSearch')?.value === '' && document.querySelectorAll('#companyWorkers .co-worker-row').length === 3`), 'different company scope filter isolation');
      await dev.send('Page.navigate', { url: `${base}/admin-app/?mode=company` });
      await waitFor(() => evaluate(`!document.querySelector('#companyAdminApp').hidden && document.querySelector('#companyWorkerSearch')?.value === '731' && document.querySelectorAll('#companyWorkers .co-worker-row').length === 1`), 'original company filter restores');
    }
    await viewport(1440, 1000, false);
    await click('#companyWorkerFilters [data-filter="positive"]');
    await capture('company-desktop-workers.png');
    await click('#companyWorkers .co-worker-row');
    await waitFor(() => evaluate(`document.querySelector('[data-co-screen="worker-detail"]').classList.contains('is-active')`), 'worker detail');
    assert.match(await text('#companyDetailNet'), /2[\s\u00a0]?125[\s\u00a0]?000/);
    assert.match(await text('#companyWorkerTickets'), /12 dona/);
    assert.match(await text('#companyWorkerTickets'), /Narx noma’lum/);
    await capture('company-desktop-detail.png');
    await viewport(390, 844, true); await capture('company-mobile-detail.png');
    await click('#companyDetailAdvance');
    await waitFor(() => evaluate(`document.querySelector('[data-co-screen="advance"]').classList.contains('is-active')`), 'advance screen');
    await capture('company-mobile-advance.png');
    await evaluate(`window.openCompanyAdvanceSuccess && window.openCompanyAdvanceSuccess({ name: 'Абдуллаева Мавлуда', workerId: 1, net: 702600 }, 200000, 502600, '15.10.2026')`);
    await waitFor(() => evaluate(`document.querySelector('[data-co-screen="advance-success"]').classList.contains('is-active')`), 'advance success screen');
    await capture('company-mobile-advance-success.png');
    await click('#companyClose');
    await waitFor(() => evaluate(`document.querySelector('[data-co-screen="worker-detail"]').classList.contains('is-active')`), 'return to detail');
    await click('[data-co-tab="home"]'); await capture('company-mobile-home.png');
    const mobileFontStress = await evaluate(`(()=>{const name=document.querySelector('#companyBrandName'),value=document.querySelector('#companyNet');
      const original=[name.textContent,value.textContent];name.textContent='Шаҳноза Абдуллаева';value.textContent='12 345 678 901 (oraliq)';
      const data={scrollWidth:document.documentElement.scrollWidth,heading:document.querySelector('.co-heading h1').getBoundingClientRect().width,
        hero:document.querySelector('.co-profit').getBoundingClientRect().width,valueScroll:value.scrollWidth};
      window.__visualFontRestore=()=>{name.textContent=original[0];value.textContent=original[1]};return data;})()`);
    assert(mobileFontStress.scrollWidth<=390 && mobileFontStress.hero<=390, `admin Cyrillic/long-amount 390 ${JSON.stringify(mobileFontStress)}`);
    await capture('company-mobile-font-stress.png'); await evaluate('window.__visualFontRestore()');
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= 390 && getComputedStyle(document.querySelector('.co-topbar')).height === '52px' && document.querySelector('.co-warning').getBoundingClientRect().top < 844`), true, 'company mobile header and warning fit viewport');
    await click('[data-co-tab="workers"]'); await capture('company-mobile-workers.png');
    await dev.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await capture('company-mobile-dark-host.png');
    await dev.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await click('[data-co-tab="parties"]');
    await waitFor(() => evaluate(`document.querySelector('[data-co-screen="parties"]').classList.contains('is-active')`), 'parties');
    assert.match(await text('#companyParties'), /TEST-PARTY|Synthetic Model/);
    await capture('company-mobile-parties.png');
    await click('[data-co-tab="settings"]'); await click('[data-co-go="models"]');
    await waitFor(() => evaluate(`document.querySelector('[data-co-screen="models"]').classList.contains('is-active')`), 'models');
    assert.match(await text('#companyModelName'), /Synthetic Model/); assert.match(await text('#companyModelStatus'), /Narx yo‘q/);
    await capture('company-mobile-models.png');
    await dev.send('Page.navigate', { url: `${base}/admin-app/?mode=global` });
    await viewport(1440, 1000, false);
    await waitFor(() => evaluate(`!document.querySelector('#adminApp').hidden && document.querySelector('#metricCompanies').textContent === '1'`), 'global overview');
    assert.equal(await evaluate(`document.querySelector('#companyAdminApp').hidden && document.querySelector('#adminBadge').textContent === 'SYSTEM'`), true);
    if (liveFixture) {
      const globalPayroll = await evaluate(`fetch('/api/admin/webapp/payroll?companyId='+encodeURIComponent(${JSON.stringify(companyId)})+'&periodId='+encodeURIComponent(${JSON.stringify(currentPeriodId)}),{headers:{Authorization:'Bearer fixture-global'}}).then(r=>r.json())`);
      const globalRow = globalPayroll.payroll.workers.find(w => Number(w.workerId) === 731);
      assert.deepEqual([globalRow.pieceworkGross, globalRow.oklad, globalRow.gross, globalRow.magazin, globalRow.avans, globalRow.jarima, globalRow.staj, globalRow.net],
        [500000, 2000000, 2500000, 100000, 200000, 50000, 25000, 2125000]);
      const unavailable = await evaluate(`fetch('/api/admin/webapp/payroll?companyId='+encodeURIComponent(${JSON.stringify(noPeriodCompany)}),{headers:{Authorization:'Bearer fixture-global'}}).then(r=>r.json())`);
      assert.equal(unavailable.payroll.period, null);
      assert.equal(unavailable.payroll.accountingStatus, 'UNAVAILABLE');
      assert.equal(unavailable.payroll.workers[0].accountingStatus, 'UNAVAILABLE');
    }
    await capture('console-desktop-overview.png');
    await click('#mainNav [data-view="companies"]');
    await waitFor(() => evaluate(`document.querySelector('[data-section="companies"]')?.hidden === false && document.querySelector('[data-section="companies"]').innerText.includes('Synthetic Factory')`), 'global companies');
    await capture('console-desktop-companies.png');
    await evaluate(`(()=>{const el=document.querySelector('#companySearchInput');el.value='no-matching-company';el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await waitFor(() => evaluate(`document.querySelector('#companyCardGrid').innerText.includes('Qidiruv bo‘yicha korxona topilmadi.') && !document.querySelector('#companyCardGrid').innerText.includes('Synthetic Factory')`), 'company card search filter');
    await evaluate(`(()=>{const el=document.querySelector('#companySearchInput');el.value='Synthetic';el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await waitFor(() => evaluate(`document.querySelector('#companyCardGrid').innerText.includes('Synthetic Factory')`), 'company search restore');
    if (liveFixture) {
      await click('#companyCardGrid [data-open-company]');
      await waitFor(() => evaluate(`document.querySelector('#directorOverview')?.hidden === false && document.querySelector('#coGrossPayroll')?.textContent.includes('2 500 000')`), 'global admin existing company payroll overview');
      assert.match(await text('#coPieceworkPayroll'), /500[\s\u00a0]000/);
      assert.match(await text('#coOkladPayroll'), /2[\s\u00a0]000[\s\u00a0]000/);
      assert.match(await text('#coMagazinPayroll'), /100[\s\u00a0]000/);
      assert.match(await text('#coAvansPayroll'), /200[\s\u00a0]000/);
      assert.match(await text('#coJarimaPayroll'), /50[\s\u00a0]000/);
      assert.match(await text('#coStajPayroll'), /25[\s\u00a0]001/);
      await capture('console-global-company-payroll.png');
      await dev.send('Page.navigate', { url: `${base}/admin-app/?mode=global` });
      await waitFor(() => evaluate(`!document.querySelector('#adminApp').hidden`), 'global console return');
    }
    await viewport(390, 844, true);
    await capture('console-mobile-companies.png');
    await click('#mainNav [data-view="overview"]');
    await waitFor(() => evaluate(`document.querySelector('[data-section="overview"]')?.hidden === false`), 'mobile console overview');
    await capture('console-mobile-overview.png');
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= 390 && getComputedStyle(document.querySelector('.sidebar')).backgroundColor === 'rgb(255, 255, 255)'`), true, 'global mobile rail fits viewport');
    await dev.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await capture('console-mobile-dark-host.png');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.main-panel')).backgroundColor`), 'rgb(243, 246, 251)', 'global workspace remains legible under dark host preference');
    assert.deepEqual(external, [], 'no external HTTP(S) requests'); assert.deepEqual(writes, [], 'safe read/navigation actions only'); assert.deepEqual(errors, [], 'no uncaught application exception');
    assert(hits.company.payroll > 0 && hits.global.overview > 0);
    console.log(JSON.stringify({ status: 'PASS', values, fontEvidence, desktopFontStress, mobileFontStress, deniedStorage, snapshots: fs.readdirSync(screenshotDir).filter(n => n.endsWith('.png')), hits, externalRequests: external, writes, errors }, null, 2));
  } finally {
    if (ws) ws.close();
    if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await delay(300);
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
