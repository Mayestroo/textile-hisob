const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, session } = require('electron');

const root = path.resolve(__dirname, '../../..');
const output = path.join(root, '.opencode/deep-audit/output');
const preview20w10m = process.env.VISUAL_PREVIEW_20W10M === '1';
if (preview20w10m && process.env.VISUAL_NORMAL_PREVIEW === '1') throw new Error('Conflicting preview profiles');
const fixtureRoot = path.join(output, preview20w10m
  ? 'local-test-db/redesign-preview-20w10m-20261107'
  : process.env.VISUAL_NORMAL_PREVIEW === '1'
  ? 'local-test-db/redesign-preview-normal-20261107-01'
  : process.env.VISUAL_FONTS_PROOF === '1' ? 'local-test-db/redesign-preview-font-proof-04' : 'local-test-db/redesign-preview');
const companyId = 'hisob_test_browser';
const previewUrl = 'http://127.0.0.1:4178/scripts/verify/fixtures/payroll-display-fixture.html';
const statusFile = path.join(output, 'redesign-local-preview-status.json');
fs.mkdirSync(path.join(fixtureRoot, 'electron-user-data'), { recursive: true });
app.setPath('userData', path.join(fixtureRoot, 'electron-user-data'));

for (const key of ['DATABASE_URL', 'DIRECT_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD',
  'TELEGRAM_BOT_TOKEN', 'BOT_TOKEN', 'CUSTOMER_PROFILE', 'NODE_OPTIONS']) delete process.env[key];

