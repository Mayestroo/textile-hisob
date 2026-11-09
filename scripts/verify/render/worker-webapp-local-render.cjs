'use strict';
// Bounded browser acceptance for the existing worker document. Own local HTTP fixture;
// remote host resolution is denied and the remote Telegram SDK tag is replaced locally.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.resolve(__dirname, '../../..');
const htmlPath = path.join(root, 'apps/bots/worker/webapp/index.html');
const browser = process.env.WORKER_RENDER_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
assert(fs.existsSync(browser), 'Set WORKER_RENDER_BROWSER to an installed Chromium browser');
const liveFixture = process.env.MONEY_1D_API_BASE || '';
const token = process.env.MONEY_1D_WORKER_TOKEN || 'a'.repeat(64);
const workerId = process.env.MONEY_1D_WORKER_ID || '731';
const companyId = process.env.MONEY_1D_COMPANY_ID || 'hisob_test_worker_render';
const expiresAt = process.env.MONEY_1D_EXPIRES_AT || '1794000000';
const telegramId = '123456789';
const screenshots = process.env.MONEY_1D_SCREENSHOTS || path.join(root, '.opencode/deep-audit/output/post-redesign-filters-2e-screenshots');
fs.mkdirSync(screenshots, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hisob-worker-webapp-'));
const inlineScripts = [...fs.readFileSync(htmlPath, 'utf8').matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(Boolean);
assert.equal(inlineScripts.length, 1, 'only the worker application inline script is syntax-checked');
const syntaxFile = path.join(userData, 'worker-inline.cjs');
fs.writeFileSync(syntaxFile, inlineScripts[0]);
const syntaxCheck = spawnSync(process.execPath, ['--check', syntaxFile], { encoding: 'utf8' });
assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr);
let profileHits = 0;
let ticketsHits = 0;

const profile = {
  success: true,
  profile: {
    worker_id: workerId, company_id: companyId, worker_name: 'Synthetic Worker 731',
    period_name: 'Synthetic period P', period: { isClosed: false },
    pieceworkGross: 500000, oklad: 2000000, gross: 2500000, magazin: 100000,
    avans: 200000, jarima: 50000, staj: 25000, net: 2125000, pieces: 10,
    accountingStatus: 'INCOMPLETE', unknownEntryCount: 1, unresolvedAdjustmentCount: 1,
    models_breakdown: {
      fixture_model: { name: 'Synthetic model', earnings: 500000, operations: [
        { name: 'Synthetic operation', qty: 10, rate: 50000, amount: 500000 },
        { name: 'Unknown operation', qty: 1, rate: null, amount: null }
      ] }
    }
  }
};
const tickets = { success: true, tickets: [
  { model_id: 'Synthetic model', patta_number: 4, party_number: 'TEST-PARTY-4101', size: 'M', color: 'Blue', qty: 12, submitted_at: '2026-11-05 10:00', my_operations: 'Synthetic operation' },
  { model_id: 'Synthetic jacket', patta_number: 5, party_number: 'TEST-PARTY-5202', size: 'L', color: 'Red', qty: 8, submitted_at: '2026-11-04 10:00', my_operations: 'Synthetic seam' },
  { model_id: 'Synthetic coat', patta_number: 6, party_number: 'TEST-PARTY-6303', size: 'XL', color: 'Green', qty: 4, submitted_at: '2026-11-03 10:00', my_operations: 'Synthetic hem' }
] };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('cache-control', 'no-store');
  if (url.pathname === '/worker-app') {
    assert.equal(url.searchParams.get('workerId'), workerId);
    assert(liveFixture ? url.searchParams.get('companyId') === companyId : ['hisob_test_worker_render', 'hisob_test_worker_other'].includes(url.searchParams.get('companyId')));
    assert(['123456789', '987654321'].includes(url.searchParams.get('telegramId')));
    assert.equal(url.searchParams.get('expiresAt'), expiresAt);
    assert.equal(url.searchParams.get('authToken'), token);
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace(/\s*<script src="https:\/\/telegram\.org\/js\/telegram-web-app\.js"><\/script>/,
      `<script>window.Telegram={WebApp:{ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},initDataUnsafe:{user:{id:${url.searchParams.get('telegramId')}}},HapticFeedback:{impactOccurred(){},notificationOccurred(){}}}};</script>`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return;
  }
  if (url.pathname.startsWith('/worker-app-font/')) {
    const name = decodeURIComponent(url.pathname.slice('/worker-app-font/'.length));
    if (!['IBMPlexSans[wdth,wght].ttf','Onest[wght].ttf'].includes(name)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'font/ttf' }); res.end(fs.readFileSync(path.join(path.dirname(htmlPath), name))); return;
  }
  if (url.pathname === '/api/worker/profile' || url.pathname === '/api/worker/tickets') {
    assert.equal(req.headers['x-worker-auth-token'], token, 'fixture auth token header');
    assert.equal(url.searchParams.get('workerId'), workerId);
    assert(liveFixture ? url.searchParams.get('companyId') === companyId : ['hisob_test_worker_render', 'hisob_test_worker_other'].includes(url.searchParams.get('companyId')));
    assert(['123456789', '987654321'].includes(url.searchParams.get('telegramId')));
    assert.equal(url.searchParams.get('expiresAt'), expiresAt);
    if (url.pathname.endsWith('/profile')) profileHits++; else ticketsHits++;
    if (liveFixture) {
      console.log(`MONEY_1D_WORKER_PROXY path=${url.pathname} company=${url.searchParams.get('companyId')} worker=${url.searchParams.get('workerId')}`);
      fetch(`${liveFixture}${url.pathname}${url.search}`, { headers: { 'x-worker-auth-token': req.headers['x-worker-auth-token'] }, signal: AbortSignal.timeout(5000) })
        .then(async response => {
          const body = await response.text();
          const parsed = JSON.parse(body);
          console.log(`MONEY_1D_WORKER_HTTP status=${response.status} name=${parsed.profile?.worker_name || ''} period=${parsed.profile?.periodId || ''} gross=${parsed.profile?.gross ?? ''} net=${parsed.profile?.net ?? ''} error=${parsed.error?.code || ''}`);
          res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(body);
        })
        .catch(error => { console.log(`MONEY_1D_WORKER_UPSTREAM_ERROR ${error.name}:${error.message}`); res.writeHead(502); res.end(JSON.stringify({ success: false })); });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    const response = url.pathname.endsWith('/profile')
      ? { ...profile, profile: { ...profile.profile, company_id: url.searchParams.get('companyId') } } : tickets;
    res.end(JSON.stringify(response)); return;
  }
  res.writeHead(404); res.end('not found');
});

