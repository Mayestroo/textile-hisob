'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const base = process.env.NOVDA_FINANCIAL_UI_URL;
assert.equal(new URL(base).hostname, '127.0.0.1');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'opencode', 'novda-financial-ui-')));
const windows = [];
app.on('window-all-closed', () => {}); // Keep the process alive across a closed-tab/reopen scenario.
const timeout = setTimeout(() => { console.error('FINANCIAL_UI_TIMEOUT'); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(base + '/') && !details.url.startsWith('devtools:') });
  });
  const open = async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    windows.push(window);
    await window.loadURL(base + '/admin-app');
    await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const deadline=Date.now()+15000;
      const check=()=>{if(document.body.classList.contains('company-admin-session'))resolve(true);
        else if(Date.now()>deadline)reject(Error('Actual admin authentication/startup failed: '+document.getElementById('authMessage').textContent));
        else setTimeout(check,30);};check();})`);
    return window;
  };
  const edit = (window, amount, note) => window.webContents.executeJavaScript(`(() => {
    window.confirm=()=>false;
    document.getElementById('companyToast').textContent='';
    document.querySelector('[data-co-tab="workers"]').click();
    const worker=[...document.querySelectorAll('.co-worker-row')].find(row=>row.textContent.includes('Retry Worker'));
    if(!worker)throw Error('Actual worker row missing'); worker.click();
    document.getElementById('companyDetailAdvance').click();
    const input=document.getElementById('companyAdvanceAmountInput'); input.value=${JSON.stringify(String(amount))};
    input.dispatchEvent(new Event('input',{bubbles:true}));
    document.getElementById('companyAdvanceNoteInput').value=${JSON.stringify(note)};
  })()`);
  const click = window => window.webContents.executeJavaScript(`document.getElementById('companyAdvanceSubmit').click()`);
  const waitToast = (window, text) => window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
    const deadline=Date.now()+15000; const check=()=>{
      const message=document.getElementById('companyToast').textContent;
      if(message.includes(${JSON.stringify(text)}) && (${JSON.stringify(text)}!=='saqlandi'
        || document.querySelector('[data-co-screen="advance-success"].is-active')))resolve(message);
      else if(Date.now()>deadline)reject(Error('Financial UI outcome '+${JSON.stringify(text)}+' missing: '+message));else setTimeout(check,30);};check();})`);
  const first = await open();
  await edit(first, 0, 'invalid');
  await click(first); await waitToast(first, 'musbat');
  assert.equal((await (await fetch(base + '/__fixture/writes')).json()).length, 0);
  await edit(first, 3, 'lost response');
  await fetch(base + '/__fixture/drop-next', { method: 'POST' });
  await first.webContents.executeJavaScript(`document.getElementById('companyAdvanceSubmit').click();document.getElementById('companyAdvanceSubmit').click();`);
  await waitToast(first, 'saqlanmadi');
  first.destroy(); // New document with the same durable localStorage, not injected state.
  const recovered = await open();
  const concurrent = await open();
  await edit(recovered, 3, 'lost response'); await edit(concurrent, 3, 'lost response');
  await Promise.all([click(recovered), click(concurrent)]);
  const concurrentOutcome = window => window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
    const deadline=Date.now()+15000;const check=()=>{const message=document.getElementById('companyToast').textContent;
      if(message.includes('ALREADY_COMPLETED') || (message==='Avans saqlandi.' && document.querySelector('[data-co-screen="advance-success"].is-active')))resolve(message);
      else if(Date.now()>deadline)reject(Error('Concurrent tab did not settle: '+message));else setTimeout(check,30);};check();})`);
  const outcomes = await Promise.all([concurrentOutcome(recovered), concurrentOutcome(concurrent)]);
  assert.equal(outcomes.filter(message => message.includes('ALREADY_COMPLETED')).length, 1);
  assert.equal(outcomes.filter(message => message === 'Avans saqlandi.').length, 1);
  await edit(recovered, 2, 'second advance'); await click(recovered); await waitToast(recovered, 'saqlandi');
  await edit(recovered, 5, 'third advance'); await click(recovered); await waitToast(recovered, 'saqlandi');
  const stale = await open();
  await edit(stale, 5, 'third advance'); await click(stale); await waitToast(stale, 'ALREADY_COMPLETED');
  const success = await recovered.webContents.executeJavaScript(`document.getElementById('companySuccessRemaining').textContent`);
  assert.match(success, /16/);
  await fetch(base + '/__fixture/hold-payroll', { method: 'POST' });
  const selectPeriod = periodId => recovered.webContents.executeJavaScript(`(() => {
    const select=document.getElementById('companyPeriodSelect');select.value=${JSON.stringify(periodId)};
    select.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await selectPeriod('Q');
  const heldDeadline = Date.now() + 10000;
  while (await (await fetch(base + '/__fixture/payroll-held')).text() !== 'yes') {
    assert(Date.now() < heldDeadline, 'Old-period request was not captured');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  await selectPeriod('R');
  await recovered.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,300))`);
  await fetch(base + '/__fixture/release-payroll', { method: 'POST' });
  await recovered.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,300))`);
  assert.equal(await recovered.webContents.executeJavaScript(`document.getElementById('companyNet').textContent.replace(/[^0-9-]/g,'')`), '16',
    'Late closed-period response overwrote the current-period money');
  await recovered.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-co-go="models"]').click();
    [...document.querySelectorAll('#companyModelChoices button')].find(button=>button.textContent==='Unknown tariff fixture').click();
    const known=document.querySelector('input[aria-label="Known narxi"]');
    const unknown=document.querySelector('input[aria-label="Unknown narxi"]');
    const zero=document.querySelector('input[aria-label="Zero narxi"]');
    if(unknown.value!=='' || zero.value!=='0')throw Error('Unknown and explicit zero are indistinguishable');
    known.value='9';known.dispatchEvent(new Event('input',{bubbles:true}));
    document.getElementById('companySaveRates').click();
  })()`);
  await waitToast(recovered, 'Noma’lum narxni 0');
  assert.equal((await (await fetch(base + '/__fixture/writes')).json()).length, 4, 'Unknown rate must block writes');
  await recovered.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('input[aria-label="Unknown narxi"]');input.value='0';input.dispatchEvent(new Event('input',{bubbles:true}));
    document.getElementById('companyToast').textContent='';document.getElementById('companySaveRates').click();
  })()`);
  await waitToast(recovered, 'Operatsiya narxlari saqlandi');
  console.log(`FINANCIAL_UI_PASS Electron ${process.versions.electron}: actual DOM 26->23->21->16; invalid amount, double click, lost response, reload, concurrent/stale tabs, late period response, unknown/zero tariff`);
  clearTimeout(timeout);
  app.quit();
}).catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1); });