app.commandLine.appendSwitch('no-sandbox');
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = ['file:', 'devtools:'].some((prefix) => details.url.startsWith(prefix));
    try {
      const url = new URL(details.url);
      allowed ||= ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
        && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    } catch {}
    callback({ cancel: !allowed });
  });

  const manager = require(path.join(root, 'apps/desktop/electron/database/core/databaseManager.cjs'));
  const db = manager.getCompanyDatabase(fixtureRoot, companyId);
  const now = '2026-11-05T09:00:00.000Z';
  if (preview20w10m) {
    const names = ['Шаҳноза Абдуллаева','Мадина Раҳимова','Гулноза Каримова','Дилноза Тошпўлатова','Нилуфар Саидова',
      'Зуҳра Исмоилова','Моҳира Қодирова','Феруза Ҳамидова','Севара Юсупова','Мунира Нурматова','Ойгул Эргашева',
      'Лола Мирзаева','Насиба Холматова','Раъно Бердиева','Диёра Усмонова','Шоира Абдурахмонова','Меҳринисо Алиева',
      'Ситора Жўраева','Зилола Мамадалиева','Камола Ниёзова'];
    const modelNames = ['Синтетик Атлас','Синтетик Баҳор','Синтетик Чинор','Синтетик Дўппи','Синтетик Ёлқин',
      'Синтетик Зарафшон','Синтетик Ипак','Синтетик Камалак','Синтетик Лола','Синтетик Меҳр'];
    const sizeSets = [['XS','S','M','L','XL'],['S','M','L'],['M','L','XL','XXL'],['36','38','40','42'],
      ['XS','M','XL'],['44','46','48','50','52'],['S','M','L','XL'],['M','L'],['34','36','38','40','42'],['S','M','L','XL','XXL']];
    const insertWorker = db.prepare(`INSERT OR IGNORE INTO workers(id,company_id,name,staj,created_at,updated_at,provenance)
      VALUES(?,?,?,0,?,?,'TEST')`);
    names.forEach((name, index) => insertWorker.run(7201 + index, companyId, name, now, now));
    const insertModel = db.prepare(`INSERT OR IGNORE INTO models(id,company_id,name,title,hisob_sheet_name,operations_json,created_at,updated_at,provenance)
      VALUES(?,?,?,?,?,?,?,?, 'TEST')`);
    const insertSizes = db.prepare(`INSERT OR IGNORE INTO patta_batch_settings(company_id,model_id,party_number,is_custom_party,total_ish_soni,color,sizes_json,size_names_json,updated_at)
      VALUES(?,?, '',0,'','Синтетик', '{}',?,?)`);
    modelNames.forEach((name, index) => {
      const id = `preview-20w10m-model-${String(index + 1).padStart(2, '0')}`;
      const operations = [
        { id: `${id}-op-cut`, name: 'Бичиш', rate: 3 + index },
        { id: `${id}-op-sew`, name: 'Тикиш', rate: 5 + index },
        { id: `${id}-op-finish`, name: 'Пардозлаш', rate: 2 + index }
      ];
      insertModel.run(id, companyId, name, name, `${name}-ҳисоб`, JSON.stringify(operations), now, now);
      insertSizes.run(companyId, id, JSON.stringify(sizeSets[index]), now);
    });
    const workerCount = db.prepare('SELECT COUNT(*) AS n FROM workers WHERE company_id=?').get(companyId).n;
    const modelCount = db.prepare('SELECT COUNT(*) AS n FROM models WHERE company_id=?').get(companyId).n;
    if (workerCount !== 20 || modelCount !== 10) throw new Error(`Preview count guard failed: workers=${workerCount}, models=${modelCount}`);
  } else {
    db.prepare(`INSERT OR IGNORE INTO models(id,company_id,name,operations_json,created_at,updated_at)
      VALUES ('preview-model',?,'Sintetik model','[{"id":"sew","name":"Tikuv","rate":7}]',?,?)`).run(companyId, now, now);
    db.prepare(`INSERT OR IGNORE INTO workers(id,company_id,name,staj,created_at,updated_at)
      VALUES (7001,?,'TEST ishchi',0,?,?)`).run(companyId, now, now);
  }
  if (process.env.VISUAL_FONTS_PROOF === '1') {
    const insertWorker = db.prepare(`INSERT OR IGNORE INTO workers(id,company_id,name,staj,created_at,updated_at)
      VALUES (?, ?, ?, 0, ?, ?)`);
    for (let id = 7002; id <= 7015; id++) insertWorker.run(id, companyId,
      id === 7002 ? 'Шаҳноза Абдуллаева' : `Синтетик ишчи ${id}`, now, now);
    db.prepare(`INSERT OR IGNORE INTO tickets(id,company_id,model_id,period_id,party_number,patta_number,qty,status,is_closed,submitted_at,created_at,provenance)
      VALUES ('visual-font-large-money',?,'preview-model','PREVIEW-OPEN','FONT-PROOF',1,9999,'CONFIRMED',0,?,?,'TEST')`)
      .run(companyId, now, now);
    db.prepare(`INSERT OR IGNORE INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,worker_name_snapshot,rate_snapshot,qty,created_at)
      VALUES ('visual-font-large-money-entry','visual-font-large-money',?,'Tikuv',7002,'Шаҳноза Абдуллаева',999999999,9999,?)`)
      .run(companyId, now);
    db.prepare(`INSERT OR IGNORE INTO worker_adjustments(id,company_id,worker_id,period_id,type,amount,provenance,status,created_at)
      VALUES ('visual-font-long-money',?,7002,'PREVIEW-OPEN','AVANS',9876543210000,'TEST','POSTED',?)`)
      .run(companyId, now);
  }
  db.prepare(`INSERT OR IGNORE INTO periods(id,company_id,name,start_date,end_date,is_closed,archive_filename,created_at)
    VALUES ('PREVIEW-OPEN',?,'LOCAL TEST · Joriy davr','2026-11-01',NULL,0,NULL,?)`).run(companyId, now);
  if (process.env.VISUAL_NORMAL_PREVIEW === '1') {
    db.prepare(`UPDATE workers SET name='Sintetik ishchi', staj=1 WHERE company_id=? AND id=7001`).run(companyId);
    db.prepare(`INSERT OR IGNORE INTO tickets(id,company_id,model_id,period_id,party_number,patta_number,qty,status,is_closed,submitted_at,created_at,provenance)
      VALUES ('normal-preview-ticket',?,'preview-model','PREVIEW-OPEN','TEST',1,12,'CONFIRMED',0,?,?,'TEST')`).run(companyId, now, now);
    db.prepare(`INSERT OR IGNORE INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,worker_name_snapshot,rate_snapshot,qty,created_at)
      VALUES ('normal-preview-entry','normal-preview-ticket',?,'Tikuv',7001,'Sintetik ishchi',7,12,?)`).run(companyId, now);
    for (const [id, type, amount] of [['normal-avans','AVANS',4],['normal-jarima','JARIMA',3]]) {
      db.prepare(`INSERT OR IGNORE INTO worker_adjustments(id,company_id,worker_id,period_id,type,amount,provenance,status,created_at)
        VALUES (?, ?, 7001, 'PREVIEW-OPEN', ?, ?, 'TEST', 'POSTED', ?)`).run(id, companyId, type, amount, now);
    }
  }
  ipcMain.handle('db-read', (_event, requestedCompany) => requestedCompany === companyId
    ? { success: true, data: require(path.join(root, 'apps/desktop/electron/database/readers/workbookPayrollRead.cjs'))
      .readWorkbookPayrollProjection(db, companyId) }
    : { success: false, code: 'COMPANY_SCOPE_MISMATCH' });
  ipcMain.handle('payroll-read', () => ({ success: false, code: 'LOCAL_PREVIEW_READ_ONLY' }));
  ipcMain.handle('get-runtime-mode', () => ({ success: true, mode: 'sync' }));
  ipcMain.handle('outbox-diagnostics', (_event, requestedCompany) => requestedCompany === companyId
    ? { success: true, diagnostics: { pendingCount: 0, sendingCount: 0, conflictCount: 0,
      deadLetterCount: 0, failedOperations: [], pendingErrors: [] } }
    : { success: false, code: 'COMPANY_SCOPE_MISMATCH' });
  ipcMain.handle('outbox-pending', () => ({ success: true, pending: [] }));
  for (const channel of ['db-write', 'db-patch', 'command-submit-ticket', 'command-record-adjustment',
    'command-reverse-adjustment', 'command-resolve-reconciliation', 'workbook-command', 'ticket-draft-save',
    'sync-bootstrap', 'sync-dispatch', 'sync-pull', 'sync-reconnect', 'sync-manual', 'period-archive-read',
    'period-archive-write', 'archives-list', 'archives-list-meta', 'archive-read', 'archive-save']) {
    ipcMain.handle(channel, () => ({ success: false, code: 'LOCAL_PREVIEW_READ_ONLY',
      error: 'Writes and remote synchronization are disabled in this synthetic preview.' }));
  }

  const window = new BrowserWindow({ width: 1440, height: 980, show: true,
    title: 'Hisob — lokal redesign (TEST)', backgroundColor: '#f3f6fb',
    webPreferences: { preload: path.join(root, 'apps/desktop/electron/preload.cjs'),
      sandbox: true, nodeIntegration: false, contextIsolation: true } });
  window.setTitle('Hisob — lokal redesign (TEST)');
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => console.log(`RENDERER_CONSOLE ${level}: ${message} (${sourceId}:${line})`));
  window.webContents.on('did-fail-load', (_event, code, description, url) => console.error(`DID_FAIL_LOAD ${code} ${description} ${url}`));
  window.webContents.on('render-process-gone', (_event, details) => console.error(`RENDERER_GONE ${JSON.stringify(details)}`));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('closed', () => { manager.closeAllCompanyDatabases(); app.quit(); });
  try {
    await window.loadURL(previewUrl);
    const renderSummary = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = async () => {
        if (typeof window.renderLocalPreview === 'function') {
          try { resolve(await window.renderLocalPreview()); } catch (error) { reject(error); }
        } else if (Date.now() - started > 30000) reject(new Error('Local fixture renderer did not become ready'));
        else setTimeout(poll, 50);
      }; poll();
    })`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    window.restore();
    window.show();
    window.setAlwaysOnTop(true);
    window.focus();
    window.webContents.focus();
    setTimeout(() => {
      try { window.setAlwaysOnTop(false); } catch {}
    }, 1200);
    window.setTitle('Hisob — lokal redesign (TEST)');
    await window.webContents.executeJavaScript(`document.querySelector('.umumiy-report-search .soft-input')?.focus({ preventScroll: true, focusVisible: true })`);
    const fontEvidence = await window.webContents.executeJavaScript(`(async () => {
      await document.fonts.ready;
      return {
        ready: document.fonts.status,
        ibmPlexSans14: document.fonts.check('14px "IBM Plex Sans"', 'Ўзбекча'),
        ibmPlexSans600: document.fonts.check('600 14px "IBM Plex Sans"', 'Ўзбекча'),
        onest800: document.fonts.check('800 34px Onest', 'Ўзбекча'),
        loadedFaces: [...document.fonts].filter(face => face.status === 'loaded').map(face => ({ family: face.family, weight: face.weight, stretch: face.stretch, status: face.status })),
        fontResources: performance.getEntriesByType('resource').filter(item => /\\.ttf(?:$|\\?)/i.test(item.name)).map(item => item.name)
      };
    })()`);
    if (!fontEvidence.ibmPlexSans14 || !fontEvidence.ibmPlexSans600 || !fontEvidence.onest800
      || !fontEvidence.loadedFaces.some(face => face.family.replaceAll('"', '') === 'IBM Plex Sans')
      || !fontEvidence.loadedFaces.some(face => face.family.replaceAll('"', '') === 'Onest')) {
      throw new Error(`Preview font-face validation failed: ${JSON.stringify(fontEvidence)}`);
    }
    const rendered = await window.webContents.executeJavaScript(`(() => ({
      title: document.title,
      fixtureMarker: document.body.textContent.includes('LOCAL TEST FIXTURE'),
      activeSheet: document.querySelector('.excel-sidebar-item.active')?.textContent.trim() || 'Umumiy',
      report: !!(document.querySelector('.excel-grid-container') || document.querySelector('.umumiy-page') || document.querySelector('.excel-app')),
      payrollStatus: document.querySelector('.excel-grid-container [role="status"]')?.textContent || '',
      kpiValues: [...document.querySelectorAll('.umumiy-report .umumiy-kpi .kpi-value')].map(el => ({
        text: el.innerText.trim(), fontSize: getComputedStyle(el).fontSize, long: el.classList.contains('kpi-value-long'),
        width: el.clientWidth, scrollWidth: el.scrollWidth
      })),
      tableScroll: (() => { const el=document.querySelector('.umumiy-table-scroll'); return el && { scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,maxScrollLeft:el.scrollWidth-el.clientWidth }; })(),
      focusedSearch: (() => { const el=document.querySelector('.umumiy-report-search .soft-input'); if(!el)return null;const s=getComputedStyle(el);return {active:document.activeElement===el,outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,boxShadow:s.boxShadow,borderColor:s.borderColor}; })(),
      outsideAssets: performance.getEntriesByType('resource').filter(item => {
        try { return !['127.0.0.1','localhost'].includes(new URL(item.name).hostname) && new URL(item.name).protocol !== 'file:'; }
        catch { return false; }
      }).map(item => item.name),
       modelNavigation: [...document.querySelectorAll('.excel-sidebar-model-item')].map(el => ({
         name: el.querySelector('.excel-sidebar-model-title')?.textContent.trim() || '',
         title: el.title
       }))
     }))()`);
    rendered.fixtureCounts = renderSummary;
    rendered.windowTitle = window.getTitle();
    rendered.windowVisible = window.isVisible();
    if (!window.isVisible() || window.getTitle() !== 'Hisob — lokal redesign (TEST)' || !rendered.fixtureMarker || !rendered.report || rendered.outsideAssets.length
      || rendered.kpiValues.some(value => value.scrollWidth > value.width)) {
      throw new Error(`Preview safety/render check failed: ${JSON.stringify(rendered)}`);
    }
    if (preview20w10m) {
      if (renderSummary.workers !== 20 || renderSummary.models !== 10) {
        throw new Error(`Rendered preview count mismatch: ${JSON.stringify(renderSummary)}`);
      }
      const navigation = await window.webContents.executeJavaScript(`(async () => {
        const waitFor = async (predicate, label) => {
          const started = Date.now();
          while (!predicate()) {
            if (Date.now() - started > 5000) throw new Error('Preview navigation did not settle: ' + label);
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        };
        const toggle = document.querySelector('.excel-sidebar-floating-toggle.closed');
        if (toggle) toggle.click();
        await waitFor(() => document.querySelector('.excel-sidebar.open'), 'drawer open');
        const drawer = document.querySelector('.excel-sidebar.open');
        const models = [...drawer.querySelectorAll('.excel-sidebar-model-item')];
        if (models.length !== 10) throw new Error('Expected 10 visible model tabs, got ' + models.length);
        const navigated = [];
        for (const item of models) {
          const name = item.querySelector('.excel-sidebar-model-title')?.textContent.trim();
          if (!name) throw new Error('Model navigation entry has no visible name');
          item.click();
          await waitFor(() => [...drawer.querySelectorAll('.excel-sidebar-model-item')]
            .some(node => node.classList.contains('active') && node.querySelector('.excel-sidebar-model-title')?.textContent.trim() === name), name + ' model tab');
          const active = [...drawer.querySelectorAll('.excel-sidebar-model-item')]
            .find(node => node.classList.contains('active') && node.querySelector('.excel-sidebar-model-title')?.textContent.trim() === name);
          const hisob = active?.querySelector('.excel-sidebar-action-btn[title$="— Model hisob-kitobini ochish"]');
          if (!hisob) throw new Error('Missing actual hisob navigation action for ' + name);
          const expected = hisob.title.split(' — ')[0];
          hisob.click();
          await waitFor(() => {
            const selected = [...drawer.querySelectorAll('.excel-sidebar-model-item')]
              .find(node => node.classList.contains('active') && node.querySelector('.excel-sidebar-model-title')?.textContent.trim() === name);
            return selected?.querySelector('.excel-sidebar-action-btn.active[title$="— Model hisob-kitobini ochish"]')
              && selected.querySelector('.excel-sidebar-action-btn.active').title.startsWith(expected + ' —');
          }, name + ' hisob tab');
          navigated.push({ model: name, hisob: expected });
        }
        const summary = drawer.querySelector('.excel-sidebar-nav-item[title="Umumiy oylik hisobot va ishchilar maoshi"]');
        if (!summary) throw new Error('Missing actual Umumiy navigation action');
        summary.click();
        await waitFor(() => drawer.querySelector('.excel-sidebar-nav-item.active') === summary, 'Umumiy return navigation');
        const reopen = document.querySelector('.excel-sidebar-floating-toggle.closed');
        if (reopen) reopen.click();
        await waitFor(() => document.querySelector('.excel-sidebar.open'), 'drawer visible for preview capture');
        return { drawerOpen: true, navigated };
      })()`);
      rendered.modelNavigation = navigation.navigated.map(item => item.hisob);
      if (!navigation.drawerOpen || navigation.navigated.length !== 10
        || rendered.modelNavigation.some((item) => !item.endsWith('-ҳисоб'))) {
        throw new Error(`Rendered preview navigation mismatch: ${JSON.stringify({ renderSummary, navigation })}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const screenshotPath = path.join(output, 'redesign-local-preview.png');
    fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
    const status = { state: 'ready', helperPid: Number(process.env.REDESIGN_PREVIEW_HELPER_PID),
      electronPid: process.pid, title: window.getTitle(), url: previewUrl, windowVisible: window.isVisible(),
      rendered, fontEvidence, screenshotPath, fixtureRoot, networkPolicy: 'file/devtools and loopback-only; all writes/sync fail closed' };
    fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
    console.log(`REDESIGN_PREVIEW_READY ${JSON.stringify(status)}`);
  } catch (error) {
    fs.writeFileSync(statusFile, JSON.stringify({ state: 'failed', electronPid: process.pid,
      error: String(error?.stack || error) }, null, 2));
    console.error(error);
    if (process.env.CI) { window.destroy(); app.quit(); }
  }
}).catch((error) => { console.error(error); app.quit(); process.exitCode = 1; });