function cdp(ws) {
  let id = 0; const pending = new Map(); const listeners = new Map();
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) { const p = pending.get(data.id); pending.delete(data.id); data.error ? p.reject(new Error(data.error.message)) : p.resolve(data.result); }
    if (data.method) for (const fn of listeners.get(data.method) || []) fn(data.params);
  });
  return {
    send(method, params = {}) { const n = ++id; return new Promise((resolve, reject) => { pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id:n, method, params })); }); },
    on(method, fn) { listeners.set(method, [...(listeners.get(method) || []), fn]); }
  };
}
async function waitFor(fn, description, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error(`Timed out waiting for ${description}`);
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--disable-extensions', '--no-default-browser-check', '--hide-scrollbars',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${userData}`, `http://127.0.0.1:${port}/worker-app?workerId=${workerId}&companyId=${companyId}&telegramId=${telegramId}&expiresAt=${expiresAt}&authToken=${token}`
  ], { stdio: 'ignore', windowsHide: true });
  try {
    const activePortFile = path.join(userData, 'DevToolsActivePort');
    await waitFor(() => fs.existsSync(activePortFile), 'private DevTools endpoint');
    const [debugPort] = fs.readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
    const targets = await waitFor(async () => {
      try { const result = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r => r.json()); return result.find(t => t.type === 'page'); } catch { return null; }
    }, 'browser page target');
    const ws = new WebSocket(targets.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const dev = cdp(ws);
    await dev.send('Page.enable'); await dev.send('Runtime.enable');
    const blocked = [];
    const externalRequests = [];
    const pageErrors = [];
    dev.on('Network.loadingFailed', e => { if (e.blockedReason || e.errorText) blocked.push(e.blockedReason || e.errorText); });
    dev.on('Runtime.exceptionThrown', e => pageErrors.push(e.exceptionDetails?.text || 'unknown exception'));
    await dev.send('Network.enable');
    dev.on('Network.requestWillBeSent', e => {
      if (/^https?:/i.test(e.request.url) && !/^http:\/\/127\.0\.0\.1(?::|\/)/i.test(e.request.url)) externalRequests.push(e.request.url);
    });
    async function evaluate(expression) {
      const result = await dev.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    }
    async function capture(name) {
      await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      const result = await dev.send('Page.captureScreenshot');
      fs.writeFileSync(path.join(screenshots, name), Buffer.from(result.data, 'base64'));
    }
    await waitFor(async () => (await evaluate(`document.querySelector('#workerNameHeader')?.textContent === 'Synthetic Worker 731' && document.querySelector('#netPayAmount')?.textContent.includes('2 125 000')`)), 'synthetic profile render');
    const expected = await evaluate(`({name:document.querySelector('#workerNameHeader').textContent, net:document.querySelector('#netPayAmount').textContent, gross:document.querySelector('#grossPayAmount').textContent, subtitle:document.querySelector('#netPaySubtitle').textContent, model:document.querySelector('#modelsBreakdownList').innerText, period:document.querySelector('#periodNameText').textContent})`);
    assert.equal(expected.name, 'Synthetic Worker 731');
    assert.match(expected.net, /2[\s\u00a0]125[\s\u00a0]000/); assert.match(expected.gross, /500[\s\u00a0]000/);
    assert.match(await evaluate(`document.querySelector('#grossTotalAmount').textContent`), /2[\s\u00a0]500[\s\u00a0]000/);
    assert.match(await evaluate(`document.querySelector('#okladAmount').textContent`), /2[\s\u00a0]000[\s\u00a0]000/);
    assert.match(await evaluate(`document.querySelector('#magazinAmount').textContent`), /100[\s\u00a0]000/);
    assert.match(expected.subtitle, /1 ta ish narxi noma’lum/); assert.match(expected.subtitle, /1 ta tuzatish aniqlanmagan/);
    assert.match(expected.model, /Unknown operation/); assert.match(expected.model, /summa noma’lum/i);
    assert.match(expected.model, /500[\s\u00a0]000/); assert.match(expected.period, /Synthetic period P/);
    const fontEvidence = await evaluate(`(async()=>{await Promise.all([document.fonts.load('600 15px "IBM Plex Sans"','Шаҳноза'),document.fonts.load('800 34px "Onest"','Абдуллаева')]); await document.fonts.ready;
      return {status:document.fonts.status,plex:document.fonts.check('600 15px "IBM Plex Sans"','Шаҳноза'),
        onest:document.fonts.check('800 34px "Onest"','Абдуллаева'),loaded:[...document.fonts].filter(f=>f.status==='loaded').map(f=>f.family),
        resources:performance.getEntriesByType('resource').filter(e=>e.name.includes('.ttf')).map(e=>e.name)};})()`);
    assert(fontEvidence.plex && fontEvidence.onest && fontEvidence.loaded.some(f=>f.includes('IBM Plex Sans')) && fontEvidence.loaded.some(f=>f.includes('Onest')) && fontEvidence.resources.length===2, `worker local font evidence ${JSON.stringify(fontEvidence)}`);
    await dev.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const desktopFontStress = await evaluate(`(()=>{const name=document.querySelector('#workerNameHeader'),value=document.querySelector('#netPayAmount');
      const original=[name.textContent,value.textContent];name.textContent='Шаҳноза Абдуллаева';value.textContent="12 345 678 901 so'm (oraliq)";
      const data={scrollWidth:document.documentElement.scrollWidth,hero:document.querySelector('#heroCard').getBoundingClientRect().width};
      window.__visualFontRestore=()=>{name.textContent=original[0];value.textContent=original[1]};return data;})()`);
    assert(desktopFontStress.scrollWidth<=1440, `worker Cyrillic/amount 1440 ${JSON.stringify(desktopFontStress)}`);
    await capture('worker-desktop-font-stress.png'); await evaluate('window.__visualFontRestore()');
    const geometry = await evaluate(`(()=>{const hero=document.querySelector('#heroCard').getBoundingClientRect(), summary=document.querySelector('.work-summary').getBoundingClientRect(); return {heroTop:hero.top,summaryTop:summary.top,heroColor:getComputedStyle(document.querySelector('#heroCard')).backgroundColor}})()`);
    assert(geometry.summaryTop > geometry.heroTop + 100, 'payroll hero precedes separate work cards');
    assert.equal(await evaluate(`document.querySelector('#botNavTickets').click(); document.querySelector('#tabContentTickets').style.display !== 'none'`), true, 'existing bottom navigation action');
    await waitFor(() => evaluate(`document.querySelector('#ticketsList')?.innerText.includes('TEST-PARTY-4101')`), 'synthetic ticket history');
    assert.equal(await evaluate(`document.querySelector('#ticketsCountBadge').textContent`), '3');
    assert.equal(await evaluate(`document.querySelector('#ticketFilterCount').textContent`), '3 / 3 ta patta');
    const storageDenied = await evaluate(`(() => {
      const target=window.sessionStorage, original={};
      const calls = {getItem:0,setItem:0,removeItem:0};
      for (const name of Object.keys(calls)) {const descriptor=Object.getOwnPropertyDescriptor(Storage.prototype,name);original[name]=descriptor;
        Object.defineProperty(Storage.prototype,name,{...descriptor,value:function(...args){if(this===target){calls[name]++;throw Error('fixture denied Storage.'+name)}return descriptor.value.apply(this,args)}});}
      window.__filters2gStorageDenied={calls,original};
      const input=document.querySelector('#ticketHistorySearch');
      const set=value=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};
      set('5202'); const selected={ids:[...document.querySelectorAll('#ticketsList .ticket-item')].map(e=>e.innerText.match(/TEST-PARTY-\\d+/)?.[0]).filter(Boolean),count:document.querySelector('#ticketFilterCount').textContent};
       return {selected};
    })()`);
    assert.deepEqual(storageDenied.selected, {ids:['TEST-PARTY-5202'],count:'1 / 3 ta patta'});
    await dev.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.querySelector('#botNavTickets').click()`);
    await waitFor(() => evaluate(`document.querySelector('#botNavTickets').classList.contains('active') && document.querySelector('#tabContentTickets').style.display !== 'none'`), 'denied-storage filtered ticket view');
    await capture('filters-2g-worker-denied-storage.png');
    const storageRemainder = await evaluate(`(() => {
      const target=window.sessionStorage;
      const set=value=>{const input=document.querySelector('#ticketHistorySearch');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};
      set('nothing-matches'); const empty={rows:document.querySelectorAll('#ticketsList .ticket-item').length,count:document.querySelector('#ticketFilterCount').textContent};
      set(''); const cleared={rows:document.querySelectorAll('#ticketsList .ticket-item').length,count:document.querySelector('#ticketFilterCount').textContent};
      const readFallback=readWorkerTicketSearch(); let removeDenied=false; try{window.sessionStorage.removeItem(workerTicketSearchKey())}catch{removeDenied=true;}
       const denied=window.__filters2gStorageDenied;
       for(const name of Object.keys(denied.original)) Object.defineProperty(Storage.prototype,name,denied.original[name]);
       return {empty,cleared,calls:denied.calls,readFallback,removeDenied};
    })()`);
    Object.assign(storageDenied, storageRemainder);
    assert.deepEqual(storageDenied.empty, {rows:0,count:'0 / 3 ta patta'});
    assert.deepEqual(storageDenied.cleared, {rows:3,count:'3 / 3 ta patta'});
    assert(storageDenied.calls.getItem > 0 && storageDenied.calls.setItem > 0 && storageDenied.removeDenied && storageDenied.readFallback === '', `denied Storage get/set/remove paths were exercised: ${JSON.stringify(storageDenied)}`);
    await evaluate(`document.querySelector('#ticketHistorySearch').focus()`);
    await dev.send('Input.insertText', { text: '5202' });
    await waitFor(() => evaluate(`document.querySelectorAll('#ticketsList .ticket-item').length === 1`), 'worker ID search');
    assert.equal(await evaluate(`document.querySelector('#ticketsList').innerText.includes('TEST-PARTY-5202') && !document.querySelector('#ticketsList').innerText.includes('TEST-PARTY-4101')`), true);
    assert.equal(await evaluate(`document.querySelector('#ticketsCountBadge').textContent`), '1');
    await capture('filters-2e-worker-selected-ticket.png');
    await evaluate(`(()=>{const el=document.querySelector('#ticketHistorySearch');el.value='nothing-matches';el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    assert.equal(await evaluate(`document.querySelectorAll('#ticketsList .ticket-item').length === 0 && document.querySelector('#ticketFilterCount').textContent === '0 / 3 ta patta'`), true);
    await evaluate(`(()=>{const el=document.querySelector('#ticketHistorySearch');el.value='';el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    assert.equal(await evaluate(`document.querySelectorAll('#ticketsList .ticket-item').length`), 3);
    await evaluate(`document.querySelector('#ticketHistorySearch').focus()`);
    await dev.send('Input.insertText', { text: liveFixture ? 'Zero' : 'Synthetic hem' });
    await dev.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await dev.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.equal(await evaluate(`document.querySelectorAll('#ticketsList .ticket-item').length`), 1, 'keyboard-enter retains filtered result');
    await dev.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= 390 && document.querySelector('.work-summary').getBoundingClientRect().width > 350`), true, 'mobile work cards fit viewport');
    const mobileStress = await evaluate(`(()=>{const name=document.querySelector('#workerNameHeader'),value=document.querySelector('#netPayAmount');
      const original=[name.textContent,value.textContent];name.textContent='Шаҳноза Абдуллаева';value.textContent="12 345 678 901 so'm (oraliq)";
      const data={nameVisible:name.getBoundingClientRect().width>0,heroWidth:document.querySelector('#heroCard').getBoundingClientRect().width,
        scrollWidth:document.documentElement.scrollWidth,valueWidth:value.getBoundingClientRect().width,valueScroll:value.scrollWidth};
      window.__visualFontRestore=()=>{name.textContent=original[0];value.textContent=original[1]};return data;})()`);
    assert(mobileStress.nameVisible && mobileStress.scrollWidth<=390 && mobileStress.heroWidth<=390, `worker Cyrillic/long-amount 390 ${JSON.stringify(mobileStress)}`);
    await capture('worker-mobile-font-stress.png'); await evaluate('window.__visualFontRestore()');
    await capture('worker-mobile-tickets.png');
    await evaluate(`document.querySelector('#botNavOps').click()`);
    await waitFor(() => evaluate(`document.querySelector('#tabContentOps').style.display !== 'none'`), 'operations tab');
    await capture('worker-mobile-operations.png');
    await evaluate(`(()=>{const el=document.querySelector('#ticketHistorySearch');el.value='6303';el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    const beforeRefresh = profileHits;
    await evaluate(`document.querySelector('#refreshBtn').click()`);
    await waitFor(() => profileHits > beforeRefresh, 'safe refresh profile response');
    await waitFor(() => ticketsHits >= profileHits, 'safe refresh ticket response');
    assert.equal(await evaluate(`document.querySelector('#ticketHistorySearch').value === '6303' && document.querySelectorAll('#ticketsList .ticket-item').length === 1`), true, 'filter remains scoped through data rerender');
    assert.equal(await evaluate(`document.querySelector('#netPayAmount').textContent.includes('oraliq')`), true);
    await dev.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await capture('worker-desktop-operations.png');
    await dev.send('Page.reload');
    await waitFor(() => evaluate(`document.querySelector('#workerNameHeader')?.textContent === 'Synthetic Worker 731' && document.querySelector('#ticketHistorySearch')?.value === '6303' && document.querySelectorAll('#ticketsList .ticket-item').length === 1`), 'session-scoped search after actual document reload');
    if (!liveFixture) {
      await dev.send('Page.navigate', { url: `http://127.0.0.1:${port}/worker-app?workerId=${workerId}&companyId=hisob_test_worker_other&telegramId=${telegramId}&expiresAt=${expiresAt}&authToken=${token}` });
      await waitFor(() => evaluate(`document.querySelector('#workerNameHeader')?.textContent === 'Synthetic Worker 731' && document.querySelector('#ticketHistorySearch')?.value === ''`), 'company-isolated search state');
      await dev.send('Page.navigate', { url: `http://127.0.0.1:${port}/worker-app?workerId=${workerId}&companyId=${companyId}&telegramId=987654321&expiresAt=${expiresAt}&authToken=${token}` });
      await waitFor(() => evaluate(`document.querySelector('#workerNameHeader')?.textContent === 'Synthetic Worker 731' && document.querySelector('#ticketHistorySearch')?.value === ''`), 'actor-isolated search state');
      await dev.send('Page.navigate', { url: `http://127.0.0.1:${port}/worker-app?workerId=${workerId}&companyId=${companyId}&telegramId=${telegramId}&expiresAt=${expiresAt}&authToken=${token}` });
      await waitFor(() => evaluate(`document.querySelector('#ticketHistorySearch')?.value === '6303'`), 'original worker search restored only to matching actor/company');
    }
    await evaluate(`document.querySelector('#botNavAbout').click()`);
    await waitFor(() => evaluate(`document.querySelector('#botNavAbout').classList.contains('active') && document.querySelector('#tabContentAbout').style.display !== 'none'`), 'profile tab navigation');
    assert.equal(await evaluate(`document.querySelector('#aboutWorkerId').textContent`), '#731');
    assert.equal(await evaluate(`document.querySelector('#aboutCompanyId').textContent`), companyId);
    assert.match(await evaluate(`document.querySelector('#tabContentAbout').innerText`), /boshqa ishchilar va korxonaning umumiy ko'rsatkichlarini ko'ra olmaysiz/);
    await capture('worker-desktop-profile.png');
    // Mobile screenshots are captured after setting a real narrow viewport as well.
    await dev.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate(`document.querySelector('#botNavOps').click()`);
    await waitFor(() => evaluate(`document.querySelector('#botNavOps').classList.contains('active') && document.querySelector('#tabContentOps').style.display !== 'none'`), 'mobile operations navigation');
    await capture('worker-mobile-final.png');
    await evaluate(`document.querySelector('#botNavAbout').click()`);
    await capture('worker-mobile-profile.png');
    await dev.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    assert.equal(await evaluate(`getComputedStyle(document.body).colorScheme`), 'light', 'worker document remains readable in dark host preference');
    await capture('worker-mobile-dark-host.png');
    assert(profileHits >= 2 && ticketsHits >= 2);
    assert.deepEqual(externalRequests, [], 'no non-loopback HTTP(S) request was attempted');
    assert.deepEqual(pageErrors, [], 'no uncaught worker JavaScript exception');
    assert(!blocked.some(reason => /ERR_(NAME_NOT_RESOLVED|CONNECTION_REFUSED)/.test(reason)), `unexpected failed resource: ${blocked.join(',')}`);
    console.log(JSON.stringify({ result: 'PASS', inlineSyntax: 'node --check on extracted temporary .cjs', viewportEvidence: screenshots, expected, fontEvidence, desktopFontStress, mobileStress, storageDenied, pageErrors, apiReads: { profileHits, ticketsHits }, remoteDependency: 'Telegram SDK tag replaced with local stub; remote DNS denied; local font assets only' }, null, 2));
    ws.close();
  } finally {
    if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await delay(300);
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
