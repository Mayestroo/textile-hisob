'use strict';

// Isolated desktop acceptance: real main IPC, preload, renderer, SQLite and HTTP.
// Only the signed activation envelope is substituted (no production signing key).
// Device and operator credentials are genuine credentials issued on the local copy.
const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
assert.equal(process.env.NOVDA_AUDIT_DISPOSABLE, '1');
const config = JSON.parse(process.env.NOVDA_AUDIT_DESKTOP);
assert.equal(new URL(config.baseUrl).hostname, '127.0.0.1');
assert.equal(new URL(config.rendererUrl).hostname, '127.0.0.1');
assert(path.basename(config.profile).startsWith('novda-backup-workflows-'));
const root = path.resolve(__dirname, '../../..');
app.setPath('userData', config.profile);
process.env.NOVDA_SYNC_ENABLED = '1';
process.env.NODE_ENV = 'development';
process.env.NOVDA_SYNC_SERVER_URL = config.baseUrl;
const license = require('../../../apps/desktop/electron/license/license.cjs');
const activation = { isActivated: true, isBlocked: false, companyId: config.companyId,
  companyName: 'LOCAL BACKUP AUDIT', machineId: config.deviceId, activationId: 'isolated-local-audit',
  deviceCredentialReady: true, role: 'admin', status: 'active', requireTicketValidation: false };
license.checkLicenseStatus = () => ({ ...activation });
license.checkRemoteActivation = async () => ({ ...activation });
// Register exactly the shipped IPC handlers, without opening the shipped window.
const whenReady = app.whenReady.bind(app);
app.whenReady = () => ({ then() {} });
require('../../../apps/desktop/electron/main.cjs');
app.whenReady = whenReady;
let window;
const timeout = setTimeout(() => { console.error('DESKTOP_AUDIT_TIMEOUT'); app.exit(1); }, 120000);
whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: !['file:', 'devtools:'].includes(url.protocol)
      && !(['http:', 'ws:'].includes(url.protocol) && url.hostname === '127.0.0.1') });
  });
  require('../../../apps/desktop/electron/security/deviceCredentialStore.cjs')
    .storeDeviceCredential(config.companyId, config.token, { deviceId: config.deviceId });
  require('../../../apps/desktop/electron/security/operatorSessionStore.cjs')
    .storeOperatorSession(config.companyId, config.operatorToken, { baseDir: path.join(config.profile, 'credentials') });
  window = new BrowserWindow({ show: false, width: 1440, height: 980, webPreferences: {
    preload: path.join(root, 'apps/desktop/electron/preload.cjs'), contextIsolation: true,
    sandbox: true, nodeIntegration: false, backgroundThrottling: false
  } });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(String(message).slice(0, 200));
    if (String(message).startsWith('AUDIT_STEP:')) console.log(message);
  });
  await window.loadURL(config.rendererUrl);
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = async (condition, label) => {
      const deadline = Date.now() + 45000;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error('Desktop workflow timed out: ' + label);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    await wait(() => window.__store?.getState().models.length > 0, 'initial PostgreSQL bootstrap');
    const store = window.__store;
    await wait(() => store.getState().isServerConnected, 'pull-first reconnect');
    const before = store.getState();
    const checks = ['real App + AuthGate startup + main IPC bootstrap + reconnect'];
    const risks = [];
    const summary = { models: before.models.length, workers: before.workers.length,
      tickets: before.submittedTickets.length, periodStart: before.currentPeriod.startDate };
    const controlBase = ${JSON.stringify(config.fixtureControlBase)};
    if (${JSON.stringify(config.restartProbe === 'write-offline')}) {
      const worker = before.workers[0];
      const expectedAvans = worker.avans + 11;
      await fetch(controlBase + '/__fixture/offline/on', { method: 'POST' });
      if (!await store.getState().updateWorker(worker.id, { avans: expectedAvans }, { immediate: true }))
        throw new Error('Pre-restart offline write rejected');
      const pending = await window.electronAPI.OutboxDiagnostics(before.licenseStatus.companyId);
      if (!pending.diagnostics.pendingCount) throw new Error('Pre-restart outbox is not durable');
      return { summary, checks: ['offline renderer write committed before process shutdown'], risks: [],
        restartExpected: { workerId: worker.id, avans: expectedAvans } };
    }
    const restartExpected = ${JSON.stringify(config.restartExpected || null)};
    if (restartExpected) {
      await window.electronAPI.SyncReconnect(before.licenseStatus.companyId);
      await window.electronAPI.SyncReconnect(before.licenseStatus.companyId);
      const recovered = await window.electronAPI.dbRead(before.licenseStatus.companyId);
      if (recovered.data.workers.find(row => row.id === restartExpected.workerId)?.avans !== restartExpected.avans)
        throw new Error('Electron process restart lost or duplicated the durable offline write');
      const diagnostics = (await window.electronAPI.OutboxDiagnostics(before.licenseStatus.companyId)).diagnostics;
      if (diagnostics.pendingCount || diagnostics.deadLetterCount || diagnostics.conflictCount)
        throw new Error('Post-restart offline operation did not settle');
      checks.push('full Electron process restart replays durable offline balance exactly once');
    }
    for (const sheet of ['Umumiy', 'Patta', 'Patta-hisob', 'Konveyer', 'Modellar-jami', 'Operatsiya-narxlari',
      before.models[0].name, before.models[0].hisobSheetName]) {
      store.getState().setActiveSheet(sheet);
      await new Promise(resolve => setTimeout(resolve, 150));
      if (!document.querySelector('#root')?.textContent?.trim()) throw new Error('Empty real application view');
      if (document.body.textContent.includes('Something went wrong')) throw new Error('Renderer error boundary');
    }
    checks.push('navigation through eight real workbook views with production backup rows');
    // Synthetic unknown/zero editor state over a real backed-up model. The first
    // blocked save must not reach SQLite. Only explicit prices may create a real
    // UpsertModel command; restore the model's original prices afterwards.
    const rateModel = store.getState().models.find(model => model.operations.length >= 2);
    const rateModelOriginal = structuredClone(rateModel);
    const canonicalRatesBefore = (await window.electronAPI.dbRead(before.licenseStatus.companyId)).data.models
      .find(model => model.id === rateModel.id).operations;
    store.getState().setActiveSheet('Umumiy');
    await new Promise(resolve => setTimeout(resolve, 100));
    store.setState({ models: [{ ...rateModel, operations: rateModel.operations.map((operation, index) =>
      ({ ...operation, rate: index === 0 ? null : index === 1 ? 0 : operation.rate })) },
      ...store.getState().models.filter(model => model.id !== rateModel.id)] });
    store.getState().setActiveSheet('Operatsiya-narxlari');
    await wait(() => document.querySelectorAll('.rates-rate-input').length >= 2, 'actual tariff editor');
    const tariffInputs = [...document.querySelectorAll('.rates-rate-input')];
    if (tariffInputs[0].value !== '' || tariffInputs[1].value !== '0')
      throw new Error('Desktop tariff editor collapsed unknown and zero');
    const setRate = (index, value) => {
      const input = document.querySelectorAll('.rates-rate-input')[index];
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setRate(1, '9'); await new Promise(resolve => setTimeout(resolve, 100));
    document.querySelector('.rates-btn-save').click();
    await new Promise(resolve => setTimeout(resolve, 150));
    const blockedRates = (await window.electronAPI.dbRead(before.licenseStatus.companyId)).data.models
      .find(model => model.id === rateModel.id).operations;
    if (JSON.stringify(blockedRates) !== JSON.stringify(canonicalRatesBefore))
      throw new Error('Unknown desktop tariff was persisted as zero');
    setRate(0, '0'); await new Promise(resolve => setTimeout(resolve, 100));
    document.querySelector('.rates-btn-save').click();
    await wait(() => store.getState().models.find(model => model.id === rateModel.id)?.operations[0].rate === 0,
      'explicit zero desktop tariff command');
    await window.electronAPI.SyncReconnect(before.licenseStatus.companyId);
    const explicitRates = (await window.electronAPI.dbRead(before.licenseStatus.companyId)).data.models
      .find(model => model.id === rateModel.id).operations;
    if (explicitRates[0].rate !== 0 || explicitRates[1].rate !== 9)
      throw new Error('Explicit desktop tariff did not survive server replay');
    if (!await store.getState().updateModelOperations(rateModel.id, rateModelOriginal.operations))
      throw new Error('Could not restore original disposable-model tariff');
    await window.electronAPI.SyncReconnect(before.licenseStatus.companyId);
    checks.push('actual desktop tariff DOM: unknown stays blank, explicit zero visible, unknown save blocked, explicit 0/9 reaches SQLite/HTTP/PG');
    const draftModels = before.models.slice(0, 2);
    const draftStarted = performance.now();
    store.getState().updateTicketField(draftModels[0].id, 'qty', '31');
    store.getState().updateTicketField(draftModels[1].id, 'qty', '47');
    let drafts;
    do {
      await new Promise(resolve => setTimeout(resolve, 100));
      drafts = await window.electronAPI.dbRead(before.licenseStatus.companyId);
      if (drafts.data.ticketForms[draftModels[0].id]?.qty === '31'
        && drafts.data.ticketForms[draftModels[1].id]?.qty === '47') break;
    } while (performance.now() - draftStarted < 10000);
    if (drafts.data.ticketForms[draftModels[0].id]?.qty !== '31'
      || drafts.data.ticketForms[draftModels[1].id]?.qty !== '47')
      throw new Error('Switching models dropped a debounced ticket draft after 10s persistence budget');
    checks.push('two model drafts persist independently through real debounce and SQLite IPC');
    for (const period of before.periods.filter(row => row.isClosed)) {
      const archive = await window.electronAPI.PeriodArchiveRead({ companyId: before.licenseStatus.companyId,
        filename: period.archiveFilename || period.id });
      if (!archive.success) {
        if (archive.code === 'ARCHIVE_TICKET_PERIOD_UNKNOWN') {
          risks.push({ workflow: 'legacy closed-period archive', code: archive.code,
            unresolvedTickets: archive.details?.unresolvedTicketIds?.length || null });
          continue;
        }
        throw new Error('Backup archive read failed: ' + archive.code);
      }
      if (archive.periodId !== period.id || archive.payrollValuation.period.periodId !== period.id)
        throw new Error('Backup archive lost period binding');
      if (!archive.payrollValuation.accountingReasons.includes('HISTORICAL_BASELINE_UNVERIFIED'))
        throw new Error('Legacy archive reading incorrectly certified uncertain historical balances');
    }
    if (!risks.length) checks.push('real closed-period archives validate and return bound payroll through shipped IPC');
    const worker = before.workers[0];
    const saved = await store.getState().updateWorker(worker.id, { avans: worker.avans + 10 }, { immediate: true });
    if (!saved) throw new Error('Real renderer worker update rejected');
    await window.electronAPI.SyncReconnect(before.licenseStatus.companyId);
    const read = await window.electronAPI.dbRead(before.licenseStatus.companyId);
    if (!read.success || read.data.workers.find(row => row.id === worker.id).avans !== worker.avans + 10)
      throw new Error('Real renderer AVANS did not persist exactly once');
    checks.push('renderer AVANS change -> real IPC -> outbox -> HTTP -> PostgreSQL -> projection');
    const gateway = ${JSON.stringify(config.fixtureControlBase)};
    if (gateway) {
      const expectedAvans = store.getState().workers.find(row => row.id === worker.id).avans + 7;
      await fetch(gateway + '/__fixture/offline/on', { method: 'POST' });
      if (!await store.getState().updateWorker(worker.id, { avans: expectedAvans }, { immediate: true }))
        throw new Error('Offline AVANS edit was not committed locally');
      await window.electronAPI.SyncReconnect(before.licenseStatus.companyId);
      const pending = await window.electronAPI.OutboxDiagnostics(before.licenseStatus.companyId);
      if (!pending.diagnostics.pendingCount) throw new Error('Interrupted write was not retained in the durable outbox');
      await store.getState().initStore(before.licenseStatus.companyId);
      if (store.getState().workers.find(row => row.id === worker.id).avans !== expectedAvans)
        throw new Error('Renderer rehydration lost the committed offline balance');
      await fetch(gateway + '/__fixture/offline/off', { method: 'POST' });
      await window.electronAPI.SyncReconnect(before.licenseStatus.companyId);
      await window.electronAPI.SyncReconnect(before.licenseStatus.companyId);
      const recovered = await window.electronAPI.dbRead(before.licenseStatus.companyId);
      if (recovered.data.workers.find(row => row.id === worker.id).avans !== expectedAvans)
        throw new Error('Reconnection duplicated or lost the offline AVANS');
      checks.push('interrupted HTTP + durable offline AVANS + renderer rehydration + repeated reconnect preserve exactly one change');
    }
    const { runReconnect } = await import('/apps/desktop/renderer/store/businessMutations.ts');
    const model = store.getState().models.find(row => row.operations.some(op => Number.isFinite(op.rate)));
    const operation = model.operations.find(op => Number.isFinite(op.rate));
    const companyId = before.licenseStatus.companyId;
    const beforeTicketRead = (await window.electronAPI.dbRead(companyId)).data;
    const beforePiecework = beforeTicketRead.payrollValuation.workers.find(row => row.workerId === worker.id).pieceworkGross;
    for (const [field, value] of Object.entries({ date: before.currentPeriod.startDate, qty: '2', party: '', patta: '',
      strictParty: false, strictPatta: false, size: model.size, color: model.color }))
      store.getState().updateTicketField(model.id, field, value);
    store.getState().setTicketWorker(model.id, operation.name, worker.id);
    const existingIds = new Set(store.getState().submittedTickets.map(row => row.id));
    if (!await store.getState().jonatish(model.id)) throw new Error('Real renderer ticket submission rejected');
    await runReconnect(window.electronAPI, companyId);
    const afterSubmitRead = (await window.electronAPI.dbRead(companyId)).data;
    let tickets = afterSubmitRead.submittedTickets;
    const ticket = tickets.find(row => !existingIds.has(row.id) && row.modelId === model.id);
    if (!ticket || ticket.status !== 'CONFIRMED') throw new Error('Ticket was not accepted by real API');
    if (afterSubmitRead.payrollValuation.workers.find(row => row.workerId === worker.id).pieceworkGross !== beforePiecework + 2 * operation.rate)
      throw new Error('Accepted work failed the independent quantity-times-tariff payroll delta');
    checks.push('real renderer ticket form -> command -> outbox -> authorized PostgreSQL fact');
    if (!await store.getState().updateOperationRate(model.id, operation.name, operation.rate + 1))
      throw new Error('Real renderer model rate update rejected');
    await runReconnect(window.electronAPI, companyId);
    const changedWorkerId = before.workers.find(row => row.id !== worker.id).id;
    if (!await store.getState().updateSubmittedTicket(ticket.id,
      ticket.entries.map(entry => ({ ...entry, workerId: changedWorkerId }))))
      throw new Error('Real renderer ticket worker edit rejected');
    await runReconnect(window.electronAPI, companyId);
    tickets = (await window.electronAPI.dbRead(companyId)).data.submittedTickets;
    const edited = tickets.find(row => row.id === ticket.id);
    if (!edited || edited.entries[0].workerId !== changedWorkerId || edited.entries[0].rateSnapshot !== operation.rate)
      throw new Error('Ticket edit mismatch ' + JSON.stringify({ status: edited?.status,
        worker: edited?.entries[0]?.workerId, expectedWorker: changedWorkerId,
        rate: edited?.entries[0]?.rateSnapshot, expectedRate: operation.rate,
        diagnostics: (await window.electronAPI.OutboxDiagnostics(companyId)).diagnostics }));
    checks.push('model tariff change + ticket worker reassignment preserve the original wage snapshot');
    if (!await store.getState().deleteSubmittedTicket(ticket.id)) throw new Error('Real renderer ticket deletion rejected');
    await runReconnect(window.electronAPI, companyId);
    if ((await window.electronAPI.dbRead(companyId)).data.submittedTickets.some(row => row.id === ticket.id))
      throw new Error('Deleted ticket remains in the active workbook');
    checks.push('ticket deletion -> server VOIDED fact -> removal from active workbook');
    store.getState().setActiveSheet('Umumiy');
    console.info('AUDIT_STEP: Oklad input');
    await wait(() => document.querySelector('input[aria-label="Oklad #' + worker.id + '"]'), 'rendered payroll editor');
    const moneyInput = document.querySelector('input[aria-label="Oklad #' + worker.id + '"]');
    if (moneyInput.disabled) throw new Error('Current-period Oklad editor is unexpectedly disabled');
    const expectedOklad = store.getState().workers.find(row => row.id === worker.id).oklad + 25;
    moneyInput.focus();
    console.info('AUDIT_STEP: Oklad focused');
    await new Promise(resolve => setTimeout(resolve, 50));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(moneyInput, String(expectedOklad));
    moneyInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(expectedOklad) }));
    moneyInput.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
    moneyInput.blur();
    document.querySelector('.umumiy-report-search input')?.focus();
    moneyInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.activeElement }));
    console.info('AUDIT_STEP: Oklad blurred');
    try {
      await wait(() => store.getState().workers.find(row => row.id === worker.id).oklad === expectedOklad, 'Oklad blur commit');
    } catch (error) {
      throw new Error('Oklad DOM commit ' + JSON.stringify({ expectedOklad, actualOklad: store.getState().workers.find(row => row.id === worker.id).oklad,
        value: moneyInput.value, invalid: moneyInput.getAttribute('aria-invalid'), notifications: store.getState().notifications.slice(-3).map(row => row.title) }));
    }
    await runReconnect(window.electronAPI, companyId);
    if ((await window.electronAPI.dbRead(companyId)).data.workers.find(row => row.id === worker.id).oklad !== expectedOklad)
      throw new Error('DOM Oklad edit failed to persist exactly once');
    checks.push('actual Oklad input focus/type/blur -> canonical period-bound persisted balance');
    if (${JSON.stringify(config.lifecycle)}) {
      const beforeClose = (await window.electronAPI.dbRead(companyId)).data;
      const endDate = beforeClose.currentPeriod.startDate;
      const next = new Date(endDate + 'T00:00:00Z');
      next.setUTCDate(next.getUTCDate() + 1);
      const nextDate = next.toISOString().slice(0, 10);
      if (!await store.getState().closeCurrentPeriod(endDate, 'Local audit next period', nextDate))
        throw new Error('Real renderer period close rejected');
      await runReconnect(window.electronAPI, companyId);
      const afterClose = (await window.electronAPI.dbRead(companyId)).data;
      if (afterClose.currentPeriod.startDate !== nextDate || afterClose.currentPeriod.isClosed)
        throw new Error('Period close did not create the correct next open period');
      if (afterClose.nextPattaNumber !== beforeClose.nextPattaNumber)
        throw new Error('Month close unexpectedly reset the patta sequence');
      const archive = await window.electronAPI.PeriodArchiveRead({ companyId, filename: beforeClose.currentPeriod.id });
      if (!archive.success || archive.data.period.startDate !== endDate || archive.data.period.endDate !== endDate)
        throw new Error('New authoritative archive is unreadable or has shifted calendar dates: ' + archive.code);
      checks.push('real renderer month close -> PostgreSQL archive -> next period -> retained patta numbering -> readable archive');
    }
    return { summary, checks, risks };
  })()`);
  assert.equal(errors.length, 0, 'Renderer emitted errors: ' + errors.join(' | '));
  console.log('BACKUP_DESKTOP_RESULT ' + JSON.stringify({ status: result.risks.length ? 'partial' : 'passed', electronVersion: process.versions.electron, ...result }));
  clearTimeout(timeout);
  app.quit();
}).catch(error => {
  console.error('BACKUP_DESKTOP_FAILED ' + error.message);
  clearTimeout(timeout);
  app.exit(1);
});
