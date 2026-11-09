// Isolated production renderer fixture; reads only the own disposable SQLite company.
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { spawnSync } = require('node:child_process');
const { canonicalStringify, computePayloadHash } = require('../../../apps/desktop/electron/database/canonicalPayload.cjs');
const root = path.resolve(__dirname, '../../..');
const localDbRoot = path.join(root, '.opencode/deep-audit/output/local-test-db');
const filters2bRun = process.env.FILTERS_2B_ONLY === '1' ? `filters-2b-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}` : '';
const filters2cRun = process.env.FILTERS_2C_ONLY === '1' ? `filters-2c-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}` : '';
const filters2dRun = process.env.FILTERS_2D_ONLY === '1' ? `filters-2d-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}` : '';
const filters2aActorRun = process.env.FILTERS_2A_ACTOR_STORAGE_ONLY === '1' ? `filters-2a-actor-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}` : '';
const filters2gRun = process.env.FILTERS_2G_ONLY === '1' ? `filters-2g-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}` : '';
const pattaJumpRun = process.env.PATTA_JUMP_ONLY === '1' ? `patta-jump-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}` : '';
const modelSizesCRun = process.env.MODEL_SIZES_C_ONLY === '1' ? `model-sizes-c-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}` : '';
const isolatedFiltersRun = filters2bRun || filters2cRun || filters2dRun || filters2aActorRun || filters2gRun || pattaJumpRun || modelSizesCRun;
const fixtureRoot = process.env.MODEL_SIZES_C_FIXTURE_ROOT || process.env.FILTERS_FIXTURE_ROOT || process.env.FILTERS_2B_FIXTURE_ROOT || (isolatedFiltersRun ? path.join(localDbRoot, `${isolatedFiltersRun}-sqlite`) : localDbRoot);
const outDir = process.env.MODEL_SIZES_C_RENDER_DIR || process.env.FILTERS_RENDER_DIR || process.env.FILTERS_2B_RENDER_DIR || (isolatedFiltersRun ? path.join(localDbRoot, `${isolatedFiltersRun}-renderer`) : path.join(localDbRoot, process.env.MONEY_1C_ONLY === '1' ? 'renderer-fixture-money-1c' : 'renderer-fixture'));
function parseCsv(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted && ch === '"' && text[i + 1] === '"') { value += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { row.push(value); value = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(value); if (row.some((cell) => cell !== '')) rows.push(row);
      row = []; value = '';
    } else value += ch;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}
if (process.env.PAYROLL_RENDER_CHILD === '1') {
    const { app, BrowserWindow, ipcMain } = require('electron');
  app.commandLine.appendSwitch('no-sandbox');
  app.whenReady().then(async () => {
    app.setPath('userData', path.join(fixtureRoot, modelSizesCRun ? `isolated-electron-user-data-${modelSizesCRun}` : process.env.MONEY_1C_ONLY === '1'
      ? `isolated-electron-user-data-money1c-${process.pid}` : 'isolated-electron-user-data'));
    const { session } = require('electron');
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      try { const url = new URL(details.url); allowed = ['file:', 'devtools:'].includes(url.protocol) ||
        (['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)); } catch {}
      callback({ cancel: !allowed });
    });
    const manager = require('../../../apps/desktop/electron/database/databaseManager.cjs');
    const { readWorkbookPayrollProjection, readPeriodPayrollProjection } = require('../../../apps/desktop/electron/database/workbookPayrollRead.cjs');
    let db = manager.getCompanyDatabase(fixtureRoot, 'hisob_test_browser');
    const moneyCompany = `hisob_test_money_1c_${process.pid}`;
    let rejectNextMoneyCommand = false;
    let holdNextMoneyCommand = false;
    let releaseHeldMoneyCommand = null;
    let moneyDb = manager.getCompanyDatabase(fixtureRoot, moneyCompany);
    if (moneyDb.prepare('SELECT COUNT(*) AS n FROM workers WHERE company_id=?').get(moneyCompany).n !== 0
      || moneyDb.prepare('SELECT COUNT(*) AS n FROM models WHERE company_id=?').get(moneyCompany).n !== 0) {
      throw Error('money 1c fixture company unexpectedly already contains data');
    }
    const moneyNow = '2026-11-06T10:00:00.000Z';
    moneyDb.transaction(() => {
      moneyDb.prepare(`INSERT INTO models(id,company_id,name,operations_json,created_at,updated_at,provenance)
        VALUES ('m',?,'Money fixture','[{"id":"sew","name":"Sew","rate":50000}]',?,?,'TEST')`)
        .run(moneyCompany, moneyNow, moneyNow);
      const insertWorker = moneyDb.prepare(`INSERT INTO workers(id,company_id,name,staj,role,status,server_revision,created_at,updated_at,provenance)
        VALUES (?,?,?, ?,NULL,'ACTIVE',1,?,?,'REMOTE_BOOTSTRAP')`);
      for (let id = 7; id <= 41; id++) insertWorker.run(id, moneyCompany, `Worker ${id}`, id === 7 ? 25000 : 0, moneyNow, moneyNow);
      moneyDb.prepare(`INSERT INTO periods(id,company_id,name,start_date,end_date,is_closed,status,server_revision,created_at,updated_at,provenance)
        VALUES ('P',?,'Current','2026-11-01',NULL,0,'OPEN',1,?,?,'REMOTE_BOOTSTRAP'),
          ('Q',?,'Closed','2026-10-01','2026-10-31',1,'CLOSED',1,?,?,'REMOTE_BOOTSTRAP')`)
        .run(moneyCompany, moneyNow, moneyNow, moneyCompany, moneyNow, moneyNow);
      moneyDb.prepare(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,patta_number,qty,status,is_closed,submitted_at,created_at,provenance)
        VALUES ('money-ticket',?,'m','P','1',1,10,'CONFIRMED',0,?,?,'REMOTE_BOOTSTRAP')`).run(moneyCompany, moneyNow, moneyNow);
      moneyDb.prepare(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,worker_name_snapshot,rate_snapshot,qty,created_at)
        VALUES ('money-entry','money-ticket',?,'Sew',7,'Worker 7',50000,10,?)`).run(moneyCompany, moneyNow);
      moneyDb.prepare(`INSERT INTO worker_adjustments(id,company_id,worker_id,period_id,type,amount,provenance,status,created_at)
        VALUES ('money-avans',?,7,'P','AVANS',200000,'REMOTE_BOOTSTRAP','POSTED',?),
          ('money-jarima',?,7,'P','JARIMA',50000,'REMOTE_BOOTSTRAP','POSTED',?)`)
        .run(moneyCompany, moneyNow, moneyCompany, moneyNow);
    }).immediate();
     const e3Only = process.env.REDESIGN_E3_ONLY === '1';
     const c1Only = process.env.REDESIGN_C1_ONLY === '1' || (e3Only && process.env.REDESIGN_C2_ONLY !== '1');
      const c2Only = process.env.REDESIGN_C2_ONLY === '1';
    ipcMain.handle('get-runtime-mode', () => ({ success: true, mode: 'sync' }));
    ipcMain.handle('outbox-diagnostics', (_event, companyId) => companyId === 'hisob_test_browser'
      ? { success: true, diagnostics: { pendingCount: 0, sendingCount: 0, conflictCount: 0, deadLetterCount: 0, failedOperations: [], pendingErrors: [] } }
      : { success: false, code: 'COMPANY_SCOPE_MISMATCH' });
    ipcMain.handle('outbox-pending', () => ({ success: true, pending: [] }));
      for (const channel of ['sync-bootstrap', 'sync-dispatch', 'sync-pull', 'sync-reconnect', 'sync-manual',
      'db-write', 'db-patch', 'payroll-read', 'payroll-read-period', 'command-submit-ticket',
      'command-record-adjustment', 'command-reverse-adjustment', 'command-resolve-reconciliation',
      'workbook-command', 'ticket-draft-save', 'period-archive-write',
      'archives-list', 'archives-list-meta', 'archive-read', 'archive-save', 'backups-list', 'backup-read',
      'backup-restore', 'license-status', 'license-activate', 'license-request-activation', 'license-set-company',
      'license-set-validation', 'app-update-check', 'app-update-download', 'download-app-update',
      'install-app-update', 'get-data-dir', 'get-app-version', 'print-html', 'get-license-status']) {
      ipcMain.handle(channel, () => ({ success: false, code: 'LOCAL_PREVIEW_READ_ONLY',
        error: 'Unsupported writes and remote synchronization are disabled in this synthetic fixture.' }));
      }
     if (process.env.MONEY_1C_ONLY === '1') {
        const { executeWorkbookCommand } = require('../../../apps/desktop/electron/database/workbookCommandPipeline.cjs');
        const moneyLicense = { isActivated: true, isTrial: true, isBlocked: false, deviceCredentialReady: true,
          companyId: moneyCompany, activationId: 'money-1c-local-only', machineId: 'money-1c-local-only', role: 'admin' };
        ipcMain.removeHandler('license-status');
        ipcMain.handle('license-status', () => moneyLicense);
         ipcMain.removeHandler('workbook-command');
         ipcMain.handle('workbook-command', (_event, command) => {
           if (command?.companyId !== moneyCompany || command?.commandType !== 'UpsertWorker')
            return { success: false, code: 'COMPANY_SCOPE_MISMATCH', error: '1c fixture command scope rejected' };
          if (rejectNextMoneyCommand) {
            rejectNextMoneyCommand = false;
            return { success: false, code: 'FIXTURE_COMMAND_REJECTED', error: 'Synthetic rejection; no fact written.' };
          }
          try { return { success: true, result: executeWorkbookCommand(fixtureRoot, moneyCompany, command) }; }
          catch (error) { return { success: false, code: error?.code || 'WORKBOOK_COMMAND_FAILED', error: error?.message || String(error) }; }
       });
     }
     let capturedPattaHtml = '';
      if (process.env.MODEL_SIZES_C_ONLY === '1') {
       const { executeWorkbookCommand } = require('../../../apps/desktop/electron/database/workbookCommandPipeline.cjs');
       const allowed = new Set(['UpdateBatchSettings', 'CompletePattaBatch']);
       ipcMain.removeHandler('workbook-command');
       ipcMain.handle('workbook-command', (_event, command) => {
         if (command?.companyId !== 'hisob_test_browser' || !allowed.has(command?.commandType))
           return { success: false, code: 'MODEL_SIZES_FIXTURE_SCOPE', error: 'Stage C fixture rejects command scope/type.' };
         try { return { success: true, result: executeWorkbookCommand(fixtureRoot, 'hisob_test_browser', command) }; }
         catch (error) { return { success: false, code: error?.code || 'WORKBOOK_COMMAND_FAILED', error: error?.message || String(error) }; }
       });
       ipcMain.removeHandler('print-html');
       ipcMain.handle('print-html', (_event, options) => {
         if (!options || typeof options.html !== 'string' || !options.html.includes('<html'))
           return { success: false, error: 'Invalid Stage C generated HTML.' };
         capturedPattaHtml = options.html;
         fsSync.writeFileSync(path.join(outDir, 'generated-patta-stage-c.html'), capturedPattaHtml, 'utf8');
         return { success: true };
       });
     }
     if (process.env.REDESIGN_E5_ESCAPE_ONLY === '1') {
       ipcMain.removeHandler('download-app-update');
       ipcMain.handle('download-app-update', () => new Promise(() => {}));
     }
    ipcMain.removeHandler('get-app-version');
    ipcMain.handle('get-app-version', () => ({ success: true, version: '1.1.9-local-test' }));
    ipcMain.removeHandler('get-data-dir');
    ipcMain.handle('get-data-dir', () => ({ success: true, path: fixtureRoot }));
        const runVisualExisting = async () => {
          const shots = path.join(fixtureRoot, 'visual-existing-screenshots');
          fsSync.mkdirSync(shots, { recursive: true });
          const entries = [];
          const measure = () => window.webContents.executeJavaScript(`(() => {
            const box = e => { const r=e?.getBoundingClientRect(); return r && {x:r.x,y:r.y,width:r.width,height:r.height}; };
            const root=document.querySelector('.phase-b-view,.phase-c-modal,.umumiy-report');
            const scrollers=[...document.querySelectorAll('.umumiy-table-scroll,.e2c-hisob-grid,.e2c-conveyor-scroll,.e2b-entry-scroll,.journal-party-table,.e3-detail-table')].map(e=>({className:e.className,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}));
            const table=document.querySelector('.phase-b-view table,.phase-c-modal table,.umumiy-report table');
            const row=table?.querySelector('tbody tr.fast-row,tbody tr.e2b-entry-op,tbody tr.journal-model-row,tbody tr');
            const headings=[...document.querySelectorAll('.phase-b-view h1,.phase-b-view h2,.phase-c-modal h2,.umumiy-report h1')].map(e=>({text:e.textContent?.trim().slice(0,65),rect:box(e),font:getComputedStyle(e).fontSize}));
            return {viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,zoom:visualViewport?.scale,theme:document.documentElement.getAttribute('data-theme'),
              root:box(root),headings, cards:[...document.querySelectorAll('.phase-b-view .e2b-batch-card,.phase-b-view .journal-kpi,.phase-b-view .e2c-conveyor-kpis > div,.umumiy-report .umumiy-kpi')].slice(0,5).map(box),
              modal:box(document.querySelector('.modal-overlay .modal-card')),search:box(document.querySelector('.phase-b-view input[type=search],.umumiy-report-search input,.e3-detail-search input')),
              table:box(table),header:box(table?.querySelector('thead tr')),row:box(row),input:box(document.querySelector('.e2b-entry-op input,.e2c-hisob-grid tbody input')),
              scrollers,conveyorGrid:document.querySelector('.e2c-conveyor-kpis') && getComputedStyle(document.querySelector('.e2c-conveyor-kpis')).gridTemplateColumns,
              provisional:document.body.textContent.includes('Taxminiy'),fixture:document.body.textContent.includes('LOCAL TEST FIXTURE'),
              external:performance.getEntriesByType('resource').filter(e=>{try{const u=new URL(e.name);return u.protocol!=='file:' && !['127.0.0.1','localhost'].includes(u.hostname)}catch{return false}}).length};
          })()`);
          const capture = async (name, mount, width, dark) => {
            window.setContentSize(width, 1000);
            await window.webContents.executeJavaScript(`document.documentElement.${dark ? 'setAttribute("data-theme","dark")' : 'removeAttribute("data-theme")'}`);
            await window.webContents.executeJavaScript(mount);
            await new Promise(resolve=>setTimeout(resolve, 300));
            window.showInactive();
            const geometry=await measure();
            if (geometry.viewport[0] !== width || geometry.dpr !== 1 || geometry.zoom !== 1 || geometry.external || !geometry.fixture || !geometry.root)
              throw Error('visual capture guard '+name+' '+JSON.stringify(geometry));
            const file=path.join(shots, name+'.png');
            fsSync.writeFileSync(file,(await window.webContents.capturePage()).toPNG());
            entries.push({name,file,geometry});
          };
          const surfaces=[['patta-batch','window.renderE2B("batch")'],['patta-entry','window.renderE2B("entry")'],
            ['patta-journal','window.renderE2AJournal()'],['konveyer','window.renderE2C("conveyor")'],
            ['hisob','window.renderE2C("hisob")'],['worker-detail','window.renderPhaseCModal("worker-detail")'],
            ['period-manager','window.renderPhaseCModal("period-manager")']];
          for (const [name,mount] of surfaces) {
            for (const [suffix,width,dark] of [['1920',1920,false],['1440',1440,false],['760-dark',760,true]])
              await capture(name+'-'+suffix,mount,width,dark);
          }
          window.setContentSize(760,1000);
          const interactions = await window.webContents.executeJavaScript(`(async()=>{
            const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
            window.renderE2AJournal(); await pause();
            const model=document.querySelector('.journal-model-row'); model?.click(); await pause();
            document.querySelector('.journal-party-table > tbody > tr')?.click(); await pause();
            const journal={expanded:model?.getAttribute('aria-expanded')==='true',tickets:document.querySelectorAll('.journal-party-table table tbody tr').length};
            window.renderE2C('hisob'); await pause();
            const grid=document.querySelector('.e2c-hisob-grid').parentElement;
            grid.scrollLeft=grid.scrollWidth; await pause();
            const hesab={horizontal:grid.scrollLeft>0,lastColumn:document.querySelector('.e2c-hisob-grid thead tr:last-child td:last-child')?.textContent};
            window.renderE2C('conveyor'); await pause();
            const checkbox=document.querySelector('.phase-b-konveyer input[type=checkbox]'); checkbox?.click(); await pause();
            const conveyor={toggled:!!checkbox?.checked,grid:getComputedStyle(document.querySelector('.e2c-conveyor-kpis')).gridTemplateColumns};
            window.renderE2B('entry'); await pause();
            const first=document.querySelector('.e2b-entry-meta input[type=text]'); first?.focus(); first?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); await pause();
            const entry={nextFocused:document.activeElement===document.querySelectorAll('.e2b-entry-meta input[type=text]')[1]};
            window.renderPhaseCModal('period-manager'); await pause();
            const archive=[...document.querySelectorAll('.phase-c-period-manager button')].find(e=>e.textContent.includes('Yopilgan Oylar Arxivi')); archive?.click(); await pause();
            return {journal,hesab,conveyor,entry,period:{archiveTab:document.querySelector('.phase-c-period-manager')?.textContent.includes('Arxiv')}};
          })()`);
          if (!interactions.journal.expanded || interactions.journal.tickets!==3 || !interactions.hesab.horizontal || !interactions.conveyor.toggled
            || !interactions.entry.nextFocused || !interactions.period.archiveTab || !interactions.conveyor.grid.split(' ').every(col=>parseFloat(col)>=250))
            throw Error('visual interactions '+JSON.stringify(interactions));
          let referenceChecks = null;
          if (process.env.VISUAL_REFERENCE_FIX_ONLY === '1') {
            const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
            const save = async name => fsSync.writeFileSync(path.join(shots,name+'.png'),(await window.webContents.capturePage()).toPNG());
            const evalUi = expression => window.webContents.executeJavaScript(expression);
            const drawer = {};
            await evalUi('window.renderE5App()');
            await evalUi(`(()=>{window.e5Role('admin');const s=window.__store.getState();window.__store.setState({licenseStatus:{...s.licenseStatus,isActivated:true,isTrial:true,isBlocked:false,companyId:'hisob_test_browser',role:'admin',machineId:'visual-fixture',activationId:'visual-fixture',remainingText:'LOCAL TEST'},modalState:{type:null},checkLicense:async()=>{},initStore:async()=>{}});
              s.models[0].name='Шаҳноза Абдуллаева · Синтетик жуда узун модел номи';
              window.dispatchEvent(new KeyboardEvent('keydown',{key:'b',ctrlKey:true,bubbles:true}));})()`);
            for (const [key,width,dark] of [['1440',1440,false],['760-dark',760,true]]) {
              window.setContentSize(width,1000);
              await evalUi(`document.documentElement.setAttribute('data-theme',${JSON.stringify(dark?'dark':'light')})`);
              await pause(320); window.showInactive();
              if(await evalUi('Boolean(document.querySelector(".modal-overlay"))'))throw Error('drawer capture obscured by modal');
              drawer[key]=await evalUi(`(()=>{const root=document.querySelector('.excel-sidebar.open'),main=root?.querySelector('.excel-sidebar-content > .excel-sidebar-item'),
                model=root?.querySelector('.excel-sidebar-model-item'),section=root?.querySelector('.excel-sidebar-section-title'),close=root?.querySelector('.excel-sidebar-close-tab');
                if(!root||!main||!model||!section||!close)throw Error('drawer missing');
                model.focus();const r=e=>{const b=e.getBoundingClientRect();return {x:b.x,width:b.width,height:b.height}};
                return {viewport:innerWidth,drawer:r(root),main:r(main),mainFont:getComputedStyle(main).fontSize,model:r(model),modelFont:getComputedStyle(model).fontSize,
                  captionFont:getComputedStyle(section).fontSize,close:r(close),focus:document.activeElement===model,
                  fullModelTitle:model.title,longModel:root.textContent.includes('Шаҳноза'),reportScroll:document.querySelector('.umumiy-table-scroll')?.scrollWidth};})()`);
              await save('drawer-'+key);
              const v=drawer[key]; if(v.drawer.width!==(dark?340:340)||v.main.height!==42||v.model.height!==38||v.mainFont!=='15px'||v.captionFont!=='12px'||!v.focus||!v.longModel||v.close.x<0||v.close.x>width-20)
                throw Error('drawer geometry '+JSON.stringify(v));
            }
            drawer.escape=await evalUi(`(async()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await new Promise(r=>setTimeout(r,300));
              const closed=!document.querySelector('.excel-sidebar.open');window.dispatchEvent(new KeyboardEvent('keydown',{key:'b',ctrlKey:true,bubbles:true}));
              await new Promise(r=>setTimeout(r,300));document.querySelector('.excel-sidebar-close-tab')?.click();await new Promise(r=>setTimeout(r,300));
              const sc=document.querySelector('.umumiy-table-scroll');sc.scrollLeft=sc.scrollWidth;const reportScrolled=sc.scrollLeft>0;
              window.e5Role('type');window.__store.getState().setActiveSheet(window.__store.getState().models[0].hisobSheetName);
              await new Promise(r=>setTimeout(r,150));const typeHisob=!!document.querySelector('.phase-b-hisob');
              window.e5Role('print');window.__store.getState().setActiveSheet('Umumiy');await new Promise(r=>setTimeout(r,150));
              const printDenied=!document.querySelector('.umumiy-report');window.e5Role('admin');
              return {closed,handleClosed:!document.querySelector('.excel-sidebar.open'),reportScrolled,typeHisob,printDenied};})()`);
            if(!drawer.escape.closed||!drawer.escape.handleClosed||!drawer.escape.reportScrolled||!drawer.escape.typeHisob||!drawer.escape.printDenied)throw Error('drawer Escape/handle/roles '+JSON.stringify(drawer.escape));
            const sheets=[];
            for(const [key,width,dark] of [['1920',1920,false],['1440',1440,false],['760-dark',760,true]]) {
              window.setContentSize(width,1000);
              await evalUi(`(()=>{window.e5Role('admin');const s=window.__store.getState();s.setActiveSheet(s.models[0].hisobSheetName);document.documentElement.setAttribute('data-theme',${JSON.stringify(dark?'dark':'light')});})()`);
              await pause(350);
              if(await evalUi('Boolean(document.querySelector(".modal-overlay"))'))throw Error('Hisob capture obscured by modal');
              await evalUi(`(()=>{const s=document.querySelector('.e2c-hisob-grid').parentElement;s.scrollTop=0;s.scrollLeft=0;})()`);
              await pause(180);
              const base=await evalUi(`(()=>{const root=document.querySelector('.phase-b-hisob');if(!root)throw Error('Hisob absent sheet='+window.__store.getState().activeSheet+' role='+window.__store.getState().licenseStatus?.role+' text='+document.body.innerText.slice(-250));const scroll=root.querySelector('.e2c-hisob-grid').parentElement,
                h=root.querySelectorAll('thead tr'),row=root.querySelector('tbody tr.fast-row'),input=row.querySelector('input[title*="Ish sonini"]');
                return {viewport:innerWidth,dpr:devicePixelRatio,zoom:visualViewport?.scale,headerBands:[...h].map(e=>e.getBoundingClientRect().height),
                  rowHeight:row.getBoundingClientRect().height,inputHeight:input.getBoundingClientRect().height,inputFont:getComputedStyle(input).fontSize,
                  bodyFont:getComputedStyle(row.cells[1]).fontSize,cells:row.cells.length,operations:window.__store.getState().models[0].operations.length,
                  workers:window.__store.getState().workers.length,scrollWidth:scroll.scrollWidth,clientWidth:scroll.clientWidth,
                  qty:input.value,money:root.textContent.includes('≈ 84'),unknown:root.textContent.includes('Noma’lum')};})()`);
              await save('hisob-reference-'+key);
              if(base.viewport!==width||base.dpr!==1||base.zoom!==1||base.headerBands.reduce((a,b)=>a+b,0)!==76||base.rowHeight!==44||base.inputHeight!==34||base.inputFont!=='15px'||base.bodyFont!=='15px'||base.operations!==15||base.cells!==33||base.workers!==222||base.qty!=='12'||(!base.money&&!base.unknown))
                throw Error('Hisob reference geometry '+JSON.stringify(base));
              const action=await evalUi(`(async()=>{const pause=ms=>new Promise(r=>setTimeout(r,ms)),s=document.querySelector('.e2c-hisob-grid').parentElement,
                input=document.querySelector('tbody tr.fast-row input[title*="Ish sonini"]'),set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
                input.focus();set.call(input,'15');input.dispatchEvent(new Event('input',{bubbles:true}));await pause(80);
                const draft=input.value;input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await pause(90);
                const restored=document.querySelector('tbody tr.fast-row input[title*="Ish sonini"]')?.value;
                const frames=[];for(let i=0;i<8;i++){const start=performance.now();s.scrollTop=Math.min(s.scrollHeight,(i+1)*s.scrollHeight/8);await new Promise(r=>requestAnimationFrame(r));frames.push(performance.now()-start)}
                s.scrollTop=s.scrollHeight;s.scrollLeft=s.scrollWidth;await pause(300);
                const r=document.querySelector('tbody tr.fast-row'),h=document.querySelector('thead tr'),h2=document.querySelector('thead tr:nth-child(2)');
                return {draft,restored,frames,scrollLeft:s.scrollLeft,maxScrollLeft:s.scrollWidth-s.clientWidth,scrollTop:s.scrollTop,scrollHeight:s.scrollHeight,clientHeight:s.clientHeight,
                  last:[...document.querySelectorAll('tbody tr.fast-row')].some(row=>row.cells[0]?.textContent.trim()==='1220'),
                  headerTop:h.getBoundingClientRect().top,secondTop:h2.getBoundingClientRect().top,scrollTopScreen:s.getBoundingClientRect().top,
                  idDrift:Math.abs(r.cells[0].getBoundingClientRect().x-h.cells[0].getBoundingClientRect().x),
                  nameDrift:Math.abs(r.cells[1].getBoundingClientRect().x-h.cells[1].getBoundingClientRect().x)};})()`);
              await save('hisob-reference-'+key+'-end');
              if(action.draft!=='15'||action.restored!=='12'||!action.last||action.scrollLeft<=0||action.scrollLeft<action.maxScrollLeft-2||action.scrollTop<=0||Math.abs(action.headerTop-action.scrollTopScreen)>2||Math.abs(action.secondTop-action.headerTop-44)>2||action.idDrift>2||action.nameDrift>2||action.frames.some(ms=>ms>500))throw Error('Hisob virtual scroll/edit '+JSON.stringify(action));
              if(key==='1440') {
                action.filter=await evalUi(`(async()=>{const input=document.querySelector('.e2c-hisob-search input'),set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
                  set.call(input,'Demo worker');input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,180));
                  const h=document.querySelector('.e2c-hisob-grid thead'),filtered=document.querySelectorAll('.e2c-hisob-grid tbody tr.fast-row').length,
                    clearedTransform=h.style.transform==='',selected=document.querySelector('.e2c-hisob-grid tbody tr.fast-row')?.cells[0].textContent.trim();
                  set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,180));
                  return {filtered,selected,clearedTransform,restored:document.querySelector('.e2c-hisob-filter-count')?.textContent};})()`);
                if(action.filter.filtered!==1||action.filter.selected!=='7'||!action.filter.clearedTransform||!action.filter.restored?.includes('222'))throw Error('Hisob filter header restoration '+JSON.stringify(action.filter));
              }
              sheets.push({key,base,action});
            }
            const conveyor=[];
            for(const [key,width,dark] of [['1920-light',1920,false],['1440-light',1440,false],['760-light',760,false],['1920-dark',1920,true],['1440-dark',1440,true],['760-dark',760,true]]) {
              window.setContentSize(width,1000);
              await evalUi(`window.renderE2C('conveyor');document.documentElement.setAttribute('data-theme',${JSON.stringify(dark?'dark':'light')})`);
              await pause(240);
              const geometry=await evalUi(`(()=>{const cards=[...document.querySelectorAll('.e2c-kpi-card')],r=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}},
                last=cards[3],icon=last.querySelector('.e2c-kpi-icon'),value=last.querySelector('.e2c-kpi-value'),reason=last.querySelector('.e2c-kpi-explanation');
                return {viewport:innerWidth,theme:document.documentElement.getAttribute('data-theme'),cards:cards.map(r),icon:r(icon),value:r(value),reason:r(reason),
                  unknown:last.textContent.includes('Noma’lum'),reasonText:reason.textContent,rows:document.querySelectorAll('.e2c-conveyor-matrix > tbody > tr').length};})()`);
              await save('conveyor-reference-'+key);
              if(geometry.viewport!==width||geometry.cards.length!==4||geometry.icon.width!==52||!geometry.unknown||!geometry.reasonText.includes('noma’lum')||geometry.reason.scrollWidth>geometry.reason.clientWidth+1||geometry.value.scrollWidth>geometry.value.clientWidth+1||geometry.cards[0].height>135 && width===1440)
                throw Error('conveyor geometry '+JSON.stringify(geometry));
              const longStress=await evalUi(`(()=>{const value=document.querySelector('.e2c-kpi-money .e2c-kpi-value'),before=value.textContent;
                value.textContent='≈ 12 345 678 901 so‘m';const card=value.closest('.e2c-kpi-card'),reason=card.querySelector('.e2c-kpi-explanation');
                const result={cardHeight:card.getBoundingClientRect().height,valueWidth:value.clientWidth,valueScroll:value.scrollWidth,
                  reasonWidth:reason.clientWidth,reasonScroll:reason.scrollWidth,reasonVisible:reason.getBoundingClientRect().bottom<=card.getBoundingClientRect().bottom-8};
                window.__restoreConveyorMoney=()=>{value.textContent=before};return result;})()`);
              await save('conveyor-reference-'+key+'-long-stress');await evalUi('window.__restoreConveyorMoney()');
              if(longStress.valueScroll>longStress.valueWidth+1||longStress.reasonScroll>longStress.reasonWidth+1||!longStress.reasonVisible)
                throw Error('conveyor long amount overflow '+JSON.stringify({key,longStress}));
              conveyor.push({key,geometry,longStress});
            }
            referenceChecks={drawer,sheets,conveyor};
          }
          await capture('main-1980','window.renderE1Report()',1980,false);
          await capture('main-760-dark','window.renderE1Report()',760,true);
          const evidence={fixtureRoot,shots,entries,interactions,referenceChecks};
          fsSync.writeFileSync(path.join(shots,'evidence.json'),JSON.stringify(evidence,null,2));
          console.log('VISUAL_EXISTING_PASS '+JSON.stringify({fixtureRoot,shots,entries:entries.length,referenceFix:!!referenceChecks}));
        };
        if (process.env.REDESIGN_E5A_ONLY === '1') {
      ipcMain.removeHandler('license-status');
      ipcMain.handle('license-status', () => ({ isActivated: true, isTrial: true, isBlocked: false,
        companyId: 'hisob_test_browser', activationId: 'e5a-local-only', machineId: 'e5a-local-only',
        role: 'admin', remainingText: 'LOCAL TEST' }));
    }
    let fixtureDbReads = 0;
    ipcMain.handle('db-read', (_event, companyId) => {
      fixtureDbReads++;
      if (process.env.MONEY_1C_ONLY === '1' && companyId === moneyCompany)
        return { success: true, data: readWorkbookPayrollProjection(manager.getCompanyDatabase(fixtureRoot, moneyCompany), moneyCompany) };
      return companyId === 'hisob_test_browser'
        ? { success: true, data: readWorkbookPayrollProjection(db, companyId) }
        : { success: false, code: 'COMPANY_SCOPE_MISMATCH' };
    });
    ipcMain.handle('period-archive-read', (_event, request) => {
      if (request?.companyId !== 'hisob_test_browser' || typeof request.filename !== 'string')
        return { success: false, code: 'COMPANY_SCOPE_MISMATCH' };
      const archive = db.prepare(`SELECT p.id AS periodId, a.archive_json AS archiveJson
        FROM periods p JOIN period_archives a ON a.company_id = p.company_id AND a.period_id = p.id
        WHERE p.company_id = ? AND (p.id = ? OR p.archive_filename = ?) LIMIT 1`)
        .get(request.companyId, request.filename, request.filename);
      if (!archive) return { success: false, code: 'PERIOD_ARCHIVE_READ_FAILED' };
      const data = JSON.parse(archive.archiveJson);
      return { success: true, companyId: request.companyId, periodId: archive.periodId, data,
        payrollValuation: readPeriodPayrollProjection(db, request.companyId, archive.periodId, data) };
    });
    let window = new BrowserWindow({ width: 1440, height: 1000, show: false,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true,
         preload: path.join(root, 'apps/desktop/electron/preload.cjs') } });
    window.webContents.on('console-message', (_event, level, message, line, sourceId) =>
      console.error(`RENDERER_${level} ${message} ${sourceId}:${line}`));
    try {
      db.exec('BEGIN');
      const company = 'hisob_test_browser', now = '2026-09-15T12:00:00Z';
      if (process.env.FILTERS_2A_ONLY === '1' || process.env.FILTERS_2A_ACTOR_STORAGE_ONLY === '1') {
        const addFilterWorker = db.prepare(`INSERT INTO workers(id,company_id,name,staj,created_at,updated_at)
          VALUES (?,? ,?,0,?,?)`);
        addFilterWorker.run(8, company, 'Filter Fixture Eight', now, now);
        addFilterWorker.run(9, company, 'Filter Fixture Nine', now, now);
      }
      if (process.env.PATTA_JUMP_ONLY === '1') {
        const { executeWorkbookCommand } = require('../../../apps/desktop/electron/database/workbookCommandPipeline.cjs');
        ipcMain.removeHandler('workbook-command');
        ipcMain.handle('workbook-command', (_event, command) => {
          if (command?.companyId !== 'hisob_test_browser' || command?.commandType !== 'UpdateTicket')
            return { success: false, code: 'PATTA_JUMP_SCOPE', error: 'PATTA_JUMP fixture allows only scoped UpdateTicket.' };
          try { return { success: true, result: executeWorkbookCommand(fixtureRoot, 'hisob_test_browser', command) }; }
          catch (error) { return { success: false, code: error?.code || 'WORKBOOK_COMMAND_FAILED', error: error?.message || String(error) }; }
        });
      }
      if (process.env.FILTERS_2C_ONLY === '1') {
        const addFilterWorker = db.prepare(`INSERT INTO workers(id,company_id,name,staj,created_at,updated_at) VALUES (?,? ,?,0,?,?)`);
        addFilterWorker.run(8, company, 'Payroll Filter Eight', now, now);
        addFilterWorker.run(9, company, 'Payroll Filter Nine', now, now);
      }
       db.prepare(`INSERT INTO models(id,company_id,name,operations_json,created_at,updated_at)
         VALUES ('m',?,'Demo',?,?,?)`).run(company, process.env.PATTA_JUMP_ONLY === '1'
           ? '[{"id":"sew","name":"Sew","rate":7},{"id":"hem","name":"Hem","rate":4}]'
           : '[{"id":"sew","name":"Sew","rate":7}]', now,now);
       if (process.env.MODEL_SIZES_C_ONLY === '1') {
         db.prepare(`INSERT INTO models(id,company_id,name,operations_json,created_at,updated_at)
           VALUES ('model-sizes-c-b',?,'Jacket B','[{"id":"sew","name":"Sew","rate":9}]',?,?)`).run(company,now,now);
         db.prepare(`INSERT INTO company_batch_settings(company_id,available_sizes_json,updated_at)
           VALUES (?,? ,?)`).run(company, JSON.stringify(['XXS','XS','S','M','L','XL','XXXL']), now);
       }
       db.prepare(`INSERT INTO workers(id,company_id,name,staj,created_at,updated_at)
         VALUES (7,?,'Demo worker',1,?,?)`).run(company,now,now);
       if (process.env.PATTA_JUMP_ONLY === '1') db.prepare(`INSERT INTO workers(id,company_id,name,staj,created_at,updated_at)
         VALUES (8,?,'Second worker',0,?,?)`).run(company,now,now);
      db.prepare(`INSERT INTO periods(id,company_id,name,start_date,end_date,is_closed,archive_filename,created_at)
        VALUES ('P',?,'P','2026-09-01',NULL,0,NULL,?),
               ('Q',?,'Q','2026-08-01','2026-08-31',1,'archive_Q.json',?)`).run(company,now,company,now);
      db.prepare(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,patta_number,
        qty,status,submitted_at,created_at,provenance) VALUES ('entered',?,'m','P','1',1,10,'CONFIRMED',?,?,'LOCAL_COMMAND')`).run(company,now,now);
       db.prepare(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,qty,rate_snapshot,created_at)
         VALUES ('entered-e','entered',?,'Sew',7,10,5,?)`).run(company,now);
       if (process.env.PATTA_JUMP_ONLY === '1') {
         db.prepare(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,patta_number,qty,size,color,konveyer,status,is_closed,submitted_at,created_at,provenance)
           VALUES ('same-party-patta-2',?,'m','P','1',2,7,'L','Red','Line-B','CONFIRMED',0,?,?,'LOCAL_COMMAND')`).run(company,now,now);
         db.prepare(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,worker_name_snapshot,qty,rate_snapshot,created_at)
           VALUES ('entered-e-hem','entered',?,'Hem',7,'Demo worker',10,4,?),('entered-e2','same-party-patta-2',?,'Sew',7,'Demo worker',7,5,?),('entered-e2-hem','same-party-patta-2',?,'Hem',8,'Second worker',7,4,?)`)
           .run(company,now,company,now,company,now);
       }
      db.prepare(`INSERT INTO production_adjustments(adjustment_id,company_id,model_id,worker_id,op_name,
        delta_qty,reason,status,provenance,created_at,created_by,original_period_id,attribution_status)
        VALUES ('plus',?,'m',7,'Sew',2,'fixture','APPROVED','MANUAL_CORRECTION',?,'test','P','RESOLVED')`).run(company,now);
      for (const [id,type,amount] of [['av','AVANS',4],['ja','JARIMA',3]]) db.prepare(`INSERT INTO worker_adjustments
        (id,company_id,worker_id,period_id,type,amount,provenance,created_at)
        VALUES (?,?,7,'P',?,?,'REMOTE_SYNC',?)`).run(id,company,type,amount,now);
      db.prepare(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,patta_number,
        qty,status,submitted_at,created_at,provenance) VALUES ('closed-ticket',?,'m','Q','1',2,13,'CONFIRMED',?,?,'REMOTE_SYNC')`).run(company,now,now);
      db.prepare(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,qty,rate_snapshot,created_at)
        VALUES ('closed-entry','closed-ticket',?,'Sew',7,13,3,?)`).run(company,now);
      for (const [id,delta] of [['closed-plus',2],['closed-minus',-3]]) db.prepare(`INSERT INTO production_adjustments
        (adjustment_id,company_id,model_id,worker_id,op_name,delta_qty,reason,status,provenance,created_at,created_by,original_period_id,attribution_status)
        VALUES (?,?,'m',7,'Sew',?,'fixture','APPROVED','REMOTE_SYNC',?,'test','Q','RESOLVED')`).run(id,company,delta,now);
       for (const [id,type,amount] of [['closed-av','AVANS',4],['closed-ja','JARIMA',3]]) db.prepare(`INSERT INTO worker_adjustments
        (id,company_id,worker_id,period_id,type,amount,provenance,created_at)
         VALUES (?,?,7,'Q',?,?,'REMOTE_SYNC',?)`).run(id,company,type,amount,now);
       if (process.env.FILTERS_2D_ONLY === '1') {
         db.prepare(`UPDATE tickets SET party_number='41',patta_number=1,size='M',color='Blue',konveyer='Line-41' WHERE id='entered'`).run();
         db.prepare(`INSERT INTO models(id,company_id,name,operations_json,created_at,updated_at)
           VALUES ('filters-2d-model-b',?,'Jacket','[{"id":"sew","name":"Sew","rate":7}]',?,?),
                  ('filters-2d-model-c',?,'Unworked','[{"id":"sew","name":"Sew","rate":7}]',?,?)`)
           .run(company,now,now,company,now,now);
         const addTicket = db.prepare(`INSERT INTO tickets(id,company_id,model_id,party_number,patta_number,qty,size,color,konveyer,status,is_closed,submitted_at,created_at,provenance)
           VALUES (?,?, ?,?,?,?, ?,?,?,'CONFIRMED',0,?,?,'LOCAL_COMMAND')`);
         addTicket.run('FILTER2D-TICKET-4202',company,'filters-2d-model-b','42',2,5,'L','Red','Line-41',now,now);
         addTicket.run('FILTER2D-TICKET-4303',company,'filters-2d-model-b','43',3,7,'M','Green','Line-43',now,now);
         const addEntry = db.prepare(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,worker_name_snapshot,rate_snapshot,qty,created_at)
           VALUES (?,?,?,'Sew',7,'Demo worker',7,?,?)`);
         addEntry.run('filters2d-entry-2','FILTER2D-TICKET-4202',company,5,now);
         addEntry.run('filters2d-entry-3','FILTER2D-TICKET-4303',company,7,now);
       }
      const archivedData = { companyId: company, period: { id: 'Q', name: 'Q', startDate: '2026-08-01', endDate: '2026-08-31', isClosed: true },
        models: [{ id: 'm', name: 'Demo', title: '', party: '', color: '', size: '', hisobSheetName: 'Q-hisob', pattaOpsOrder: [],
          operations: [{ id: 'sew', name: 'Sew', rate: 9 }], hisobQuantities: { 7: { Sew: 999 } } }],
        workers: [{ id: 7, name: 'Demo worker', staj: 1, avans: 4, jarima: 3 }],
        submittedTickets: [{ id: 'closed-ticket', modelId: 'm', periodId: 'Q', partyNumber: '1', pattaNumber: 2,
          qty: 13, size: 'M', color: 'Blue', konveyer: 'A', submittedAt: now,
          entries: [{ entryId: 'closed-entry', opName: 'Sew', workerId: 7, rateSnapshot: 5 }] }] };
      const closingArchive = { ...archivedData, models: [{ ...archivedData.models[0], operations: [{ name: 'Sew', rate: 7 }] }] };
      db.prepare(`INSERT INTO period_archives(company_id,period_id,archive_json,sha256,archived_at) VALUES (?,'Q',?,?,?)`)
        .run(company, JSON.stringify(closingArchive), computePayloadHash(canonicalStringify(closingArchive)), now);
        if (process.env.MODEL_SIZES_C_ONLY === '1' || process.env.PATTA_JUMP_ONLY === '1') db.exec('COMMIT');
       const data = readWorkbookPayrollProjection(db, company);
       if (process.env.PATTA_JUMP_ONLY !== '1' && data.payrollValuation.workers[0].gross !== 84) throw Error('SQLite wage expected 84');
      await window.loadFile(path.join(outDir, 'scripts/verify/fixtures/payroll-display-fixture.html'));
      await window.webContents.executeJavaScript(`window.renderPayrollFixture(${JSON.stringify(data)})`);
      const result = await window.webContents.executeJavaScript(`(() => {
        const views = [...document.querySelectorAll('.excel-grid-container')];
        const hisob = views[0], umumiy = views[1];
        const row = hisob.querySelector('tbody tr.fast-row');
        const columns = hisob.querySelectorAll('col').length;
        const input = row?.querySelector('input[title*="Ish sonini"]');
        const status = [...document.querySelectorAll('[role=status]')].map(e => e.textContent);
        return { hisobMoney: hisob.textContent.includes('≈ 84'), umumiyGross: umumiy.textContent.includes('≈ 84'),
          umumiyNet: umumiy.textContent.includes('≈ 76'), umumiyGrossText: umumiy.querySelector('.umumiy-kpi.gross .kpi-value')?.innerText.trim(),
          umumiyNetText: umumiy.querySelector('.umumiy-kpi.net .kpi-value')?.innerText.trim(), qty: Number(input?.value), columns,
          provisional: status.some(s => s.includes('Taxminiy')), bodyRows: hisob.querySelectorAll('tbody tr.fast-row').length };
      })()`);
       console.log('LOCAL_UI ' + JSON.stringify(result));
        if (process.env.PATTA_JUMP_ONLY !== '1' && (!result.hisobMoney || !result.umumiyGross || !result.umumiyNet || result.qty !== 12 ||
            result.columns !== 5 || !result.provisional || result.bodyRows !== (process.env.FILTERS_2A_ONLY === '1' || process.env.FILTERS_2A_ACTOR_STORAGE_ONLY === '1' ? 3 : 1))) process.exitCode = 1;
         if (process.env.FILTERS_2C_ONLY === '1') {
          const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
          const waitFor = async (predicate, label) => {
            const until = Date.now() + 15000;
            while (Date.now() < until) { if (await predicate()) return; await wait(80); }
            throw Error(`2c timeout: ${label}`);
          };
          const setup = await window.webContents.executeJavaScript('window.renderFilters2aApp()');
          window.setSize(1440, 1000); window.show(); window.focus();
          const readRows = () => window.webContents.executeJavaScript(`(() => ({
            count:document.querySelector('.umumiy-report-filter')?.innerText.trim(),
            ids:[...document.querySelectorAll('.umumiy-report tbody tr.fast-row')].filter(row=>row.cells.length===9).map(row=>row.cells[0]?.innerText.trim()),
            query:document.querySelector('#umumiy-worker-search')?.value,
            gross:document.querySelector('.umumiy-kpi.gross .kpi-value')?.innerText.replace(/\\s+/g,' ').trim(),
            total:document.querySelector('.umumiy-total-row')?.innerText.replace(/\\s+/g,' ').trim(),
            searchLabel:document.querySelector('label[for="umumiy-worker-search"]')?.innerText,
            clear:document.querySelector('[aria-label="Qidiruvni tozalash"]')?.tagName
          }))()`);
          const setSearch = value => window.webContents.executeJavaScript(`(() => {const i=document.querySelector('#umumiy-worker-search');if(!i)throw Error('Umumiy search missing');const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,${JSON.stringify(value)});i.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(value)}}));})()`);
          await waitFor(async () => window.webContents.executeJavaScript(`Boolean(document.querySelector('.umumiy-report'))`), 'Umumiy production App render');
          const initial = await readRows();
          if (initial.ids.join(',') !== '7,8,9') throw Error('2c expected exact fixture workers 7,8,9: '+JSON.stringify({initial,debug:await window.webContents.executeJavaScript(`({active:window.__store?.getState().activeSheet,workerCount:window.__store?.getState().workers.length,report:document.querySelector('.umumiy-report')?.innerText.slice(-500)})`)}));
          await setSearch('Payroll Filter Eight'); await wait(100);
          const byName = await readRows();
          if (byName.ids.join(',') !== '8' || !byName.count.includes('1 / 3') || byName.gross !== initial.gross || byName.total !== initial.total) throw Error('2c name filter or all-worker totals mismatch '+JSON.stringify({initial,byName}));
          await setSearch('9'); await wait(100);
          const byId = await readRows();
          if (byId.ids.join(',') !== '9' || !byId.count.includes('1 / 3')) throw Error('2c ID filter mismatch '+JSON.stringify(byId));
          await setSearch('NO-SUCH-PAYROLL-WORKER'); await wait(80);
          const noMatch = await readRows();
          if (noMatch.ids.length || !noMatch.count.includes('0 / 3') || noMatch.gross !== initial.gross || noMatch.total !== initial.total) throw Error('2c no-match/count/totals mismatch '+JSON.stringify({initial,noMatch}));
          await setSearch('Payroll Filter Eight'); await wait(80);
          await window.webContents.executeJavaScript(`window.__store.setState(s=>({workers:[...s.workers]}))`); await wait(80);
          const rerender = await readRows();
          const screenshotDir = path.join(root,'.opencode/deep-audit/output/post-redesign-filters-2c-screenshots'); fsSync.mkdirSync(screenshotDir,{recursive:true});
          await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
          fsSync.writeFileSync(path.join(screenshotDir,'selected-worker.png'),(await window.webContents.capturePage()).toPNG());
          await window.webContents.reload();
          await waitFor(() => window.webContents.executeJavaScript(`typeof window.renderFilters2aApp==='function'`), 'renderer reload');
          await window.webContents.executeJavaScript('window.renderFilters2aApp()'); await wait(150);
          const refreshed = await readRows();
          if (rerender.query !== 'Payroll Filter Eight' || rerender.ids.join(',') !== '8' || refreshed.query !== 'Payroll Filter Eight' || refreshed.ids.join(',') !== '8') throw Error('2c rerender/reload persistence failed '+JSON.stringify({rerender,refreshed}));
          await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Qidiruvni tozalash"]')?.focus();document.activeElement?.click()`); await wait(80);
          const cleared = await readRows();
          if (cleared.query || cleared.ids.length !== 3) throw Error('2c clear behavior mismatch '+JSON.stringify(cleared));
          await window.webContents.executeJavaScript(`document.querySelector('#umumiy-worker-search').focus()`);
          window.webContents.sendInputEvent({type:'keyDown',keyCode:'9'}); window.webContents.sendInputEvent({type:'char',keyCode:'9'}); window.webContents.sendInputEvent({type:'keyUp',keyCode:'9'}); await wait(80);
          const keyboard = await readRows();
          if (keyboard.query !== '9' || keyboard.ids.join(',') !== '9') throw Error('2c physical keyboard search expected worker 9: '+JSON.stringify(keyboard));
          await setSearch('Payroll Filter Eight'); await wait(70);
          await window.webContents.executeJavaScript(`window.__store.setState(s=>({licenseStatus:{...s.licenseStatus,companyId:'filters-2c-other-company'}}))`); await wait(80);
          const companySwitch = await readRows();
          await window.webContents.executeJavaScript(`window.__store.setState(s=>({licenseStatus:{...s.licenseStatus,companyId:'hisob_test_browser'}}))`); await wait(80);
          const companyRestore = await readRows();
          await window.webContents.executeJavaScript(`window.__store.setState(s=>({currentPeriod:{...s.currentPeriod,id:'FILTER-2C-OTHER-PERIOD'}}))`); await wait(80);
          const periodSwitch = await readRows();
          await window.webContents.executeJavaScript(`window.__store.setState(s=>({currentPeriod:s.periods.find(p=>p.id==='P')}))`); await wait(80);
          await setSearch('Payroll Filter Eight'); await wait(60);
          await window.webContents.executeJavaScript(`window.__store.setState(s=>({selectedArchiveFilename:'archive-fixture-Q.json'}))`); await wait(80);
          const archiveSwitch = await readRows();
          await window.webContents.executeJavaScript(`window.__store.setState(s=>({selectedArchiveFilename:null}))`); await wait(80);
          const actorSwitch = await window.webContents.executeJavaScript(`window.filters2cActor('filters-2c-other-actor')`); await wait(80);
          const actorIsolated = await readRows();
           await window.webContents.executeJavaScript(`window.filters2cActor('filters-2a-local-only')`); await wait(80);
           const actorRestored = await readRows();
           const setPayrollAuth = uid => window.webContents.executeJavaScript(`(()=>{const a=window.__filters2aAuth.getState();a.setAuth({user:{uid:${JSON.stringify(uid)},email:${JSON.stringify(uid+'@fixture.invalid')},companyId:a.companyId,displayName:${JSON.stringify(uid)},role:a.role,permissions:a.permissions,deviceId:a.deviceId,status:a.status,lastSeen:'fixture',createdAt:'fixture'}})})()`);
           await setPayrollAuth('payroll-auth-A'); await wait(80); await setSearch('Payroll Filter Eight'); await wait(60);
           await setPayrollAuth('payroll-auth-B'); await wait(100); const authActorB=await readRows();
           await setPayrollAuth('payroll-auth-A'); await wait(100); const authActorA=await readRows();
           if(authActorB.query||authActorB.ids.length!==3||authActorA.query!=='Payroll Filter Eight'||authActorA.ids.join(',')!=='8') throw Error('2c actual authenticated UID isolation/restore '+JSON.stringify({authActorB,authActorA}));
          const original = await window.webContents.executeJavaScript(`(() => {const x={get:Storage.prototype.getItem,set:Storage.prototype.setItem};Storage.prototype.getItem=function(){throw Error('denied')};Storage.prototype.setItem=function(){throw Error('denied')};window.__2cStorage=x})()`);
          await window.webContents.executeJavaScript(`window.filters2cActor('filters-2c-storage-denied')`); await wait(60); await setSearch('8'); await wait(80);
          const storageFallback = await readRows();
          await window.webContents.executeJavaScript(`Storage.prototype.getItem=window.__2cStorage.get;Storage.prototype.setItem=window.__2cStorage.set;window.filters2cActor('filters-2c-readonly','print')`); await wait(80);
          const readonly = await readRows();
          const readonlyMoneyInputsDisabled = await window.webContents.executeJavaScript(`[...document.querySelectorAll('.umumiy-report input[type=number]')].every(i=>i.disabled)`);
          const readonlyDenied = !readonly.searchLabel;
          await window.webContents.executeJavaScript(`window.filters2cActor('filters-2c-narrow-admin','admin')`); await wait(80);
          await setSearch('Payroll Filter Eight'); await wait(80);
          window.setSize(760, 1000); await wait(120);
          await window.webContents.executeJavaScript(`document.querySelector('.umumiy-table-scroll').scrollTop=0`); await wait(80);
          const narrow = await readRows();
          const narrowVisibleWorker = await window.webContents.executeJavaScript(`(() => {const r=[...document.querySelectorAll('.umumiy-report tbody tr.fast-row')].find(row=>row.cells.length===9&&row.cells[0].innerText.trim()==='8');if(!r)return false;const b=r.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight})()`);
          fsSync.writeFileSync(path.join(screenshotDir,'narrow.png'),(await window.webContents.capturePage()).toPNG());
          if (companySwitch.query || companyRestore.query !== 'Payroll Filter Eight' || periodSwitch.query || archiveSwitch.query || actorIsolated.query || actorRestored.query !== 'Payroll Filter Eight'
            || storageFallback.query !== '8' || !readonlyDenied || !readonlyMoneyInputsDisabled || !narrow.searchLabel || !narrowVisibleWorker || !cleared.query && cleared.ids.length !== 3
            || !String(noMatch.total).includes('ЖАМИ') || noMatch.total !== initial.total || !result.umumiyGrossText.includes('84') || !result.umumiyNetText.includes('76')) throw Error('2c isolation/fallback/readonly/accessibility/total failure '+JSON.stringify({companySwitch,companyRestore,periodSwitch,archiveSwitch,actorIsolated,actorRestored,storageFallback,readonly,readonlyDenied,readonlyMoneyInputsDisabled,narrow,localMoney:{gross:result.umumiyGrossText,net:result.umumiyNetText}}));
           const evidence={fixtureRoot,setup,localMoney:{gross:result.umumiyGrossText,net:result.umumiyNetText},initial,byName,byId,noMatch,rerender,refreshed,cleared,keyboard,companySwitch,companyRestore,periodSwitch,archiveSwitch,actorSwitch,actorIsolated,actorRestored,authActorB,authActorA,storageFallback,readonly,readonlyDenied,readonlyMoneyInputsDisabled,narrow,narrowVisibleWorker,screenshots:screenshotDir};
          fsSync.writeFileSync(path.join(screenshotDir,'evidence.json'),JSON.stringify(evidence,null,2));
           console.log('FILTERS_2C_PASS '+JSON.stringify(evidence)); return;
         }
         if (process.env.FILTERS_2D_ONLY === '1') {
           const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
           const waitFor = async (predicate, label) => { const until=Date.now()+15000; while(Date.now()<until){if(await predicate())return;await wait(80)} throw Error(`2d timeout: ${label}`); };
           const setup = await window.webContents.executeJavaScript('window.renderFilters2dApp()');
           window.setSize(1440,1000); window.show(); window.focus();
           await waitFor(()=>window.webContents.executeJavaScript(`Boolean(document.querySelector('.e2c-conveyor-matrix'))`),'Konveyer matrix');
           const read = () => window.webContents.executeJavaScript(`(()=>({
             activeTab:document.querySelector('.e2c-conveyor-matrix')?'matrix':'details',
             search:document.querySelector('.e2c-conveyor-toolbar input')?.value||'',
              matrixRows:[...document.querySelectorAll('.e2c-conveyor-matrix tbody tr')].filter(r=>!r.innerText.includes('ЖАМИ')).map(r=>r.innerText.replace(/\\s+/g,' ').trim()),
              matrixConveyors:[...document.querySelectorAll('.e2c-conveyor-matrix tbody tr')].filter(r=>!r.innerText.includes('ЖАМИ')).map(r=>r.cells[1]?.innerText.trim()).filter(Boolean),
             matrixModels:[...document.querySelectorAll('.e2c-conveyor-matrix thead th')].map(e=>e.innerText.trim()),
             tickets:[...document.querySelectorAll('.e2c-conveyor-scroll table tbody tr')].map(r=>r.innerText.replace(/\\s+/g,' ').trim()),
             ticketCount:[...document.querySelectorAll('.e2c-conveyor-scroll table tbody tr')].length,
              found:[...document.querySelectorAll('.e2c-conveyor-toolbar strong')].map(e=>e.innerText.trim()),
              empty:document.body.innerText.includes('Hech qanday patta topilmadi')||document.body.innerText.includes('Hali hech qanday konveyerga patta topshirilmadi'),
              body:document.body.innerText.slice(-500)
           }))()`).then(x=>x);
           const search = async value => window.webContents.executeJavaScript(`(()=>{const i=document.querySelector('.e2c-conveyor-toolbar input');const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,${JSON.stringify(value)});i.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(value)}}))})()`);
           const clickLabel = async text => window.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>x.innerText.includes(${JSON.stringify(text)}));if(!e)throw Error('missing button '+${JSON.stringify(text)});e.click()})()`);
           const exactInitial = await read();
            if (setup.tickets.length !== 3 || exactInitial.matrixConveyors.length!==2 || !exactInitial.matrixConveyors.some(row=>row.includes('Line-41')) || !exactInitial.matrixConveyors.some(row=>row.includes('Line-43'))) throw Error('2d exact SQLite-backed baseline mismatch '+JSON.stringify({setup,exactInitial}));
           await search('Line-41'); await wait(80); const matrixSearch = await read();
            if (matrixSearch.matrixConveyors.length!==1||!matrixSearch.matrixRows[0].includes('Line-41')) throw Error('2d matrix conveyor search failed '+JSON.stringify(matrixSearch));
           const activeToggle = await window.webContents.executeJavaScript(`(()=>{const i=document.querySelector('.e2c-conveyor-toolbar input[type=checkbox]');if(!i)throw Error('active models checkbox missing');i.click();return i.checked})()`); await wait(80);
           const activeOnly = await read();
            if (!activeOnly.matrixModels.some(label=>label.includes('DEMO')) || activeOnly.matrixModels.some(label=>label.includes('UNWORKED'))) throw Error('2d active-model filter failed '+JSON.stringify({activeToggle,activeOnly}));
           await search('NO-SUCH-CONVEYOR'); await wait(80); const matrixEmpty=await read();
           if(matrixEmpty.matrixConveyors.length) throw Error('2d empty matrix search returned rows '+JSON.stringify(matrixEmpty));
           await clickLabel('Tozalash'); await wait(80); const matrixClear=await read();
            if(matrixClear.search||matrixClear.matrixConveyors.length!==2) throw Error('2d matrix clear failed '+JSON.stringify(matrixClear));
           await clickLabel("Pattalar Ro'yxati"); await wait(100);
           const detailBaseline=await read();
            if(detailBaseline.ticketCount!==3||!detailBaseline.tickets.some(r=>r.includes('42')&&r.includes('Jacket'))||!detailBaseline.tickets.some(r=>r.includes('43')&&r.includes('Jacket'))) throw Error('2d details exact ticket/party/model mapping failed '+JSON.stringify(detailBaseline));
           await search('42'); await wait(80); const byTicket=await read();
           if(byTicket.ticketCount!==1||!byTicket.tickets[0].includes('42')||!byTicket.tickets[0].includes('Jacket')) throw Error('2d exact party/ticket-mapped search failed '+JSON.stringify(byTicket));
           await clickLabel('Barcha konveyerlar'); await wait(40); await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('div')].find(e=>e.children.length===1&&e.innerText.trim()==='Line-41-Konveyer')?.click())()`); await wait(80);
            const conveyorSelect=await read(); if(conveyorSelect.ticketCount!==1||!conveyorSelect.tickets[0].includes('42')) throw Error('2d conveyor selector failed '+JSON.stringify(conveyorSelect));
            await search(''); await wait(60);
            await clickLabel('Tozalash'); await wait(60);
            await clickLabel('Barcha modellar'); await wait(30); await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('div')].find(e=>e.children.length===1&&e.innerText.trim()==='Jacket')?.click())()`); await wait(60);
           const modelSelect=await read(); if(modelSelect.ticketCount!==2||!modelSelect.tickets.every(r=>r.includes('Jacket'))) throw Error('2d model selector expected two Jacket tickets '+JSON.stringify(modelSelect));
           await clickLabel('Barcha partiyalar'); await wait(30); await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('div')].find(e=>e.children.length===1&&e.innerText.trim()==='42-partiya')?.click())()`); await wait(60);
            const partySelect=await read(); if(partySelect.ticketCount!==1||!partySelect.tickets[0].includes('42')) throw Error('2d party selector failed '+JSON.stringify(partySelect));
           await search('NO-SUCH-TICKET'); await wait(60); const detailsEmpty=await read();
           if(detailsEmpty.ticketCount!==0) throw Error('2d details empty search failed '+JSON.stringify(detailsEmpty));
           await clickLabel('Tozalash'); await wait(60); const detailsClear=await read();
            if(detailsClear.search||detailsClear.ticketCount!==3||detailsClear.found.join('')!=='3') throw Error('2d detail clear/count failed '+JSON.stringify(detailsClear));
            await search('43'); await wait(60);
           await window.webContents.executeJavaScript(`window.__filters2dStore.setState(s=>({submittedTickets:[...s.submittedTickets]}))`); await wait(60);
           const rerender=await read(); const screenshots=path.join(root,'.opencode/deep-audit/output/post-redesign-filters-2d-screenshots'); fsSync.mkdirSync(screenshots,{recursive:true});
            await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
            fsSync.writeFileSync(path.join(screenshots,'selected-ticket.png'),(await window.webContents.capturePage()).toPNG());
            const storageBeforeReload=await window.webContents.executeJavaScript(`Object.entries(sessionStorage).filter(([k])=>k.startsWith('konveyer:filters:'))`);
            await window.webContents.reload(); await waitFor(()=>window.webContents.executeJavaScript(`typeof window.renderFilters2dApp==='function'`),'renderer reload');
            await window.webContents.executeJavaScript('window.renderFilters2dApp()');
            await waitFor(()=>window.webContents.executeJavaScript(`Boolean(document.querySelector('.e2c-conveyor-toolbar input'))`),'Konveyer after renderer reload');
            await wait(120); const reload=await read();
            const storageAfterReload=await window.webContents.executeJavaScript(`Object.entries(sessionStorage).filter(([k])=>k.startsWith('konveyer:filters:'))`);
            const reloadContext=await window.webContents.executeJavaScript(`(()=>{const s=window.__filters2dStore.getState(),a=window.__filters2dAuth.getState();return {license:s.licenseStatus,period:s.currentPeriod?.id,archive:s.selectedArchiveFilename,authCompany:a.companyId,scope:JSON.stringify([s.licenseStatus?.companyId||a.companyId||'',s.currentPeriod?.id,s.selectedArchiveFilename||'',s.licenseStatus?.activationId||'',s.licenseStatus?.machineId||'',s.licenseStatus?.role||'',a.companyId||''])}})()`);
            if(rerender.search!=='43'||rerender.ticketCount!==1||reload.search!=='43'||reload.ticketCount!==1) throw Error('2d rerender/reload retention failed '+JSON.stringify({rerender,reload,storageBeforeReload,storageAfterReload,reloadContext}));
            await search(''); await window.webContents.executeJavaScript(`document.querySelector('.e2c-conveyor-toolbar input').focus()`);
            for(const key of ['4','2']) { await window.webContents.sendInputEvent({type:'keyDown',keyCode:key}); await window.webContents.sendInputEvent({type:'char',keyCode:key}); await window.webContents.sendInputEvent({type:'keyUp',keyCode:key}); }
            await wait(100); const keyboard=await read();
            await search('42'); await wait(50);
           await window.webContents.executeJavaScript(`window.filters2dContext('company','other-company')`); await wait(50); const companySwitch=await read();
           await window.webContents.executeJavaScript(`window.filters2dContext('company','hisob_test_browser')`); await wait(50); const companyRestore=await read();
           await window.webContents.executeJavaScript(`window.filters2dContext('period','other-period')`); await wait(50); const periodSwitch=await read();
           await window.webContents.executeJavaScript(`window.filters2dContext('period','P')`); await wait(50);
           await window.webContents.executeJavaScript(`window.filters2dContext('archive','archive-fixture-Q.json')`); await wait(50); const archiveSwitch=await read();
           await window.webContents.executeJavaScript(`window.filters2dContext('archive','')`); await wait(50);
            await window.webContents.executeJavaScript(`window.filters2dContext('actor','filters-2d-other-actor')`); await wait(50); const actorSwitch=await read();
            await window.webContents.executeJavaScript(`window.filters2dContext('actor','filters-2d-local-only')`); await wait(50); const actorRestore=await read();
            await clickLabel('Modellar Matritsasi'); await wait(50);
            const setConveyorAuth = uid => window.webContents.executeJavaScript(`(()=>{const a=window.__filters2dAuth.getState();a.setAuth({user:{uid:${JSON.stringify(uid)},email:${JSON.stringify(uid+'@fixture.invalid')},companyId:a.companyId,displayName:${JSON.stringify(uid)},role:a.role,permissions:a.permissions,deviceId:a.deviceId,status:a.status,lastSeen:'fixture',createdAt:'fixture'}})})()`);
            await setConveyorAuth('conveyor-auth-A'); await wait(60); await search('Line-41'); await wait(60);
            const conveyorAuthContext=await window.webContents.executeJavaScript(`(()=>{const s=window.__filters2dStore.getState();return {activationId:s.licenseStatus.activationId,machineId:s.licenseStatus.machineId,companyId:s.licenseStatus.companyId}})()`);
            await setConveyorAuth('conveyor-auth-B'); await wait(80); const authActorB=await read();
            await setConveyorAuth('conveyor-auth-A'); await wait(80); const authActorA=await read();
            const conveyorAuthContextAfter=await window.webContents.executeJavaScript(`(()=>{const s=window.__filters2dStore.getState();return {activationId:s.licenseStatus.activationId,machineId:s.licenseStatus.machineId,companyId:s.licenseStatus.companyId}})()`);
            if(authActorB.search||authActorB.matrixConveyors.length!==2||authActorA.search!=='Line-41'||authActorA.matrixConveyors.length!==1||!authActorA.matrixConveyors[0].includes('Line-41')||JSON.stringify(conveyorAuthContext)!==JSON.stringify(conveyorAuthContextAfter)) throw Error('2d actual authenticated UID isolation/restore changed license context '+JSON.stringify({authActorB,authActorA,conveyorAuthContext,conveyorAuthContextAfter}));
            await window.webContents.executeJavaScript(`(()=>{window.__2dStorage={get:Storage.prototype.getItem,set:Storage.prototype.setItem,remove:Storage.prototype.removeItem};for(const n of ['getItem','setItem','removeItem'])Storage.prototype[n]=function(){throw Error('denied')}})()`);
            await window.webContents.executeJavaScript(`window.filters2dContext('actor','filters-2d-denied')`); await wait(50); await clickLabel("Pattalar Ro'yxati"); await wait(50); await search('42'); await wait(60); const deniedStorage=await read();
           await window.webContents.executeJavaScript(`Storage.prototype.getItem=window.__2dStorage.get;Storage.prototype.setItem=window.__2dStorage.set;Storage.prototype.removeItem=window.__2dStorage.remove;window.filters2dContext('role','print')`); await wait(80);
           const roleDenied=await window.webContents.executeJavaScript(`document.body.innerText.includes('Konveyer varag')&&document.body.innerText.includes('ruxsat')`);
           await window.webContents.executeJavaScript(`window.filters2dContext('role','admin')`); await wait(80); await window.webContents.executeJavaScript('window.mountFilters2dPatta()'); await window.webContents.executeJavaScript(`window.__filters2dStore.setState({activeSheet:'Patta'})`); await wait(120);
           const pattaCards=await window.webContents.executeJavaScript(`({cards:document.querySelectorAll('.e2b-batch-card').length,models:[...document.querySelectorAll('.e2b-batch-card-header')].map(e=>e.innerText.trim()),printButtons:[...document.querySelectorAll('button')].filter(b=>b.innerText.includes('Chop et')).length})`);
           const beforePrint=await window.webContents.executeJavaScript(`({configs:JSON.stringify(window.__filters2dStore.getState().pattaBatchConfigs),completed:window.__filters2dStore.getState().printedPartyHistory.length})`);
            await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('button')].find(b=>b.innerText.includes('Pechat (3 ta patta)'))?.click())()`); await wait(100);
           const printSelection=await window.webContents.executeJavaScript(`({modal:document.body.innerText.includes('Pechat qilish (3 ta patta)'),models:document.body.innerText.includes('Demo')&&document.body.innerText.includes('Jacket'),completed:window.__filters2dStore.getState().printedPartyHistory.length})`);
           await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Close' || b.innerText.includes('Yopish'))?.click())()`); await wait(80);
            window.setSize(760,1000); await wait(120); await window.webContents.executeJavaScript(`window.__filters2dStore.setState({activeSheet:'Konveyer'})`); await wait(120);
            await window.webContents.executeJavaScript(`window.filters2dContext('role','admin')`); await wait(80); await waitFor(()=>window.webContents.executeJavaScript(`Boolean(document.querySelector('.e2c-conveyor-toolbar input'))`),'Konveyer narrow remount');
            await clickLabel("Pattalar Ro'yxati"); await wait(60); await search('42'); await wait(80);
            const narrow=await read(); const narrowVisible=await window.webContents.executeJavaScript(`(()=>{const r=[...document.querySelectorAll('.e2c-conveyor-scroll table tbody tr')].find(r=>r.innerText.includes('42'));if(!r)return false;const b=r.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight})()`);
           fsSync.writeFileSync(path.join(screenshots,'narrow-selected-ticket.png'),(await window.webContents.capturePage()).toPNG());
           if(keyboard.search!=='42'||keyboard.ticketCount!==1||companySwitch.search||companyRestore.search!=='42'||periodSwitch.search||archiveSwitch.search||actorSwitch.search||actorRestore.search!=='42'||deniedStorage.ticketCount!==1||!roleDenied||pattaCards.cards!==3||!printSelection.modal||printSelection.completed!==beforePrint.completed||!narrowVisible) throw Error('2d context/keyboard/storage/role/Patta/narrow acceptance failed '+JSON.stringify({keyboard,companySwitch,companyRestore,periodSwitch,archiveSwitch,actorSwitch,actorRestore,deniedStorage,roleDenied,pattaCards,beforePrint,printSelection,narrow,narrowVisible}));
            const evidence={fixtureRoot,setup,exactInitial,matrixSearch,activeOnly,matrixEmpty,matrixClear,detailBaseline,byTicket,conveyorSelect,modelSelect,partySelect,detailsEmpty,detailsClear,rerender,reload,keyboard,companySwitch,companyRestore,periodSwitch,archiveSwitch,actorSwitch,actorRestore,authActorB,authActorA,conveyorAuthContext,conveyorAuthContextAfter,deniedStorage,roleDenied,pattaCards,beforePrint,printSelection,narrow,narrowVisible,screenshots};
            fsSync.writeFileSync(path.join(screenshots,'evidence.json'),JSON.stringify(evidence,null,2)); console.log('FILTERS_2D_PASS '+JSON.stringify(evidence)); return;
          }
          if (process.env.MODEL_SIZES_C_ONLY === '1') {
            await require('./model-sizes-stage-c-runtime.cjs')({ window, db, manager, root, fixtureRoot, outDir, setDb: (nextDb) => { db = nextDb; } });
            return;
          }
          if (process.env.FILTERS_2B_ONLY === '1') {
          const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
          const waitFor = async (predicate, label) => {
            const until = Date.now() + 15000;
            while (Date.now() < until) { if (await predicate()) return; await wait(80); }
            throw Error(`2b timeout: ${label}`);
          };
          const setup = await window.webContents.executeJavaScript('window.renderFilters2aApp()');
          await window.webContents.executeJavaScript(`window.__filters2aAuth.getState().setAuth({status:'active',role:'admin',companyId:'hisob_test_browser',deviceId:'filters-device-a',user:{uid:'filters-actor-a',email:'actor-a@fixture.invalid',companyId:'hisob_test_browser',displayName:'Actor A',role:'admin',permissions:['edit:hisob','view:umumiy','view:patta'],deviceId:'filters-device-a',status:'active',lastSeen:'fixture',createdAt:'fixture'},permissions:['edit:hisob','view:umumiy','view:patta']})`);
          const fixture = await window.webContents.executeJavaScript('window.mountFilters2bJournal()');
          window.setSize(1440, 1000); window.show(); window.focus();
          await waitFor(() => window.webContents.executeJavaScript(`Boolean(document.querySelector('.journal-filters input'))`), 'journal mount');
          const expandJournalModels = () => window.webContents.executeJavaScript(`document.querySelectorAll('.journal-model-row[aria-expanded="false"]').forEach(b=>b.click())`);
          await expandJournalModels(); await wait(100);
          const journalRows = () => window.webContents.executeJavaScript(`(() => ({
            parties:[...document.querySelectorAll('.journal-model-card tbody tr')].map(tr=>tr.innerText).filter(t=>t.includes('Partiya ')),
            models:[...document.querySelectorAll('.journal-model-card .journal-model-title')].map(e=>e.innerText.trim()),
            search:document.querySelector('.journal-filters input')?.value,
            active:document.querySelector('[role=tab][aria-selected=true]')?.innerText.trim(),
            kpi:document.querySelector('.journal-kpi-value')?.innerText.trim()
          }))()`);
          const inputText = async value => window.webContents.executeJavaScript(`(() => {const i=document.querySelector('.journal-filters input');const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,${JSON.stringify(value)});i.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(value)}}));})()`);
           const clickButton = text => window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('.journal-filter-pills button')].find(b=>b.innerText.includes(${JSON.stringify(text)}))?.click())()`);
         const screenshotDir = process.env.MODEL_SIZES_C_ONLY === '1'
              ? path.join(root,'.opencode/deep-audit/output/post-redesign-model-sizes-c-screenshots',path.basename(fixtureRoot))
              : process.env.PATTA_MODEL_UI_ONLY === '1'
             ? path.join(root,'.opencode/deep-audit/output/post-redesign-patta-model-ui-screenshots',path.basename(fixtureRoot))
             : path.join(root,'.opencode/deep-audit/output/post-redesign-filters-2b-screenshots'); fsSync.mkdirSync(screenshotDir,{recursive:true});
           const initial = await journalRows();
           if (initial.parties.length !== 2 || !initial.parties.some(t=>t.includes('Partiya 41')) || !initial.parties.some(t=>t.includes('Partiya 42'))) throw Error('2b active series exact party boundary: '+JSON.stringify(initial));
           await window.webContents.executeJavaScript(`window.__filters2bStore.setState(s=>({submittedTickets:s.submittedTickets.map(t=>t.id==='JOURNAL-TICKET-4101'?{...t,qty:8}:t)}))`); await wait(100);
           await clickButton('Tafovut / Kamomat'); await wait(100);
           const mismatch = await journalRows();
           if (mismatch.parties.length !== 1 || !mismatch.parties[0].includes('Partiya 41') || !mismatch.parties[0].includes('Kamomat')) throw Error('2b mismatch status expected deficit party 41 only: '+JSON.stringify(mismatch));
           const mismatchScreenshot = path.join(screenshotDir, 'mismatch-deficit.png');
           await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
           fsSync.writeFileSync(mismatchScreenshot, (await window.webContents.capturePage()).toPNG());
           await clickButton('Barchasi'); await wait(80);
           await window.webContents.executeJavaScript(`window.__filters2bStore.setState(s=>({submittedTickets:s.submittedTickets.map(t=>t.id==='JOURNAL-TICKET-4101'?{...t,qty:10}:t)}))`); await wait(100);
           await clickButton("To'liq"); await wait(100);
          const complete = await journalRows();
          if (complete.parties.length !== 1 || !complete.parties[0].includes('Partiya 41')) throw Error('2b complete status expected party 41: '+JSON.stringify(complete));
          await clickButton('Jarayonda'); await wait(80);
          const inProgress = await journalRows();
          if (inProgress.parties.length !== 1 || !inProgress.parties[0].includes('Partiya 42')) throw Error('2b in-progress status expected party 42: '+JSON.stringify(inProgress));
          await clickButton('Barchasi'); await inputText('JOURNAL-TICKET-4101'); await wait(100);
          const ticketSearch = await journalRows();
          if (ticketSearch.parties.length !== 1 || !ticketSearch.parties[0].includes('Partiya 41')) throw Error('2b exact ticket-ID search expected party 41: '+JSON.stringify(ticketSearch));
          await inputText('NO-SUCH-JOURNAL-RECORD'); await wait(80);
          const noResults = await journalRows();
          if (noResults.parties.length !== 0 || noResults.models.length !== 0) throw Error('2b empty search expected zero parties/models: '+JSON.stringify(noResults));
          await inputText('JOURNAL-TICKET-4101'); await wait(80);
          await window.webContents.executeJavaScript(`window.__filters2bStore.setState(s=>({printedPartyHistory:[...s.printedPartyHistory]}))`); await wait(80);
          const rerender = await journalRows();
          if (rerender.search !== 'JOURNAL-TICKET-4101' || rerender.parties.length !== 1) throw Error('2b rerender reset: '+JSON.stringify(rerender));
            if (process.env.PATTA_MODEL_UI_ONLY === '1') {
             await window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('.journal-model-row')].forEach(button => { if (button.getAttribute('aria-expanded') === 'false') button.click(); }))()`);
             await wait(120);
             fsSync.writeFileSync(path.join(screenshotDir,'model-summary-before.png'),(await window.webContents.capturePage()).toPNG());
           }
          await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
           fsSync.writeFileSync(path.join(screenshotDir,'selected-ticket.png'),(await window.webContents.capturePage()).toPNG());
           const modelStatusLayout = await window.webContents.executeJavaScript(`(() => {const e=document.querySelector('.journal-model-row .journal-status');if(!e)return null;const s=getComputedStyle(e);return {text:e.textContent.trim(),height:e.getBoundingClientRect().height,lineHeight:parseFloat(s.lineHeight),whiteSpace:s.whiteSpace,fontSize:s.fontSize}})()`);
           if (process.env.PATTA_MODEL_UI_ONLY === '1' && (!modelStatusLayout || modelStatusLayout.whiteSpace !== 'nowrap'
             || modelStatusLayout.height > modelStatusLayout.lineHeight + 11)) throw Error('Patta model status badge is not a single line: '+JSON.stringify(modelStatusLayout));
          await window.webContents.reload();
          await waitFor(() => window.webContents.executeJavaScript(`typeof window.renderFilters2aApp==='function'`), 'reload fixture');
          await window.webContents.executeJavaScript('window.renderFilters2aApp()');
           await window.webContents.executeJavaScript(`window.__filters2aAuth.getState().setAuth({status:'active',role:'admin',companyId:'hisob_test_browser',deviceId:'filters-device-a',user:{uid:'filters-actor-a',email:'actor-a@fixture.invalid',companyId:'hisob_test_browser',displayName:'Actor A',role:'admin',permissions:['edit:hisob','view:umumiy','view:patta'],deviceId:'filters-device-a',status:'active',lastSeen:'fixture',createdAt:'fixture'},permissions:['edit:hisob','view:umumiy','view:patta']})`);
          await window.webContents.executeJavaScript('window.mountFilters2bJournal()');
          await waitFor(() => window.webContents.executeJavaScript(`Boolean(document.querySelector('.journal-filters input'))`), 'journal remount');
          await expandJournalModels(); await wait(100);
          const refreshed = await journalRows();
          if (refreshed.search !== 'JOURNAL-TICKET-4101' || refreshed.parties.length !== 1 || !refreshed.parties[0].includes('Partiya 41')) throw Error('2b full renderer reload reset: '+JSON.stringify(refreshed));
          await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Qidiruvni tozalash"]')?.click()`); await wait(80);
          await expandJournalModels(); await wait(80);
          const cleared = await journalRows();
          if (cleared.search !== '' || cleared.parties.length !== 2) throw Error('2b clear expected active parties 41,42: '+JSON.stringify(cleared));
          await window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('[role=tab]')].find(b=>b.innerText.includes('Yopilgan'))?.click())()`); await wait(100);
          await expandJournalModels(); await wait(80);
          const closed = await journalRows();
          if (closed.parties.length !== 1 || !closed.parties[0].includes('Partiya 43')) throw Error('2b closed series expected party 43: '+JSON.stringify(closed));
          await window.webContents.executeJavaScript(`window.__filters2bStore.setState(s=>({licenseStatus:{...s.licenseStatus,activationId:'filters-2b-other-actor'}}))`); await wait(100);
          const actorSwitch = await journalRows();
          if (actorSwitch.search !== '' || !actorSwitch.active?.includes('Patta hisob') || actorSwitch.parties.length !== 2) throw Error('2b actor isolation failed: '+JSON.stringify(actorSwitch));
           await window.webContents.executeJavaScript(`window.__filters2bStore.setState(s=>({licenseStatus:{...s.licenseStatus,activationId:'filters-2a-local-only'}}))`); await wait(100);
           await window.webContents.executeJavaScript(`(()=>{const a=window.__filters2aAuth.getState();a.setAuth({user:{uid:'filters-actor-a',email:'actor-a@fixture.invalid',companyId:a.companyId,displayName:'Actor A',role:a.role,permissions:a.permissions,deviceId:a.deviceId,status:a.status,lastSeen:'fixture',createdAt:'fixture'}})})()`); await wait(100);
           const actorRestore = await journalRows();
           if (actorRestore.active !== closed.active || actorRestore.parties.length !== 1 || !actorRestore.parties[0].includes('Partiya 43')) throw Error('2b actor return did not restore prior actor selection: '+JSON.stringify({actorRestore,closed,auth:await window.webContents.executeJavaScript(`(()=>{const a=window.__filters2aAuth.getState(),s=window.__filters2bStore.getState();return {uid:a.user?.uid,role:a.role,activationId:s.licenseStatus.activationId,machineId:s.licenseStatus.machineId,keys:Object.keys(sessionStorage).filter(k=>k.startsWith('patta-journal:filters:')).map(k=>[k,sessionStorage.getItem(k)])}})()`)}));
           const authBefore = await window.webContents.executeJavaScript(`(()=>{const a=window.__filters2aAuth.getState(),s=window.__filters2bStore.getState();return {activationId:s.licenseStatus.activationId,machineId:s.licenseStatus.machineId,companyId:s.licenseStatus.companyId,role:a.role,permissions:a.permissions}})()`);
           const setJournalAuth = uid => window.webContents.executeJavaScript(`(()=>{const a=window.__filters2aAuth.getState();a.setAuth({user:{uid:${JSON.stringify(uid)},email:${JSON.stringify(uid+'@fixture.invalid')},companyId:a.companyId,displayName:${JSON.stringify(uid)},role:a.role,permissions:a.permissions,deviceId:a.deviceId,status:a.status,lastSeen:'fixture',createdAt:'fixture'}})})()`);
           await setJournalAuth('journal-auth-A'); await wait(60);
           await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('[role=tab]')].find(b=>b.innerText.includes('Yopilgan'))?.click())()`); await wait(80); await expandJournalModels(); await wait(80);
           await inputText('JOURNAL-CLOSED-TICKET-4303'); await wait(60);
           await setJournalAuth('journal-auth-B'); await wait(100); const journalAuthB=await journalRows();
           await setJournalAuth('journal-auth-A'); await wait(100); const journalAuthA=await journalRows();
           const authAfter = await window.webContents.executeJavaScript(`(()=>{const s=window.__filters2bStore.getState();return {activationId:s.licenseStatus.activationId,machineId:s.licenseStatus.machineId,companyId:s.licenseStatus.companyId}})()`);
           if(journalAuthB.search||journalAuthB.parties.length!==2||journalAuthA.search!=='JOURNAL-CLOSED-TICKET-4303'||journalAuthA.parties.length!==1
             ||authAfter.activationId!==authBefore.activationId||authAfter.machineId!==authBefore.machineId||authAfter.companyId!==authBefore.companyId)
             throw Error('2b authenticated UID isolation/restore must preserve license context '+JSON.stringify({authBefore,authAfter,journalAuthB,journalAuthA}));
           await inputText('JOURNAL-CLOSED-TICKET-4303'); await wait(80);
          const closedTicketSearch = await journalRows();
          if (closedTicketSearch.parties.length !== 1 || !closedTicketSearch.parties[0].includes('Partiya 43')) throw Error('2b closed exact ticket search expected party 43: '+JSON.stringify(closedTicketSearch));
          await window.webContents.executeJavaScript(`window.__filters2bStore.setState(s=>({licenseStatus:{...s.licenseStatus,companyId:'filters-2b-other-company'}}))`); await wait(100);
          const companySwitch = await journalRows();
          if (companySwitch.search !== '' || !companySwitch.active?.includes('Patta hisob')) throw Error('2b company isolation failed: '+JSON.stringify(companySwitch));
           await window.webContents.executeJavaScript(`window.__filters2bStore.setState(s=>({licenseStatus:{...s.licenseStatus,companyId:'hisob_test_browser'}}))`); await wait(100);
           await setJournalAuth('journal-auth-A'); await wait(100);
           const companyRestore = await journalRows();
          if (companyRestore.search !== 'JOURNAL-CLOSED-TICKET-4303' || !companyRestore.active?.includes('Yopilgan') || companyRestore.parties.length !== 1 || !companyRestore.parties[0].includes('Partiya 43'))
            throw Error('2b company return did not restore scoped journal filters: '+JSON.stringify(companyRestore));
          await window.webContents.executeJavaScript(`window.__filters2bStore.setState(s=>({selectedArchiveFilename:'archive-fixture-Q.json',selectedArchiveData:{period:{id:'Q',name:'Archive Q',startDate:'2026-08-01',endDate:'2026-08-31',isClosed:true},printedPartyHistory:s.printedPartyHistory.filter(p=>p.id==='journal-closed-c'),submittedTickets:s.submittedTickets.filter(t=>t.id==='JOURNAL-CLOSED-TICKET-4303')}}))`); await wait(100);
          const archive = await journalRows();
          if (archive.search !== '' || archive.parties.length !== 1 || !archive.parties[0].includes('Partiya 43')) throw Error('2b archive boundary expected isolated party 43: '+JSON.stringify(archive));
          await window.webContents.executeJavaScript(`window.__filters2bStore.setState(s=>({currentPeriod:{...s.currentPeriod,id:'FILTER-2B-OTHER-PERIOD'},selectedArchiveFilename:null,selectedArchiveData:null}))`); await wait(100);
          const periodSwitch = await journalRows();
          if (periodSwitch.search !== '' || !periodSwitch.active?.includes('Patta hisob') || periodSwitch.parties.length !== 2) throw Error('2b period isolation failed: '+JSON.stringify(periodSwitch));
          await window.webContents.executeJavaScript(`window.__filters2bStore.setState(s=>({currentPeriod:s.periods.find(p=>p.id==='P')}))`); await wait(80);
          await window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('[role=tab]')].find(b=>b.innerText.includes('Patta hisob'))?.click())()`); await wait(80);
          await inputText('Line-41'); await wait(80);
          const lineSearch = await journalRows();
          if (lineSearch.parties.length !== 1 || !lineSearch.parties[0].includes('Partiya 41')) throw Error('2b conveyor search expected party 41: '+JSON.stringify(lineSearch));
          await window.webContents.executeJavaScript(`(() => {const original={get:Storage.prototype.getItem,set:Storage.prototype.setItem,remove:Storage.prototype.removeItem};window.__2bStorageOriginal=original;Storage.prototype.getItem=function(){throw Error('fixture storage denied')};Storage.prototype.setItem=function(){throw Error('fixture storage denied')};Storage.prototype.removeItem=function(){throw Error('fixture storage denied')};})()`);
          await window.webContents.executeJavaScript(`window.__filters2bStore.setState(s=>({licenseStatus:{...s.licenseStatus,activationId:'filters-2b-storage-denied'}}))`); await wait(80);
          await inputText('42'); await wait(80);
          const storageFallback = await journalRows();
          await window.webContents.executeJavaScript(`(() => {Storage.prototype.getItem=window.__2bStorageOriginal.get;Storage.prototype.setItem=window.__2bStorageOriginal.set;Storage.prototype.removeItem=window.__2bStorageOriginal.remove})()`);
          if (storageFallback.search !== '42' || storageFallback.parties.length !== 1 || !storageFallback.parties[0].includes('Partiya 42')) throw Error('2b storage-denied in-memory search fallback failed: '+JSON.stringify(storageFallback));
          await window.webContents.executeJavaScript(`window.__filters2bStore.setState(s=>({licenseStatus:{...s.licenseStatus,activationId:'filters-2b-keyboard'}}))`); await wait(80);
          await window.webContents.executeJavaScript(`(() => {const i=document.querySelector('.journal-filters input');i.focus();i.select()})()`);
          window.webContents.sendInputEvent({type:'keyDown',keyCode:'B'}); window.webContents.sendInputEvent({type:'char',keyCode:'b'}); window.webContents.sendInputEvent({type:'keyUp',keyCode:'B'}); await wait(100);
          const keyboard = await journalRows();
          if (keyboard.search !== 'b' || keyboard.parties.length !== 1 || !keyboard.parties[0].includes('Partiya 41')) throw Error('2b keyboard search expected party 41: '+JSON.stringify(keyboard));
            const evidence = { fixtureRoot, setup, fixture, initial, mismatch, mismatchScreenshot, modelStatusLayout, complete, inProgress, ticketSearch, noResults, rerender, refreshed, cleared, closed,
             actorSwitch, actorRestore, journalAuthB, journalAuthA, authBefore, authAfter, closedTicketSearch, companySwitch, companyRestore, archive, periodSwitch, lineSearch, storageFallback, keyboard, screenshot:path.join(screenshotDir,'selected-ticket.png') };
          fsSync.writeFileSync(path.join(screenshotDir,'evidence.json'),JSON.stringify(evidence,null,2));
          console.log('FILTERS_2B_PASS '+JSON.stringify(evidence));
          return;
        }
        if (process.env.PATTA_JUMP_ONLY === '1') {
          const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
          const waitFor = async (predicate, label, timeout = 18000) => { const until=Date.now()+timeout; while(Date.now()<until){if(await predicate())return;await wait(50)} throw Error(`Patta jump timeout: ${label}`); };
           const setup = await window.webContents.executeJavaScript('window.renderPattaJumpApp()');
           await window.webContents.executeJavaScript(`(()=>{const a=window.__pattaJumpAuth.getState();a.setAuth({user:{uid:'jump-auth-A',email:'jump-a@fixture.invalid',companyId:a.companyId,displayName:'Jump A',role:a.role,permissions:a.permissions,deviceId:a.deviceId,status:a.status,lastSeen:'fixture',createdAt:'fixture'}})})()`);
          if (setup.tickets.length !== 2 || setup.tickets.map(t=>t.id).sort().join(',') !== 'entered,same-party-patta-2'
            || setup.tickets[0].party !== setup.tickets[1].party) throw Error('SQLite-backed same-party ticket fixture mismatch '+JSON.stringify(setup));
          const shots = path.join(root,'.opencode/deep-audit/output/post-redesign-worker-patta-jump-screenshots',path.basename(fixtureRoot)); fsSync.mkdirSync(shots,{recursive:true});
          window.setSize(1440,1000); window.show(); window.focus();
          const evalUi = js => window.webContents.executeJavaScript(js);
          const waitDetail = () => waitFor(()=>evalUi(`Boolean(document.querySelector('.phase-c-worker-detail .e3-detail-table'))`),'WorkerDetail render');
          await waitDetail();
          const store = `window.__pattaJumpStore`;
          const linkState = await evalUi(`(()=>{const s=${store}.getState();return {modal:s.modalState,company:s.licenseStatus.companyId,period:s.currentPeriod.id,archive:s.selectedArchiveFilename,permissions:window.__pattaJumpAuth.getState().permissions}})()`);
          const secondButton = `[data-ticket-edit-link="same-party-patta-2"]`;
          const payrollRowCheck = await evalUi(`(()=>{const rows=[...document.querySelectorAll('.e3-detail-table tbody tr')],payroll=rows.filter(r=>r.innerText.toLowerCase().includes('davr ish haqi'));return {count:payroll.length,hasLink:payroll.some(r=>r.querySelector('[data-ticket-edit-link]'))}})()`);
          if(!payrollRowCheck.count||payrollRowCheck.hasLink) throw Error('Payroll summary row should exist without a fake ticket link '+JSON.stringify(payrollRowCheck));
          const buttonDetails = await evalUi(`(()=>[...document.querySelectorAll('[data-ticket-edit-link]')].map(b=>({id:b.dataset.ticketEditLink,text:b.innerText,aria:b.getAttribute('aria-label')})))()`);
          if(!buttonDetails.some(b=>b.id==='entered')||!buttonDetails.some(b=>b.id==='same-party-patta-2')) throw Error('Submitted-ticket links missing from actual WorkerDetail '+JSON.stringify(buttonDetails));
          await evalUi(`(()=>{const i=document.querySelector('.e3-detail-filters input'),s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,'1');i.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'1'}))})()`); await wait(50);
          const before = db.prepare(`SELECT t.id,t.company_id,t.model_id,t.period_id,t.party_number,t.patta_number,t.qty,t.size,t.color,t.konveyer,
            (SELECT json_group_array(json_object('op',e.op_name,'worker',e.worker_id,'qty',e.qty,'rate',e.rate_snapshot)) FROM ticket_entries e WHERE e.ticket_id=t.id ORDER BY e.op_name) entries
            FROM tickets t WHERE t.company_id=? AND t.id IN ('entered','same-party-patta-2') ORDER BY t.id`).all('hisob_test_browser');
          const noNavWrite = db.prepare(`SELECT COUNT(*) AS n FROM local_outbox WHERE company_id=? AND command_type='UpdateTicket'`).get('hisob_test_browser').n;
          if(noNavWrite!==0) throw Error('Navigation itself created an UpdateTicket money/write command '+noNavWrite);
          const selectedBefore = before.find(t=>t.id==='same-party-patta-2');
          const ticketDb = id => db.prepare(`SELECT t.id,t.company_id,t.model_id,t.period_id,t.party_number,t.patta_number,t.qty,t.size,t.color,t.konveyer,
            (SELECT json_group_array(json_object('op',e.op_name,'worker',e.worker_id,'qty',e.qty,'rate',e.rate_snapshot)) FROM ticket_entries e WHERE e.ticket_id=t.id ORDER BY e.op_name) entries
            FROM tickets t WHERE t.company_id=? AND t.id=?`).get('hisob_test_browser',id);
          if(!selectedBefore||selectedBefore.model_id!=='m'||selectedBefore.party_number!=='1'||selectedBefore.patta_number!==2||selectedBefore.size!=='L'||selectedBefore.qty!==7||selectedBefore.konveyer!=='Line-B') throw Error('Selected SQLite ticket critical fields unexpected '+JSON.stringify(selectedBefore));
          const click = selector => evalUi(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b)throw Error('missing clickable '+${JSON.stringify(selector)});b.click()})()`);
           await click(secondButton);
          await waitFor(()=>evalUi(`document.querySelector('.phase-c-dialog h2')?.innerText==='Patta #2 ni tahrirlash'`),'exact existing EditSubmittedTicketModal');
           const editOpen = await evalUi(`(()=>{const s=${store}.getState(),m=document.querySelector('.phase-c-dialog');return {modalType:s.modalState.type,id:s.modalState.data?.id,title:m?.querySelector('h2')?.innerText,text:m?.innerText.slice(0,650),inputs:[...m.querySelectorAll('tbody input')].map(i=>i.value),stateTicket:s.submittedTickets.find(t=>t.id===s.modalState.data?.id)}})()`);
          if(editOpen.modalType!=='edit_ticket'||editOpen.id!=='same-party-patta-2'||!editOpen.text.includes('Partiya 1')||!editOpen.text.includes('Model: Demo')||!editOpen.text.includes('Razmer: L')||!editOpen.text.includes('7 dona')||editOpen.inputs.join(',')!=='7,8') throw Error('Worker jump did not open exact submitted ticket with all modal fields '+JSON.stringify(editOpen));
          await wait(250);
          const editVisual=await evalUi(`(()=>{const e=document.querySelector('.phase-c-dialog'),r=e?.getBoundingClientRect(),s=e&&getComputedStyle(e);return {rect:r&&{x:r.x,y:r.y,width:r.width,height:r.height},display:s?.display,visibility:s?.visibility,opacity:s?.opacity,zIndex:s?.zIndex,modal:${store}.getState().modalState.type}})()`);
          if(!editVisual.rect||editVisual.rect.width<300||editVisual.rect.height<200||editVisual.display==='none'||editVisual.visibility==='hidden'||Number(editVisual.opacity)<0.9||editVisual.zIndex!=='9999'||editVisual.modal!=='edit_ticket') throw Error('Existing edit modal is not visibly rendered '+JSON.stringify(editVisual));
           fsSync.writeFileSync(path.join(shots,'selected-ticket-edit.png'),(await window.webContents.capturePage()).toPNG());
           const writesBeforeAuthSwitch=db.prepare(`SELECT COUNT(*) AS n FROM local_outbox WHERE company_id=? AND command_type='UpdateTicket'`).get('hisob_test_browser').n;
           await evalUi(`(()=>{const a=window.__pattaJumpAuth.getState();a.setAuth({user:{uid:'jump-auth-B',email:'jump-b@fixture.invalid',companyId:a.companyId,displayName:'Jump B',role:a.role,permissions:a.permissions,deviceId:a.deviceId,status:a.status,lastSeen:'fixture',createdAt:'fixture'}})})()`); await waitFor(()=>evalUi(`${store}.getState().modalState.type==='worker_detail'`),'actor switch closes stale jump editor');
           const staleAfterAuthSwitch=await evalUi(`({type:${store}.getState().modalState.type,edit:!!document.querySelector('.phase-c-dialog h2'),links:document.querySelectorAll('[data-ticket-edit-link]').length})`);
           const writesAfterAuthSwitch=db.prepare(`SELECT COUNT(*) AS n FROM local_outbox WHERE company_id=? AND command_type='UpdateTicket'`).get('hisob_test_browser').n;
           if(staleAfterAuthSwitch.type!=='worker_detail'||staleAfterAuthSwitch.edit||writesAfterAuthSwitch!==writesBeforeAuthSwitch) throw Error('Auth UID change left stale jump editor or wrote ticket '+JSON.stringify({staleAfterAuthSwitch,writesBeforeAuthSwitch,writesAfterAuthSwitch}));
           await evalUi(`(()=>{const a=window.__pattaJumpAuth.getState();a.setAuth({user:{uid:'jump-auth-A',email:'jump-a@fixture.invalid',companyId:a.companyId,displayName:'Jump A',role:a.role,permissions:a.permissions,deviceId:a.deviceId,status:a.status,lastSeen:'fixture',createdAt:'fixture'}})})()`); await wait(60);
           if(await evalUi(`document.querySelector('.phase-c-dialog h2')?.innerText||''`)) throw Error('Returning actor A reopened stale editor without a fresh explicit open');
           await click(secondButton); await waitFor(()=>evalUi(`document.querySelector('.phase-c-dialog h2')?.innerText==='Patta #2 ni tahrirlash'`),'fresh actor A explicit open');
           window.webContents.sendInputEvent({type:'keyDown',keyCode:'ESC'}); await waitFor(()=>evalUi(`window.__pattaJumpStore.getState().modalState.type==='worker_detail'`),'cancel returns to WorkerDetail'); await wait(80);
          const cancelReturn=await evalUi(`(()=>({query:document.querySelector('.e3-detail-filters input')?.value,focus:document.activeElement?.dataset?.ticketEditLink||''}))()`);
          if(cancelReturn.query!=='1'||cancelReturn.focus!=='same-party-patta-2') throw Error('Cancel/Escape failed to return focus to the selected source-ticket link '+JSON.stringify(cancelReturn));
          await click(secondButton); await waitFor(()=>evalUi(`document.querySelector('.phase-c-dialog h2')?.innerText==='Patta #2 ni tahrirlash'`),'reopen exact ticket for edit/save');
          await evalUi(`(()=>{const i=document.querySelector('.phase-c-dialog tbody tr:nth-child(1) input');const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,'8');i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}))})()`);
          await evalUi(`document.querySelector('.phase-c-dialog button')`);
          await evalUi(`(()=>[...document.querySelectorAll('.phase-c-dialog button')].find(b=>b.innerText.includes('Saqlash va hisoblarni yangilash')).click())()`);
          await waitFor(()=>ticketDb('same-party-patta-2').entries !== selectedBefore.entries,'canonical SQLite ticket update',15000);
          manager.closeAllCompanyDatabases(); db=manager.getCompanyDatabase(fixtureRoot,'hisob_test_browser');
          const selectedAfter = ticketDb('same-party-patta-2'), siblingAfter = ticketDb('entered');
          const outbox=db.prepare(`SELECT command_type,status,payload_json FROM local_outbox WHERE company_id=? AND command_type='UpdateTicket'`).all('hisob_test_browser');
          if(selectedAfter.id!=='same-party-patta-2'||!String(selectedAfter.entries).includes('"worker":8')||JSON.stringify(siblingAfter)!==JSON.stringify(before.find(t=>t.id==='entered'))
            ||!outbox.some(row=>row.command_type==='UpdateTicket')) throw Error('Canonical edit/outbox altered wrong patta or did not persist selected assignment '+JSON.stringify({selectedAfter,siblingAfter,before,outbox}));
          await waitDetail(); await wait(80);
          const returned = await evalUi(`(()=>({modal:${store}.getState().modalState.type,worker:${store}.getState().modalState.workerId,query:document.querySelector('.e3-detail-filters input')?.value,focus:document.activeElement?.dataset?.ticketEditLink||'',focusSearch:document.activeElement?.matches('.e3-detail-filters input')||false,rows:[...document.querySelectorAll('.e3-detail-table tbody tr')].map(r=>r.innerText)}))()`);
          if(returned.modal!=='worker_detail'||returned.worker!==7||returned.query!=='1'||!returned.focusSearch) throw Error('Edit close did not return/focus WorkerDetail with retained filters '+JSON.stringify({returned,setup,buttonDetails,editOpen}));
           await evalUi(`window.__pattaJumpStore.setState(s=>({modalState:{type:'edit_ticket',data:{...s.submittedTickets.find(t=>t.id==='same-party-patta-2'),returnToWorkerDetail:7,jumpContext:{companyId:'hisob_test_browser',periodId:'P',activationId:'patta-jump-actor-a',authUserId:'jump-auth-A',authRole:'admin'}}}}))`);
          await waitFor(()=>evalUi(`document.querySelector('.phase-c-dialog h2')?.innerText.includes('Patta #2')`),'reopen updated selected ticket through existing edit modal');
          const reopened=await evalUi(`(()=>({id:${store}.getState().modalState.data?.id,fields:document.querySelector('.phase-c-dialog')?.innerText.slice(0,450),inputs:[...document.querySelectorAll('.phase-c-dialog tbody input')].map(i=>i.value)}))()`);
          if(reopened.id!=='same-party-patta-2'||reopened.inputs.join(',')!=='8,8'||!reopened.fields.includes('Partiya 1')||!reopened.fields.includes('Razmer: L')) throw Error('Reopen readback mismatch '+JSON.stringify(reopened));
          window.webContents.sendInputEvent({type:'keyDown',keyCode:'ESC'}); await waitFor(()=>evalUi(`window.__pattaJumpStore.getState().modalState.type==='worker_detail'`),'Escape returns to WorkerDetail'); await waitDetail();
          await wait(50);
          const escapeReturn=await evalUi(`(()=>({query:document.querySelector('.e3-detail-filters input')?.value,focus:document.activeElement?.dataset?.ticketEditLink||'',focusSearch:document.activeElement?.matches('.e3-detail-filters input')||false}))()`);
          if(escapeReturn.query!=='1'||!escapeReturn.focusSearch) throw Error('Escape did not preserve WorkerDetail filters/focus '+JSON.stringify(escapeReturn));
          await evalUi(`document.querySelector('.toast-item button')?.click()`); await wait(40);
          window.setSize(760,1000); await wait(100);
          const narrow=await evalUi(`(()=>{const e=document.querySelector('.phase-c-worker-detail'),b=document.querySelector('[data-ticket-edit-link="entered"]');b?.scrollIntoView({block:'center'});const r=e?.getBoundingClientRect(),q=b?.getBoundingClientRect(),hit=q&&document.elementFromPoint(q.x+q.width/2,q.y+q.height/2);return {rect:r&&{x:r.x,y:r.y,width:r.width,height:r.height},link:!!b,linkRect:q&&{x:q.x,y:q.y,width:q.width,height:q.height},query:document.querySelector('.e3-detail-filters input')?.value,visible:!!q&&q.top>=0&&q.bottom<=innerHeight,unobscured:!!b&&(hit===b||b.contains(hit))}})()`);
          fsSync.writeFileSync(path.join(shots,'worker-detail-narrow.png'),(await window.webContents.capturePage()).toPNG());
          if(!narrow.link||narrow.rect.width<300||narrow.rect.height<200||narrow.linkRect.width<30||!narrow.visible||!narrow.unobscured||narrow.query!=='1') throw Error('Narrow WorkerDetail jump control/filter layout failed '+JSON.stringify(narrow));
          window.setSize(1440,1000); await wait(80);
          const detailFilter='.e3-detail-filters input';
          await evalUi(`(()=>{const i=document.querySelector(${JSON.stringify(detailFilter)}),s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,'SAMEPARTY-NO-MATCH');i.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'SAMEPARTY-NO-MATCH'}))})()`);
          await wait(70);
          // Restore a useful search and test a synchronous context change before clicking the source row.
          await evalUi(`(()=>{const i=document.querySelector(${JSON.stringify(detailFilter)}),s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,'');i.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}))})()`);
          await evalUi(`window.__pattaJumpStore.setState(s=>({licenseStatus:{...s.licenseStatus,companyId:'hisob_test_other'}}))`); await wait(60);
          const wrongCompanyAttempt=await evalUi(`(()=>{document.querySelector('[data-ticket-edit-link="entered"]')?.click();return {error:document.querySelector('[role=alert]')?.innerText||'',type:${store}.getState().modalState.type}})()`);
          await wait(60);
          wrongCompanyAttempt.error=await evalUi(`document.querySelector('[role=alert]')?.innerText||''`);
          await evalUi(`window.__pattaJumpStore.setState(s=>({licenseStatus:{...s.licenseStatus,companyId:'hisob_test_browser'}}))`); await wait(60);
          const beforeClosed=await evalUi(`window.__pattaJumpStore.getState().currentPeriod`);
          const closedPeriod=await evalUi(`window.__pattaJumpStore.getState().periods.find(p=>p.id==='Q')`);
          await evalUi(`window.__pattaJumpStore.setState(s=>({currentPeriod:${JSON.stringify(closedPeriod)},selectedArchiveFilename:'archive_Q.json'}))`); await wait(60);
          const closedPeriodLinkCount=await evalUi(`document.querySelectorAll('[data-ticket-edit-link]').length`);
          await evalUi(`window.__pattaJumpStore.setState(s=>({currentPeriod:${JSON.stringify(beforeClosed)},selectedArchiveFilename:null}))`); await wait(60);
          await evalUi(`window.__pattaJumpStore.setState(s=>({selectedArchiveFilename:'archive-fixture-Q.json'}))`); await wait(60);
          const archiveLinkCount=await evalUi(`document.querySelectorAll('[data-ticket-edit-link]').length`);
          await evalUi(`window.__pattaJumpStore.setState({selectedArchiveFilename:null})`); await wait(60);
          await evalUi(`window.pattaJumpRole('print')`); await wait(80);
          const roleLinkCount=await evalUi(`document.querySelectorAll('[data-ticket-edit-link]').length`);
          await evalUi(`window.pattaJumpRole('admin')`); await wait(80);
          await evalUi(`window.__pattaJumpStore.setState({modalState:{type:'worker_detail',workerId:7}})`); await waitDetail();
          await evalUi(`window.__pattaJumpStore.setState(s=>({currentPeriod:{...s.currentPeriod,id:'wrong-period'}}))`); await wait(50);
          const wrongPeriodAttempt=await evalUi(`(()=>{const b=document.querySelector('[data-ticket-edit-link="entered"]');b?.click();return {link:!!b,error:document.querySelector('[role=alert]')?.innerText||'',type:${store}.getState().modalState.type,period:${store}.getState().currentPeriod.id,archive:${store}.getState().selectedArchiveFilename}})()`);
          await wait(60);
          wrongPeriodAttempt.error=await evalUi(`document.querySelector('[role=alert]')?.innerText||''`);
          await evalUi(`window.__pattaJumpStore.setState(s=>({currentPeriod:${JSON.stringify(beforeClosed)}}))`); await wait(60);
          await click('[data-ticket-edit-link="entered"]');
          await evalUi(`window.__pattaJumpStore.setState(s=>({licenseStatus:{...s.licenseStatus,activationId:'patta-jump-actor-b'}}))`); await wait(80);
          const switchedActorModal=await evalUi(`({type:${store}.getState().modalState.type,guard:!!document.querySelector('.phase-c-dialog[role=alert]'),save:!![...document.querySelectorAll('.phase-c-dialog button')].find(b=>b.innerText.includes('Saqlash va hisoblarni yangilash'))})`);
          await evalUi(`window.__pattaJumpStore.setState(s=>({licenseStatus:{...s.licenseStatus,activationId:'patta-jump-actor-a'}}))`); await wait(50);
           if(switchedActorModal.type!=='worker_detail'||switchedActorModal.guard||switchedActorModal.save) throw Error('Actor context switch did not clear stale editor before save '+JSON.stringify(switchedActorModal));
           const lateSwitchStart=await evalUi(`(()=>{document.querySelector('[data-ticket-edit-link="entered"]')?.click();window.__pattaJumpStore.setState(s=>({licenseStatus:{...s.licenseStatus,companyId:'late-company'}}));return true})()`);
          await wait(70);
          const lateCompanyGuard=await evalUi(`({type:${store}.getState().modalState.type,guard:!!document.querySelector('.phase-c-dialog[role=alert]'),title:document.querySelector('.phase-c-dialog')?.innerText.slice(0,160)})`);
           if(!lateSwitchStart||lateCompanyGuard.type!=='worker_detail'||lateCompanyGuard.guard||lateCompanyGuard.title) throw Error('Late context change did not clear stale ticket edit '+JSON.stringify(lateCompanyGuard));
          await evalUi(`window.__pattaJumpStore.setState(s=>({licenseStatus:{...s.licenseStatus,companyId:'hisob_test_browser',activationId:'patta-jump-actor-a'}}))`); await wait(50);
           await waitDetail();
          const removal = await evalUi(`(()=>{const s=${store}.getState();const saved=s.submittedTickets.find(t=>t.id==='same-party-patta-2');${store}.setState({submittedTickets:s.submittedTickets.filter(t=>t.id!=='same-party-patta-2')});return saved})()`);
          await evalUi(`window.__pattaJumpStore.setState({modalState:{type:'edit_ticket',data:{id:'same-party-patta-2',returnToWorkerDetail:7}}})`); await wait(30);
          const missingTicket=await evalUi(`({error:document.querySelector('[role=alert]')?.innerText||'',type:${store}.getState().modalState.type})`);
          if(!removal||!missingTicket.error.includes('topilmadi')) throw Error('Missing ticket did not fail closed with clear message '+JSON.stringify({removal,missingTicket}));
            if(wrongCompanyAttempt.type!=='worker_detail'||closedPeriodLinkCount!==0||archiveLinkCount!==0||roleLinkCount!==0
             ||wrongPeriodAttempt.link||wrongPeriodAttempt.type!=='worker_detail') throw Error('Wrong-company/period or role/archive guard acceptance failed '+JSON.stringify({wrongCompanyAttempt,closedPeriodLinkCount,archiveLinkCount,roleLinkCount,wrongPeriodAttempt}));
           const evidence={fixtureRoot,setup,linkState,buttonDetails,payrollRowCheck,before,noNavWrite,selectedBefore,editOpen,editVisual,writesBeforeAuthSwitch,staleAfterAuthSwitch,writesAfterAuthSwitch,cancelReturn,selectedAfter,siblingAfter,outbox,returned,reopened,escapeReturn,narrow,wrongCompanyAttempt,closedPeriodLinkCount,archiveLinkCount,roleLinkCount,wrongPeriodAttempt,switchedActorModal,lateCompanyGuard,missingTicket,screenshots:shots};
          fsSync.writeFileSync(path.join(shots,'evidence.json'),JSON.stringify(evidence,null,2));
          console.log('PATTA_JUMP_PASS '+JSON.stringify(evidence)); return;
        }
        if (process.env.FILTERS_2G_ONLY === '1') {
          const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
          const waitFor = async (predicate, label) => {
            const until = Date.now() + 12000;
            while (Date.now() < until) { if (await predicate()) return; await wait(80); }
            throw Error(`2g timeout: ${label}`);
          };
           const setup = await window.webContents.executeJavaScript('window.renderFilters2gApp()');
          await waitFor(() => window.webContents.executeJavaScript(`Boolean(document.querySelector('#root .excel-app'))`), 'production App mount');
          const shots = path.join(root, '.opencode/deep-audit/output/post-redesign-filters-2g-screenshots'); fsSync.mkdirSync(shots,{recursive:true});
          const setSearch = async (selector, value) => window.webContents.executeJavaScript(`(() => {const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('missing '+${JSON.stringify(selector)});const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(value)});input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(value)}}));})()`);
          const openManager = async () => { await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({modalState:{type:'worker_manager'}}))`); await waitFor(()=>window.webContents.executeJavaScript(`Boolean(document.querySelector('.phase-c-worker-manager input[placeholder*="ID yoki ism"]'))`),'WorkerManager modal'); };
          const managerRead = () => window.webContents.executeJavaScript(`(()=>({query:document.querySelector('.phase-c-worker-manager input[placeholder*="ID yoki ism"]')?.value||'',rows:[...document.querySelectorAll('.phase-c-worker-manager .e3-manager-table tbody tr')].map(r=>r.innerText.trim()),count:document.querySelector('.phase-c-worker-manager .modal-header')?.innerText||''}))()`);
          const managerFilter = '.phase-c-worker-manager input[placeholder*="ID yoki ism"]';
          await openManager();
          const managerInitial = await managerRead();
          if(managerInitial.rows.length!==3) throw Error('2g WorkerManager baseline expected 3 synthetic IDs '+JSON.stringify(managerInitial));
          await setSearch(managerFilter,'Filter Worker Beta'); await wait(80); const managerByName=await managerRead();
          if(managerByName.rows.length!==1||!managerByName.rows[0].includes('732')) throw Error('2g WorkerManager name search exact ID 732 '+JSON.stringify(managerByName));
          await setSearch(managerFilter,'733'); await wait(80); const managerById=await managerRead();
          if(managerById.rows.length!==1||!managerById.rows[0].includes('Filter Worker Gamma')) throw Error('2g WorkerManager ID search exact name '+JSON.stringify(managerById));
          await setSearch(managerFilter,'no-worker-match'); await wait(80); const managerEmpty=await managerRead();
          if(managerEmpty.rows.length!==1||!managerEmpty.rows[0].includes('Ishchi topilmadi')) throw Error('2g WorkerManager empty state '+JSON.stringify(managerEmpty));
          await setSearch(managerFilter,''); await wait(80); const managerCleared=await managerRead();
          if(managerCleared.rows.length!==3) throw Error('2g WorkerManager clear expected IDs 731/732/733 '+JSON.stringify(managerCleared));
          await setSearch(managerFilter,'732'); await wait(80);
          await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({modalState:{type:null}}))`); await wait(80); await openManager();
          const managerReopen=await managerRead();
          if(managerReopen.query!=='732'||managerReopen.rows.length!==1||!managerReopen.rows[0].includes('732')) throw Error('2g WorkerManager close/reopen retention '+JSON.stringify(managerReopen));
          await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({licenseStatus:{...s.licenseStatus,activationId:'filters-2g-activation-b',machineId:'filters-2g-machine-b'}}))`); await wait(100);
          const managerActorB=await managerRead();
          if(managerActorB.query||managerActorB.rows.length!==3) throw Error('2g WorkerManager activation isolation '+JSON.stringify(managerActorB));
          await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({licenseStatus:{...s.licenseStatus,activationId:'filters-2g-activation-a',machineId:'filters-2g-machine-a'}}))`); await wait(100);
          const managerActorA=await managerRead();
           if(managerActorA.query!=='732'||managerActorA.rows.length!==1) throw Error('2g WorkerManager activation restore '+JSON.stringify(managerActorA));
             await window.webContents.executeJavaScript(`(()=>{const a=window.__filters2gAuth.getState();a.setAuth({user:{uid:'filters-auth-A',email:'filters-a@fixture.invalid',companyId:a.companyId,displayName:'Filters A',role:a.role,permissions:a.permissions,deviceId:a.deviceId,status:a.status,lastSeen:'fixture',createdAt:'fixture'}})})()`); await wait(80);
            await setSearch(managerFilter,'732'); await wait(80);
             await window.webContents.executeJavaScript(`(()=>{const a=window.__filters2gAuth.getState();a.setAuth({user:{uid:'filters-auth-B',email:'filters-b@fixture.invalid',companyId:a.companyId,displayName:'Filters B',role:a.role,permissions:a.permissions,deviceId:a.deviceId,status:a.status,lastSeen:'fixture',createdAt:'fixture'}})})()`); await wait(100);
           const managerAuthB=await managerRead();
           if(managerAuthB.query||managerAuthB.rows.length!==3) throw Error('2g WorkerManager authenticated UID isolation '+JSON.stringify(managerAuthB));
             await window.webContents.executeJavaScript(`(()=>{const a=window.__filters2gAuth.getState();a.setAuth({user:{uid:'filters-auth-A',email:'filters-a@fixture.invalid',companyId:a.companyId,displayName:'Filters A',role:a.role,permissions:a.permissions,deviceId:a.deviceId,status:a.status,lastSeen:'fixture',createdAt:'fixture'}})})()`); await wait(100);
           const managerAuthA=await managerRead();
           if(managerAuthA.query!=='732'||managerAuthA.rows.length!==1) throw Error('2g WorkerManager authenticated UID restore '+JSON.stringify(managerAuthA));
           await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({licenseStatus:{...s.licenseStatus,companyId:'filters-2g-company-b'}}))`); await wait(100);
          const managerCompanyB=await managerRead();
          if(managerCompanyB.query||managerCompanyB.rows.length!==3) throw Error('2g WorkerManager company isolation '+JSON.stringify(managerCompanyB));
          await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({licenseStatus:{...s.licenseStatus,companyId:'hisob_test_browser'}}))`); await wait(100);
          const managerCompanyA=await managerRead();
          if(managerCompanyA.query!=='732'||managerCompanyA.rows.length!==1) throw Error('2g WorkerManager company restore '+JSON.stringify(managerCompanyA));
          await window.webContents.executeJavaScript(`(()=>{const original={get:Storage.prototype.getItem,set:Storage.prototype.setItem,remove:Storage.prototype.removeItem};window.__filters2gDenied=original;window.__filters2gCalls={getItem:0,setItem:0,removeItem:0};for(const name of Object.keys(window.__filters2gCalls))Storage.prototype[name]=function(){window.__filters2gCalls[name]++;throw Error('fixture denied '+name)}})()`);
          await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({modalState:{type:null}}))`); await wait(60); await openManager();
          const managerDeniedInitial=await managerRead();
          if(managerDeniedInitial.query||managerDeniedInitial.rows.length!==3) throw Error('2g WorkerManager denied-storage initial fallback '+JSON.stringify(managerDeniedInitial));
          await setSearch(managerFilter,'731'); await wait(80); const managerStorage=await managerRead();
          if(managerStorage.rows.length!==1||!managerStorage.rows[0].includes('731')) throw Error('2g WorkerManager denied-storage fallback '+JSON.stringify(managerStorage));
          await setSearch(managerFilter,''); await wait(80); const managerStorageCleared=await managerRead();
          if(managerStorageCleared.rows.length!==3) throw Error('2g WorkerManager denied-storage clear '+JSON.stringify(managerStorageCleared));
          const managerStorageCalls=await window.webContents.executeJavaScript(`(()=>{for(const [name,key] of [['getItem','get'],['setItem','set'],['removeItem','remove']])Storage.prototype[name]=window.__filters2gDenied[key];return window.__filters2gCalls})()`);
          if(managerStorageCalls.getItem<1||managerStorageCalls.setItem<1||managerStorageCalls.removeItem<1) throw Error('2g WorkerManager storage denial was not exercised '+JSON.stringify(managerStorageCalls));
          await setSearch(managerFilter,'732'); await wait(70); await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
          window.setSize(1440,1000); window.show(); window.focus(); await wait(800);
          const managerVisual=await window.webContents.executeJavaScript(`(()=>{const e=document.querySelector('.phase-c-worker-manager'),r=e?.getBoundingClientRect(),s=e&&getComputedStyle(e);return {rect:r&&{x:r.x,y:r.y,width:r.width,height:r.height},display:s?.display,visibility:s?.visibility,opacity:s?.opacity,zIndex:s?.zIndex}})()`);
          if(!managerVisual.rect||managerVisual.rect.width<300||managerVisual.rect.height<200||managerVisual.display==='none'||managerVisual.visibility==='hidden') throw Error('2g WorkerManager screenshot modal is not visibly rendered '+JSON.stringify(managerVisual));
          fsSync.writeFileSync(path.join(shots,'worker-manager-filtered.png'),(await window.webContents.capturePage()).toPNG());
            await window.webContents.executeJavaScript(`(()=>{const a=window.__filters2gAuth.getState();a.setAuth({user:{uid:'filters-auth-A',email:'filters-a@fixture.invalid',companyId:a.companyId,displayName:'Filters A',role:a.role,permissions:a.permissions,deviceId:a.deviceId,status:a.status,lastSeen:'fixture',createdAt:'fixture'}});window.__filters2gStore.setState(s=>({modalState:{type:'worker_detail',workerId:731}}))})()`);
          await waitFor(()=>window.webContents.executeJavaScript(`Boolean(document.querySelector('.e3-detail-filters input'))`),'WorkerDetail modal');
          const detailSearch='.e3-detail-filters input';
          const detailRead=()=>window.webContents.executeJavaScript(`(()=>({query:document.querySelector('.e3-detail-filters input')?.value||'',selects:[...document.querySelectorAll('.e3-detail-filters select')].map(s=>s.value),rows:[...document.querySelectorAll('.e3-detail-table tbody tr')].map(r=>r.innerText),count:document.querySelector('.e3-detail-filters strong')?.innerText||''}))()`);
          const detailInitial=await detailRead();
            if(detailInitial.count!=='5'||detailInitial.rows.length!==5||!['FILTER-PARTY-101','FILTER-PARTY-202','FILTER-PARTY-303'].every(id=>detailInitial.rows.some(row=>row.includes(id)))) throw Error('2g WorkerDetail baseline expected 3 period-P tickets plus 2 unknown payroll rows '+JSON.stringify(detailInitial));
          const selectValue=async (index,value)=>window.webContents.executeJavaScript(`(()=>{const s=document.querySelectorAll('.e3-detail-filters select')[${index}];if(!s)throw Error('missing filter select '+${index});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
            await selectValue(0,'Filter Model B'); await wait(70); const detailModel=await detailRead();
            if(detailModel.count!=='2'||!detailModel.rows.some(row=>row.includes('FILTER-PARTY-202'))) throw Error('2g WorkerDetail model filter '+JSON.stringify(detailModel));
            await selectValue(1,'Hem'); await wait(70); const detailOperation=await detailRead();
           if(detailOperation.count!=='1'||!detailOperation.rows[0].includes('FILTER-PARTY-202')) throw Error('2g WorkerDetail operation filter '+JSON.stringify(detailOperation));
            await selectValue(2,'Line-B-Konveyer'); await setSearch(detailSearch,'FILTER-PARTY-202'); await wait(80); const detailConveyorSearch=await detailRead();
          if(detailConveyorSearch.count!=='1'||!detailConveyorSearch.rows[0].includes('FILTER-PARTY-202')) throw Error('2g WorkerDetail conveyor/search filters '+JSON.stringify(detailConveyorSearch));
          await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
          const detailVisual=await window.webContents.executeJavaScript(`(()=>{const e=document.querySelector('.phase-c-worker-detail'),r=e?.getBoundingClientRect(),s=e&&getComputedStyle(e);return {rect:r&&{x:r.x,y:r.y,width:r.width,height:r.height},display:s?.display,visibility:s?.visibility,opacity:s?.opacity,zIndex:s?.zIndex}})()`);
          if(!detailVisual.rect||detailVisual.rect.width<300||detailVisual.rect.height<200||detailVisual.display==='none'||detailVisual.visibility==='hidden') throw Error('2g WorkerDetail screenshot modal is not visibly rendered '+JSON.stringify(detailVisual));
          fsSync.writeFileSync(path.join(shots,'worker-detail-filtered.png'),(await window.webContents.capturePage()).toPNG());
          await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({modalState:{type:null}}))`); await wait(60);
          await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({modalState:{type:'worker_detail',workerId:731}}))`);
          await waitFor(()=>window.webContents.executeJavaScript(`Boolean(document.querySelector('.e3-detail-filters input'))`),'WorkerDetail reopen');
           const detailReopen=await detailRead();
            if(detailReopen.query!=='FILTER-PARTY-202'||detailReopen.selects.join('|')!=='Filter Model B|Hem|Line-B-Konveyer'||detailReopen.count!=='1') throw Error('2g WorkerDetail close/reopen retained filters '+JSON.stringify(detailReopen));
           await window.webContents.executeJavaScript(`(()=>{const a=window.__filters2gAuth.getState();a.setAuth({user:{uid:'filters-auth-B',email:'filters-b@fixture.invalid',companyId:a.companyId,displayName:'Filters B',role:a.role,permissions:a.permissions,deviceId:a.deviceId,status:a.status,lastSeen:'fixture',createdAt:'fixture'}})})()`); await wait(100);
           const detailAuthB=await detailRead();
            if(detailAuthB.query||detailAuthB.selects.includes('Filter Model B')||detailAuthB.count!=='5') throw Error('2g WorkerDetail authenticated UID isolation '+JSON.stringify(detailAuthB));
           await window.webContents.executeJavaScript(`(()=>{const a=window.__filters2gAuth.getState();a.setAuth({user:{uid:'filters-auth-A',email:'filters-a@fixture.invalid',companyId:a.companyId,displayName:'Filters A',role:a.role,permissions:a.permissions,deviceId:a.deviceId,status:a.status,lastSeen:'fixture',createdAt:'fixture'}})})()`); await wait(100);
           const detailAuthA=await detailRead();
           if(detailAuthA.query!=='FILTER-PARTY-202'||detailAuthA.count!=='1') throw Error('2g WorkerDetail authenticated UID restore '+JSON.stringify(detailAuthA));
           await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({modalState:{type:'worker_detail',workerId:732}}))`); await wait(100);
          const detailWorkerB=await detailRead();
            if(detailWorkerB.query||detailWorkerB.selects.includes('Filter Model B')||detailWorkerB.count!=='3'||!detailWorkerB.rows.some(row=>row.includes('FILTER-PARTY-404'))) throw Error('2g WorkerDetail worker isolation '+JSON.stringify(detailWorkerB));
           await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({modalState:{type:'worker_detail',workerId:731}}))`); await wait(100);
           const detailWorkerA=await detailRead();
           if(detailWorkerA.query!=='FILTER-PARTY-202'||detailWorkerA.count!=='1') throw Error('2g WorkerDetail worker return restore '+JSON.stringify(detailWorkerA));
           await window.webContents.executeJavaScript(`window.__filters2gAuth.getState().setAuth({user:null})`); await wait(80);
           await setSearch(detailSearch,'FILTER-PARTY-202'); await wait(80);
          await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({licenseStatus:{...s.licenseStatus,activationId:'filters-2g-activation-b',machineId:'filters-2g-machine-b'}}))`); await wait(100);
          const detailActorB=await detailRead();
            if(detailActorB.query||detailActorB.selects.includes('Filter Model B')||detailActorB.count!=='5') throw Error('2g WorkerDetail activation isolation '+JSON.stringify(detailActorB));
          await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({licenseStatus:{...s.licenseStatus,activationId:'filters-2g-activation-a',machineId:'filters-2g-machine-a'}}))`); await wait(100);
          const detailActorA=await detailRead();
           if(detailActorA.query!=='FILTER-PARTY-202'||detailActorA.count!=='1') throw Error('2g WorkerDetail activation return restore '+JSON.stringify(detailActorA));
          await window.webContents.executeJavaScript(`(()=>{const original={get:Storage.prototype.getItem,set:Storage.prototype.setItem,remove:Storage.prototype.removeItem};window.__filters2gDenied=original;window.__filters2gCalls={getItem:0,setItem:0,removeItem:0};for(const name of Object.keys(window.__filters2gCalls))Storage.prototype[name]=function(){window.__filters2gCalls[name]++;throw Error('fixture denied '+name)}})()`);
          await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({modalState:{type:null}}))`); await wait(60);
          await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({modalState:{type:'worker_detail',workerId:731}}))`);
          await waitFor(()=>window.webContents.executeJavaScript(`Boolean(document.querySelector('.e3-detail-filters input'))`),'WorkerDetail denied-storage remount');
          const detailDeniedInitial=await detailRead();
            if(detailDeniedInitial.query||detailDeniedInitial.selects.includes('Filter Model B')||detailDeniedInitial.count!=='5') throw Error('2g WorkerDetail denied-storage initial fallback '+JSON.stringify(detailDeniedInitial));
          await setSearch(detailSearch,'FILTER-PARTY-101'); await wait(80); const detailStorage=await detailRead();
          if(detailStorage.count!=='1'||!detailStorage.rows[0].includes('FILTER-PARTY-101')) throw Error('2g WorkerDetail denied-storage fallback '+JSON.stringify(detailStorage));
          await setSearch(detailSearch,''); await selectValue(0,'all'); await selectValue(1,'all'); await selectValue(2,'all'); await wait(100);
          const detailStorageCleared=await detailRead();
            if(detailStorageCleared.count!=='5') throw Error('2g WorkerDetail denied-storage clear '+JSON.stringify(detailStorageCleared));
          const detailStorageCalls=await window.webContents.executeJavaScript(`(()=>{for(const [name,key] of [['getItem','get'],['setItem','set'],['removeItem','remove']])Storage.prototype[name]=window.__filters2gDenied[key];return window.__filters2gCalls})()`);
          if(detailStorageCalls.getItem<1||detailStorageCalls.setItem<1||detailStorageCalls.removeItem<1) throw Error('2g WorkerDetail storage denial was not exercised '+JSON.stringify(detailStorageCalls));
           await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({licenseStatus:{...s.licenseStatus,companyId:'filters-2g-company-b'},submittedTickets:s.submittedTickets.map(t=>({...t,companyId:'hisob_test_browser'}))}))`); await wait(100);
          const detailCompanyB=await detailRead();
           if(detailCompanyB.query||detailCompanyB.selects.includes('Filter Model B')||detailCompanyB.count!=='0'||detailCompanyB.rows.length) throw Error('2g WorkerDetail mismatched company projection must not expose prior-company rows '+JSON.stringify(detailCompanyB));
          await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({licenseStatus:{...s.licenseStatus,companyId:'hisob_test_browser'}}))`); await wait(100);
          const detailCompanyA=await detailRead();
          if(detailCompanyA.query!=='FILTER-PARTY-202'||detailCompanyA.count!=='1') throw Error('2g WorkerDetail company restore '+JSON.stringify(detailCompanyA));
           await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>{const period={...s.currentPeriod,id:'filters-2g-period-b',name:'Period B'};return {periods:[...s.periods,period],currentPeriod:period}})`); await wait(100);
           const detailPeriodB=await detailRead();
           if(detailPeriodB.query||detailPeriodB.selects.includes('Filter Model B')||detailPeriodB.count!=='0'||detailPeriodB.rows.length) throw Error('2g WorkerDetail stale period projection must not show prior ticket/payroll rows '+JSON.stringify(detailPeriodB));
           await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>{const ticket={...s.submittedTickets.find(t=>t.id==='FILTER2G-TICKET-101'),id:'FILTER2G-TICKET-B-909',periodId:'filters-2g-period-b',partyNumber:'FILTER-PARTY-B-909'};return {submittedTickets:[...s.submittedTickets,ticket]}})`); await wait(120);
           const detailPeriodBTicket=await detailRead();
           if(detailPeriodBTicket.count!=='1'||detailPeriodBTicket.rows.length!==1||!detailPeriodBTicket.rows[0].includes('FILTER-PARTY-B-909')||detailPeriodBTicket.rows.some(row=>row.includes('FILTER-PARTY-101')||row.includes('FILTER-PARTY-202')||row.includes('FILTER-PARTY-303'))) throw Error('2g period-B projection ticket row mixed prior-period rows '+JSON.stringify(detailPeriodBTicket));
           fsSync.writeFileSync(path.join(shots,'worker-detail-period-b-ticket.png'),(await window.webContents.capturePage()).toPNG());
           await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({currentPeriod:s.periods.find(p=>p.id==='P')}))`); await wait(100);
           const detailPeriodA=await detailRead();
            if(detailPeriodA.query!=='FILTER-PARTY-202'||detailPeriodA.count!=='1') throw Error('2g WorkerDetail period restore '+JSON.stringify(detailPeriodA));
           await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>{const ticket={...s.submittedTickets.find(t=>t.id==='FILTER2G-TICKET-303'),id:'FILTER2G-ARCHIVE-Q-303',periodId:'Q',partyNumber:'FILTER-ARCHIVE-Q-303'};return {selectedArchiveFilename:'archive-fixture-Q.json',selectedArchiveData:{period:{...s.currentPeriod,id:'Q',name:'Archive Q'},submittedTickets:[ticket]}}})`); await wait(100);
           const detailArchive=await detailRead();
           if(detailArchive.count!=='1'||detailArchive.rows.length!==1||!detailArchive.rows[0].includes('FILTER-ARCHIVE-Q-303')||detailArchive.rows.some(row=>row.includes('FILTER-PARTY-'))) throw Error('2g WorkerDetail selected archive period/company scoping '+JSON.stringify(detailArchive));
           const archiveLinks=await window.webContents.executeJavaScript(`document.querySelectorAll('[data-ticket-edit-link]').length`);
           if(archiveLinks!==0) throw Error('2g WorkerDetail archive showed edit links '+archiveLinks);
           await window.webContents.executeJavaScript(`window.__filters2gStore.setState({selectedArchiveFilename:null,selectedArchiveData:null})`); await wait(80);
           const detailArchiveReturn=await detailRead();
           if(detailArchiveReturn.query!=='FILTER-PARTY-202'||detailArchiveReturn.count!=='1'||!detailArchiveReturn.rows[0].includes('FILTER-PARTY-202')) throw Error('2g WorkerDetail archive return context restore '+JSON.stringify(detailArchiveReturn));
           await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({modalState:{type:null}}))`); await wait(60);
          await window.webContents.reload();
          await waitFor(()=>window.webContents.executeJavaScript(`typeof window.renderFilters2gApp==='function'`),'fixture renderer reload');
          await window.webContents.executeJavaScript(`window.renderFilters2gApp()`); await wait(200);
          await openManager(); const managerReload=await managerRead();
          if(managerReload.query!=='732'||managerReload.rows.length!==1||!managerReload.rows[0].includes('732')) throw Error('2g WorkerManager renderer refresh retention '+JSON.stringify(managerReload));
          await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({modalState:{type:'worker_detail',workerId:731}}))`);
          await waitFor(()=>window.webContents.executeJavaScript(`Boolean(document.querySelector('.e3-detail-filters input'))`),'WorkerDetail after reload');
          const detailReload=await detailRead();
            if(detailReload.query!=='FILTER-PARTY-202'||detailReload.selects.join('|')!=='all|all|all'||detailReload.count!=='1') throw Error('2g WorkerDetail renderer refresh retention '+JSON.stringify(detailReload));
          await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({licenseStatus:{...s.licenseStatus,role:'print'},modalState:{type:'worker_manager'}}));window.__filters2gAuth.getState().setAuth({status:'active',role:'print',companyId:'hisob_test_browser',permissions:['view:models','view:patta','print:patta','view:patta-hisob']})`); await wait(100);
          const managerRoleDenied=await window.webContents.executeJavaScript(`({modal:!!document.querySelector('.phase-c-worker-manager'),entry:!![...document.querySelectorAll('.quick-actions button')].find(b=>b.innerText.includes('Ishchilar')),modalState:window.__filters2gStore.getState().modalState.type})`);
          await window.webContents.executeJavaScript(`window.__filters2gStore.setState(s=>({modalState:{type:'worker_detail',workerId:731}}))`); await wait(100);
          const detailRoleDenied=await window.webContents.executeJavaScript(`({modal:!!document.querySelector('.phase-c-worker-detail')})`);
          if(managerRoleDenied.modal||managerRoleDenied.entry||managerRoleDenied.modalState||detailRoleDenied.modal) throw Error('2g unauthorized print-role modal access was not denied '+JSON.stringify({managerRoleDenied,detailRoleDenied}));
          const roleDenied={manager:managerRoleDenied,detail:detailRoleDenied};
           const evidence={fixtureRoot,setup,manager:{initial:managerInitial,byName:managerByName,byId:managerById,empty:managerEmpty,cleared:managerCleared,reopen:managerReopen,actorB:managerActorB,actorA:managerActorA,authB:managerAuthB,authA:managerAuthA,companyB:managerCompanyB,companyA:managerCompanyA,storageInitial:managerDeniedInitial,storage:managerStorage,storageCleared:managerStorageCleared,storageCalls:managerStorageCalls,visual:managerVisual,reload:managerReload},detail:{initial:detailInitial,model:detailModel,operation:detailOperation,conveyorSearch:detailConveyorSearch,reopen:detailReopen,workerB:detailWorkerB,workerA:detailWorkerA,authB:detailAuthB,authA:detailAuthA,actorB:detailActorB,actorA:detailActorA,storageInitial:detailDeniedInitial,storage:detailStorage,storageCleared:detailStorageCleared,storageCalls:detailStorageCalls,visual:detailVisual,companyB:detailCompanyB,companyA:detailCompanyA,periodB:detailPeriodB,periodBTicket:detailPeriodBTicket,periodA:detailPeriodA,archive:detailArchive,archiveLinks,archiveReturn:detailArchiveReturn,reload:detailReload},roleDenied,screenshots:shots};
          fsSync.writeFileSync(path.join(shots,'evidence.json'),JSON.stringify(evidence,null,2)); console.log('FILTERS_2G_PASS '+JSON.stringify(evidence)); return;
        }
        if (process.env.FILTERS_2A_ONLY === '1' || process.env.FILTERS_2A_ACTOR_STORAGE_ONLY === '1') {
          const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
          const setup = await window.webContents.executeJavaScript(`window.renderFilters2aApp('filters-actor-a')`);
          await window.webContents.executeJavaScript(`window.__filters2aAuth.getState().setAuth({status:'active',role:'admin',companyId:'hisob_test_browser',deviceId:'filters-device-a',user:{uid:'filters-actor-a',email:'actor-a@fixture.invalid',companyId:'hisob_test_browser',displayName:'Actor A',role:'admin',permissions:['edit:hisob','view:umumiy','view:patta'],deviceId:'filters-device-a',status:'active',lastSeen:'fixture',createdAt:'fixture'},permissions:['edit:hisob','view:umumiy','view:patta']})`);
          const chooseHisob = async () => {
            await window.webContents.executeJavaScript(`window.__store.setState(s=>({activeSheet:s.models[0].hisobSheetName}))`);
            const until=Date.now()+5000;
            while(Date.now()<until && !await window.webContents.executeJavaScript(`Boolean(document.querySelector('.e2c-hisob-search input'))`)) await wait(50);
            if(!await window.webContents.executeJavaScript(`Boolean(document.querySelector('.e2c-hisob-search input'))`))
              throw Error('Hisob search did not mount '+JSON.stringify(await window.webContents.executeJavaScript(`({sheet:window.__store.getState().activeSheet,models:window.__store.getState().models.map(m=>({id:m.id,name:m.name,hisobSheetName:m.hisobSheetName})),inputs:[...document.querySelectorAll('input')].map(i=>i.placeholder),classes:[...document.querySelectorAll('[class*="hisob"]')].map(e=>e.className).slice(0,12),text:document.body.innerText.slice(0,300)})`)));
          };
          await chooseHisob();
          const selectText = async (value) => window.webContents.executeJavaScript(`(() => {
            const input=document.querySelector('.e2c-hisob-search input'); if(!input) throw Error('Hisob search missing');
            input.focus(); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            setter.call(input,${JSON.stringify(value)}); input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(value)}}));
            input.dispatchEvent(new Event('change',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
          })()`);
          const rows = async () => window.webContents.executeJavaScript(`(() => ({
            count:document.querySelector('.e2c-hisob-filter-count')?.textContent.trim(),
            ids:[...document.querySelectorAll('.phase-b-hisob tbody tr.fast-row')].map(row=>row.querySelector('td')?.textContent.trim()),
            query:document.querySelector('.e2c-hisob-search input')?.value
          }))()`);
          await selectText('Filter Fixture Eight'); await wait(120);
          const selected = await rows();
          if (selected.count !== '1 / 3 ishchi' || selected.ids.join(',') !== '8') throw Error('Filter selection expected worker 8 only: '+JSON.stringify(selected));
          await window.webContents.executeJavaScript(`window.__store.setState(s=>({workers:[...s.workers]}))`); await wait(120);
          const rerender = await rows();
          if (rerender.query !== 'Filter Fixture Eight' || rerender.ids.join(',') !== '8') throw Error('Filter rerender reset: '+JSON.stringify(rerender));
          const screenshotDir = path.join(root,'.opencode/deep-audit/output/post-redesign-filters-2a-screenshots');
          fsSync.mkdirSync(screenshotDir,{recursive:true});
          await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
          fsSync.writeFileSync(path.join(screenshotDir,'selected-worker-8.png'),(await window.webContents.capturePage()).toPNG());
          await window.webContents.reload();
          await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>typeof window.renderFilters2aApp==='function'?window.renderFilters2aApp().then(resolve,reject):Date.now()-start>20000?reject(Error('fixture reload timeout')):setTimeout(poll,50);poll()})`);
           await window.webContents.executeJavaScript(`window.__filters2aAuth.getState().setAuth({status:'active',role:'admin',companyId:'hisob_test_browser',deviceId:'filters-device-a',user:{uid:'filters-actor-a',email:'actor-a@fixture.invalid',companyId:'hisob_test_browser',displayName:'Actor A',role:'admin',permissions:['edit:hisob','view:umumiy','view:patta'],deviceId:'filters-device-a',status:'active',lastSeen:'fixture',createdAt:'fixture'},permissions:['edit:hisob','view:umumiy','view:patta']})`);
          await chooseHisob(); await wait(200);
          const refreshed = await rows();
          if (refreshed.query !== 'Filter Fixture Eight' || refreshed.ids.join(',') !== '8') throw Error('Refresh did not retain selected filter: '+JSON.stringify(refreshed));
          await selectText('No Such Filter Worker'); await wait(120);
          const empty = await rows();
          if (empty.count !== '0 / 3 ishchi' || empty.ids.length !== 0) throw Error('Empty filter mismatch: '+JSON.stringify(empty));
          await selectText('Filter Fixture Nine'); await wait(120);
          const selectedNine = await rows();
          await window.webContents.executeJavaScript(`window.__store.setState(s=>({licenseStatus:{...s.licenseStatus,companyId:'other-company'}}))`); await wait(100);
           const switched = await rows();
           await window.webContents.executeJavaScript(`window.__store.setState(s=>({licenseStatus:{...s.licenseStatus,companyId:'hisob_test_browser'}}))`); await wait(120);
           await window.webContents.executeJavaScript(`window.__filters2aAuth.getState().setAuth({status:'active',role:'admin',companyId:'hisob_test_browser',deviceId:'filters-device-a',user:{uid:'filters-actor-a',email:'actor-a@fixture.invalid',companyId:'hisob_test_browser',displayName:'Actor A',role:'admin',permissions:['edit:hisob','view:umumiy','view:patta'],deviceId:'filters-device-a',status:'active',lastSeen:'fixture',createdAt:'fixture'},permissions:['edit:hisob','view:umumiy','view:patta']})`);
          await chooseHisob();
          const restored = await rows();
          if (selectedNine.ids.join(',') !== '9' || (switched.query || '') !== '' || restored.query !== 'Filter Fixture Nine' || restored.ids.join(',') !== '9')
            throw Error('Company-scoped filter isolation failed: '+JSON.stringify({selectedNine,switched,restored}));
          await selectText('Filter Fixture Eight'); await wait(100);
          await window.webContents.executeJavaScript(`window.__store.setState(s=>({currentPeriod:{...s.currentPeriod,id:'FILTER-OTHER-PERIOD'}}))`); await wait(100);
          const periodSwitch = await rows();
          await window.webContents.executeJavaScript(`window.__store.setState(s=>({currentPeriod:s.periods.find(p=>p.id==='P')}))`); await wait(120);
          const periodRestore = await rows();
          if ((periodSwitch.query || '') !== '' || periodRestore.query !== 'Filter Fixture Eight' || periodRestore.ids.join(',') !== '8')
            throw Error('Period-scoped filter isolation failed: '+JSON.stringify({periodSwitch,periodRestore}));
          await window.webContents.executeJavaScript(`(() => { const input=document.querySelector('.e2c-hisob-search input'); input.focus(); input.select(); })()`);
          window.webContents.sendInputEvent({type:'keyDown',keyCode:'A'}); window.webContents.sendInputEvent({type:'char',keyCode:'a'});
          window.webContents.sendInputEvent({type:'keyUp',keyCode:'A'}); await wait(100);
           const keyboard = await rows();
           if (keyboard.query !== 'a' || keyboard.count !== '0 / 3 ishchi' || keyboard.ids.length !== 0) throw Error('Keyboard filter interaction mismatch: '+JSON.stringify(keyboard));
           const preActorScope = { company: await window.webContents.executeJavaScript(`window.__store.getState().licenseStatus.companyId`),
             period: await window.webContents.executeJavaScript(`window.__store.getState().currentPeriod.id`),
             model: await window.webContents.executeJavaScript(`window.__store.getState().models[0].id`) };
           await selectText('Filter Fixture Eight'); await wait(100);
           await window.webContents.executeJavaScript(`window.__filters2aAuth.getState().setAuth({status:'active',role:'admin',companyId:'hisob_test_browser',deviceId:'filters-device-a',user:{uid:'filters-actor-b',email:'actor-b@fixture.invalid',companyId:'hisob_test_browser',displayName:'Actor B',role:'admin',permissions:['edit:hisob','view:umumiy','view:patta'],deviceId:'filters-device-a',status:'active',lastSeen:'fixture',createdAt:'fixture'},permissions:['edit:hisob','view:umumiy','view:patta']})`); await wait(120);
           const actorBInitial = await rows();
           if ((actorBInitial.query || '') !== '' || actorBInitial.ids.join(',') !== '7,8,9') throw Error('Same-company actor transition leaked actor A filter: '+JSON.stringify(actorBInitial));
           await selectText('Filter Fixture Nine'); await wait(100);
           const actorBSelected = await rows();
           await window.webContents.executeJavaScript(`window.__filters2aAuth.getState().setAuth({status:'active',role:'admin',companyId:'hisob_test_browser',deviceId:'filters-device-a',user:{uid:'filters-actor-a',email:'actor-a@fixture.invalid',companyId:'hisob_test_browser',displayName:'Actor A',role:'admin',permissions:['edit:hisob','view:umumiy','view:patta'],deviceId:'filters-device-a',status:'active',lastSeen:'fixture',createdAt:'fixture'},permissions:['edit:hisob','view:umumiy','view:patta']})`); await wait(120);
           const actorARestored = await rows();
           if (actorBSelected.ids.join(',') !== '9' || actorARestored.query !== 'Filter Fixture Eight' || actorARestored.ids.join(',') !== '8') throw Error('Actor UID-scoped restoration failed '+JSON.stringify({actorBInitial,actorBSelected,actorARestored}));
           await window.webContents.executeJavaScript(`window.__store.setState(s=>({licenseStatus:{...s.licenseStatus,activationId:'filters-session-b'}}))`); await wait(120);
           const sessionBInitial = await rows();
           if ((sessionBInitial.query || '') !== '' || sessionBInitial.ids.join(',') !== '7,8,9') throw Error('Same-company activation session transition leaked prior filter '+JSON.stringify(sessionBInitial));
           await selectText('Filter Fixture Nine'); await wait(100);
           const sessionBSelected = await rows();
           await window.webContents.executeJavaScript(`window.__store.setState(s=>({licenseStatus:{...s.licenseStatus,activationId:'filters-2a-local-only'}}))`); await wait(120);
           await window.webContents.executeJavaScript(`window.__filters2aAuth.getState().setAuth({status:'active',role:'admin',companyId:'hisob_test_browser',deviceId:'filters-device-a',user:{uid:'filters-actor-a',email:'actor-a@fixture.invalid',companyId:'hisob_test_browser',displayName:'Actor A',role:'admin',permissions:['edit:hisob','view:umumiy','view:patta'],deviceId:'filters-device-a',status:'active',lastSeen:'fixture',createdAt:'fixture'},permissions:['edit:hisob','view:umumiy','view:patta']})`); await wait(100);
           const sessionARestored = await rows();
           if (sessionBSelected.ids.join(',') !== '9' || sessionARestored.query !== 'Filter Fixture Eight' || sessionARestored.ids.join(',') !== '8') throw Error('Activation-session-scoped restoration failed '+JSON.stringify({sessionBInitial,sessionBSelected,sessionARestored}));
           const printRole = await window.webContents.executeJavaScript(`(() => {const auth=window.__filters2aAuth.getState();auth.setAuth({...auth,status:'active',role:'print',user:{...auth.user,role:'print'},permissions:['view:patta']});})()`); await wait(160);
           const printDenied = await window.webContents.executeJavaScript(`({search:!!document.querySelector('.e2c-hisob-search input'),denied:document.body.innerText.includes('Ruxsat Cheklangan')})`);
           await window.webContents.executeJavaScript(`(() => {const auth=window.__filters2aAuth.getState();auth.setAuth({...auth,status:'active',role:'admin',user:{...auth.user,role:'admin'},permissions:['edit:hisob','view:umumiy','view:patta']});})()`); await wait(120);
           const roleRestored = await rows();
           if (printDenied.search || !printDenied.denied || roleRestored.query !== 'Filter Fixture Eight' || roleRestored.ids.join(',') !== '8') throw Error('Hisob role guard or filter restore changed '+JSON.stringify({printDenied,roleRestored}));
           const storageDenied = await window.webContents.executeJavaScript(`(() => {
             const target=window.sessionStorage, methods=['getItem','setItem','removeItem'], original={};
             const calls={getItem:0,setItem:0,removeItem:0};
             for(const name of methods){const descriptor=Object.getOwnPropertyDescriptor(Storage.prototype,name);original[name]=descriptor;
               Object.defineProperty(Storage.prototype,name,{...descriptor,value:function(...args){if(this===target){calls[name]++;throw new Error('fixture sessionStorage denied '+name)}return descriptor.value.apply(this,args)}});}
             window.__filters2aDeniedStorage={target,methods,original,calls}; return calls;
           })()`);
           await window.webContents.executeJavaScript(`window.__store.setState(s=>({currentPeriod:{...s.currentPeriod,id:'FILTER-DENIED-STORAGE-SCOPE'}}))`); await wait(120);
           const deniedStorageEmpty = await rows();
           await selectText('No Such Filter Worker'); await wait(120);
           const deniedStorageNoMatch = await rows();
           await selectText(''); await wait(120);
           const deniedStorageCleared = await rows();
           const deniedStorageCalls = await window.webContents.executeJavaScript(`(() => {const denied=window.__filters2aDeniedStorage;for(const name of denied.methods)Object.defineProperty(Storage.prototype,name,denied.original[name]);return denied.calls})()`);
           if ((deniedStorageEmpty.query || '') !== '' || deniedStorageEmpty.ids.join(',') !== '7,8,9'
             || deniedStorageNoMatch.query !== 'No Such Filter Worker' || deniedStorageNoMatch.count !== '0 / 3 ishchi' || deniedStorageNoMatch.ids.length
             || deniedStorageCleared.query !== '' || deniedStorageCleared.count !== '3 / 3 ishchi' || deniedStorageCleared.ids.join(',') !== '7,8,9'
             || !deniedStorageCalls.getItem || !deniedStorageCalls.setItem || !deniedStorageCalls.removeItem)
             throw Error('Denied sessionStorage filtering/clear fallback failed '+JSON.stringify({deniedStorageEmpty,deniedStorageNoMatch,deniedStorageCleared,deniedStorageCalls}));
           const safetyContext = { company: await window.webContents.executeJavaScript(`window.__store.getState().licenseStatus.companyId`),
             periodBeforeStorage: preActorScope.period, model: await window.webContents.executeJavaScript(`window.__store.getState().models[0].id`) };
           if (preActorScope.company !== 'hisob_test_browser' || preActorScope.period !== 'P' || preActorScope.model !== 'm'
             || safetyContext.company !== preActorScope.company || safetyContext.model !== preActorScope.model)
             throw Error('Actor/storage tests escaped original company/period/model fixture scope '+JSON.stringify({preActorScope,safetyContext}));
           const actorShotDir = path.join(root,'.opencode/deep-audit/output/post-redesign-filters-2a-actor-storage-screenshots');
           fsSync.mkdirSync(actorShotDir,{recursive:true});
           await selectText('Filter Fixture Eight'); await wait(100);
           await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
           fsSync.writeFileSync(path.join(actorShotDir,'actor-a-retained.png'),(await window.webContents.capturePage()).toPNG());
           const actorEvidence = { fixtureRoot, setup, initial:selected, rerender, refreshed, empty, company:{selectedNine,switched,restored},
             period:{periodSwitch,periodRestore}, keyboard, preActorScope, actor:{actorBInitial,actorBSelected,actorARestored},
             activationSession:{sessionBInitial,sessionBSelected,sessionARestored}, printDenied, roleRestored,
             deniedStorage:{empty:deniedStorageEmpty,noMatch:deniedStorageNoMatch,cleared:deniedStorageCleared,calls:deniedStorageCalls}, screenshot:path.join(actorShotDir,'actor-a-retained.png') };
           fsSync.writeFileSync(path.join(actorShotDir,'evidence.json'),JSON.stringify(actorEvidence,null,2));
           if (process.env.FILTERS_2A_ACTOR_STORAGE_ONLY === '1') {
             console.log('FILTERS_2A_ACTOR_STORAGE_PASS '+JSON.stringify(actorEvidence)); return;
           }
           const journalFixture = await window.webContents.executeJavaScript(`window.mountFilters2bJournal()`);
           await wait(900);
           const journalRows = async () => window.webContents.executeJavaScript(`(() => ({
             parties:[...document.querySelectorAll('.journal-model-card tbody tr')].map(tr=>tr.innerText).filter(t=>t.includes('Partiya ')),
             search:document.querySelector('.journal-filters input')?.value,
             active:document.querySelector('[role=tab][aria-selected=true]')?.innerText,
             models:document.querySelectorAll('.journal-model-card').length
           }))()`);
           const setJournalSearch = async value => window.webContents.executeJavaScript(`(() => {const i=document.querySelector('.journal-filters input');const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,${JSON.stringify(value)});i.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(value)}}));})()`);
            const journalInitial = await journalRows();
            if (journalInitial.parties.length !== 2 || !journalInitial.parties.some(t=>t.includes('Partiya 41')) || !journalInitial.parties.some(t=>t.includes('Partiya 42'))) throw Error('Journal active series expected parties 41,42: '+JSON.stringify({journalInitial,body:await window.webContents.executeJavaScript('document.body.innerText.slice(-1500)')}));
            await setJournalSearch('JOURNAL-TICKET-4101'); await wait(100);
           const byTicket = await journalRows();
           if (byTicket.parties.length !== 1 || !byTicket.parties[0].includes('Partiya 41')) throw Error('Journal exact ticket search mismatch: '+JSON.stringify(byTicket));
           await window.webContents.executeJavaScript(`window.__filters2bStore.setState(s=>({printedPartyHistory:[...s.printedPartyHistory]}))`); await wait(80);
           const journalRerender = await journalRows();
           if (journalRerender.search !== 'JOURNAL-TICKET-4101' || journalRerender.parties.length !== 1) throw Error('Journal store rerender reset: '+JSON.stringify(journalRerender));
           const journalShotDir=path.join(root,'.opencode/deep-audit/output/post-redesign-filters-2b-screenshots');fsSync.mkdirSync(journalShotDir,{recursive:true});
           await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
           fsSync.writeFileSync(path.join(journalShotDir,'selected-ticket.png'),(await window.webContents.capturePage()).toPNG());
           await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Qidiruvni tozalash"]')?.click()`); await wait(80);
           const journalCleared = await journalRows();
           const tabClosed = await window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('[role=tab]')].find(b=>b.innerText.includes('Yopilgan'))?.click())()`); await wait(100);
           const journalClosed = await journalRows();
           if (journalCleared.parties.length !== 2 || journalCleared.search !== '' || journalClosed.parties.length !== 1 || !journalClosed.parties[0].includes('Partiya 43'))
             throw Error('Journal clear/closed boundary mismatch: '+JSON.stringify({journalCleared,journalClosed,tabClosed}));
           const evidence = { selected, rerender, refreshed, empty, company:{selectedNine,switched,restored}, period:{periodSwitch,periodRestore}, keyboard,
              journal:{journalFixture,journalInitial,journalMismatch,byTicket,journalRerender,journalCleared,journalClosed,screenshot:path.join(journalShotDir,'selected-ticket.png')}, screenshots:screenshotDir };
          fsSync.writeFileSync(path.join(screenshotDir,'evidence.json'),JSON.stringify(evidence,null,2));
          console.log('FILTERS_2A_PASS '+JSON.stringify(evidence));
          return;
        }
        if (process.env.MONEY_1C_ONLY === '1') {
         const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
         const evalUi = async expression => {
           try { return await window.webContents.executeJavaScript(expression); }
           catch (error) { console.error('MONEY_1C_EVAL_FAILED', expression, error); throw error; }
         };
         const waitFor = async (predicate, label, timeout = 12000) => {
           const end = Date.now() + timeout;
           while (Date.now() < end) {
             if (await predicate()) return;
             await wait(80);
           }
           throw Error(`money 1c timeout: ${label}`);
         };
          const screenshots = path.join(root, '.opencode/deep-audit/output/post-redesign-money-1c-screenshots');
          fsSync.mkdirSync(screenshots, { recursive: true });
          const staleBeforeShot = path.join(screenshots, 'umumiy-1440-before.png');
          if (fsSync.existsSync(staleBeforeShot)) fsSync.unlinkSync(staleBeforeShot);
          const localCommand = require('../../../apps/desktop/electron/database/workbookCommandPipeline.cjs');
         ipcMain.removeHandler('workbook-command');
          ipcMain.handle('workbook-command', async (_event, command) => {
            if (command?.companyId !== moneyCompany || command?.commandType !== 'UpsertWorker')
              return { success: false, code: 'COMPANY_SCOPE_MISMATCH', error: 'money 1c fixture command scope rejected' };
            if (holdNextMoneyCommand) {
              holdNextMoneyCommand = false;
              await new Promise(resolve => { releaseHeldMoneyCommand = resolve; });
              releaseHeldMoneyCommand = null;
            }
            if (rejectNextMoneyCommand) {
             rejectNextMoneyCommand = false;
             return { success: false, code: 'FIXTURE_COMMAND_REJECTED', error: 'Synthetic rejection; no fact written.' };
           }
           try { return { success: true, result: localCommand.executeWorkbookCommand(fixtureRoot, moneyCompany, command) }; }
           catch (error) { return { success: false, code: error?.code || 'WORKBOOK_COMMAND_FAILED', error: error?.message || String(error) }; }
         });
          const setup = await evalUi(`window.renderMoney1cApp(${JSON.stringify(moneyCompany)})`);
         window.setSize(1440, 1000);
         window.show();
         window.focus();
         await waitFor(() => evalUi(`Boolean(window.__money1cStore.getState().activeSheet==='Umumiy'
            && document.querySelector('.umumiy-report tbody tr.fast-row')?.textContent.includes('Worker 7')
            && document.querySelectorAll('.umumiy-report').length === 1
            && !document.querySelector('.phase-b-hisob')
            && document.querySelectorAll('.umumiy-report thead th').length === 9)`), 'nine-column Umumiy App');
         const before = await evalUi(`(() => ({ headers:[...document.querySelectorAll('.umumiy-report thead th')].map(th=>th.textContent.trim()),
            row:[...document.querySelectorAll('.umumiy-report tbody tr.fast-row')].find(row=>row.textContent.includes('Worker 7'))?.textContent,
            okladDisabled:document.querySelector('input[aria-label="Oklad #7"]')?.disabled,
            magazinDisabled:document.querySelector('input[aria-label="Magazin #7"]')?.disabled,
             status:document.querySelector('.umumiy-report-status')?.textContent }))()`);
          if (before.headers.length !== 9 || before.okladDisabled || before.magazinDisabled
            || !String(before.status).includes('Taxminiy') || !String(before.row || '').includes('Worker 7'))
            throw Error('money 1c initial render/permission evidence '+JSON.stringify(before));

         const edit = async (label, value, key = 'blur') => evalUi(`(() => {
           const input=document.querySelector('input[aria-label=${JSON.stringify(label)}]');
           if(!input || input.disabled) throw Error('missing or disabled '+${JSON.stringify(label)});
           input.focus();
           const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
           setter.call(input,${JSON.stringify(String(value))});
           input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(String(value))}}));
           input.dispatchEvent(new Event('change',{bubbles:true}));
           return true;
         })()`).then(async result => {
           await wait(35);
          await evalUi(`(() => { const input=document.querySelector('input[aria-label=${JSON.stringify(label)}]');
            if(${JSON.stringify(key)}==='enter') input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
              else { input.blur(); document.querySelector('.umumiy-report-search input')?.focus();
                input.dispatchEvent(new FocusEvent('focusout',{bubbles:true,relatedTarget:document.activeElement})); } return true; })()`);
           await wait(80);
            return result;
          });
          await edit('Oklad #8', '');
          if (moneyDb.prepare("SELECT COUNT(*) AS n FROM local_outbox WHERE company_id=? AND command_type='UpsertWorker'").get(moneyCompany).n !== 0)
            throw Error('unchanged zero Oklad emitted a command');
          await edit('Oklad #7', '2000000', 'enter');
         try {
           await waitFor(() => moneyDb.prepare("SELECT SUM(amount) AS v FROM worker_adjustments WHERE company_id=? AND worker_id=7 AND period_id='P' AND type='OKLAD'").get(moneyCompany).v === 2000000, 'Oklad command persisted');
         } catch (error) {
           console.log('MONEY_1C_Oklad_DEBUG', JSON.stringify({ persisted:moneyDb.prepare("SELECT id,amount FROM worker_adjustments WHERE company_id=? AND worker_id=7").all(moneyCompany),
             outbox:moneyDb.prepare("SELECT command_type,status,error_message,last_error FROM local_outbox WHERE company_id=?").all(moneyCompany),
             ui:await evalUi(`(() => { const s=window.__money1cStore.getState(); const i=document.querySelector('input[aria-label="Oklad #7"]'); return {
               value:i?.value,disabled:i?.disabled,active:document.activeElement?.getAttribute('aria-label'),
               period:s.currentPeriod?.id,company:s.licenseStatus?.companyId,notifications:s.notifications?.slice(-2) } })()`) }));
           throw error;
         }
         await edit('Magazin #7', '100000');
         await waitFor(() => moneyDb.prepare("SELECT SUM(amount) AS v FROM worker_adjustments WHERE company_id=? AND worker_id=7 AND period_id='P' AND type='MAGAZIN'").get(moneyCompany).v === 100000, 'Magazin command persisted');
         let projection = readWorkbookPayrollProjection(moneyDb, moneyCompany);
         let payroll = projection.payrollValuation.workers.find(item => Number(item.workerId) === 7);
         if (!payroll || payroll.pieceworkGross !== 500000 || payroll.gross !== 2500000 || payroll.net !== 2125000
           || payroll.oklad !== 2000000 || payroll.magazin !== 100000 || payroll.accountingStatus !== 'INCOMPLETE')
           throw Error('money 1c persisted expected payroll '+JSON.stringify(payroll));
          await waitFor(() => evalUi(`(() => { const t=document.querySelector('.umumiy-report')?.textContent.replace(/\\s+/g,' ');
            return t?.includes('2 500 000') && t?.includes('2 125 000') && t?.includes('2 000 000') && t?.includes('100 000'); })()`),
            'valued Umumiy after persisted Oklad/Magazin');
          await evalUi('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
          const afterShot = path.join(screenshots, `umumiy-1440-after-${process.pid}.png`);
          fsSync.writeFileSync(afterShot, (await window.webContents.capturePage()).toPNG());
         const outboxAfterSave = moneyDb.prepare("SELECT COUNT(*) AS n FROM local_outbox WHERE company_id=? AND command_type='UpsertWorker'").get(moneyCompany).n;
         const adjustmentCountAfterSave = moneyDb.prepare('SELECT COUNT(*) AS n FROM worker_adjustments WHERE company_id=? AND worker_id=7').get(moneyCompany).n;
         if (outboxAfterSave !== 2 || adjustmentCountAfterSave !== 4) throw Error('money 1c expected two commands/four adjustment facts');

         // Blur/Enter with an unchanged target emits no additional command or fact.
         await edit('Oklad #7', '2000000');
         await wait(120);
         if (moneyDb.prepare("SELECT COUNT(*) AS n FROM local_outbox WHERE company_id=? AND command_type='UpsertWorker'").get(moneyCompany).n !== outboxAfterSave)
           throw Error('unchanged Oklad emitted a command');
         // Escape discards a draft, and invalid typed money never reaches a durable fact.
         const draftEvidence = await evalUi(`(() => { const input=document.querySelector('input[aria-label="Oklad #7"]'); input.focus();
           const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,'3000000');
           input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'3000000'})); return true; })()`);
         await wait(35);
         await evalUi(`(() => { const input=document.querySelector('input[aria-label="Oklad #7"]');
           input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); return true; })()`);
         await wait(100);
         if (moneyDb.prepare("SELECT COUNT(*) AS n FROM local_outbox WHERE company_id=? AND command_type='UpsertWorker'").get(moneyCompany).n !== outboxAfterSave)
           throw Error('Escape draft emitted a command');
         await evalUi(`(() => { const input=document.querySelector('input[aria-label="Magazin #7"]'); input.focus();
           const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,'10.5');
           input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'10.5'})); })()`);
         await wait(35);
         await evalUi(`document.querySelector('input[aria-label="Magazin #7"]')?.blur()`);
         await wait(100);
          if (moneyDb.prepare("SELECT COUNT(*) AS n FROM local_outbox WHERE company_id=? AND command_type='UpsertWorker'").get(moneyCompany).n !== outboxAfterSave
            || moneyDb.prepare("SELECT SUM(amount) AS v FROM worker_adjustments WHERE company_id=? AND worker_id=7 AND period_id='P' AND type='MAGAZIN'").get(moneyCompany).v !== 100000)
            throw Error('invalid Magazin changed persisted money');
          await edit('Magazin #7', '-1');
          if (moneyDb.prepare("SELECT COUNT(*) AS n FROM local_outbox WHERE company_id=? AND command_type='UpsertWorker'").get(moneyCompany).n !== outboxAfterSave)
            throw Error('negative manual amount emitted a command');

           rejectNextMoneyCommand = true;
          await edit('Oklad #7', '2100000');
          await wait(80);
          if (moneyDb.prepare("SELECT SUM(amount) AS v FROM worker_adjustments WHERE company_id=? AND worker_id=7 AND period_id='P' AND type='OKLAD'").get(moneyCompany).v !== 2000000
            || moneyDb.prepare("SELECT COUNT(*) AS n FROM local_outbox WHERE company_id=? AND command_type='UpsertWorker'").get(moneyCompany).n !== outboxAfterSave)
            throw Error('rejected Oklad command was persisted');
          await evalUi(`window.renderMoney1cApp(${JSON.stringify(moneyCompany)})`);
          await waitFor(() => evalUi(`Boolean(window.__money1cStore.getState().payrollValuation?.workers?.find(w=>w.workerId===7))`), 'payroll restore after rejected command');

          // Period switch cancels a dirty draft; closed-period, wrong-company and unauthorized roles disable editors.
          await evalUi(`(() => { const input=document.querySelector('input[aria-label="Oklad #7"]'); input.focus();
            const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,'3000000');
            input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'3000000'})); })()`);
          await wait(40);
          await evalUi(`window.__money1cStore.setState(s=>({ currentPeriod:{...s.currentPeriod,id:'Q',isClosed:true} }))`);
          await wait(80);
          const closedDisabled = await evalUi(`document.querySelector('input[aria-label="Oklad #7"]')?.disabled`);
          const contextCanceled = Boolean(moneyDb.prepare("SELECT COUNT(*) AS n FROM local_outbox WHERE company_id=? AND command_type='UpsertWorker'").get(moneyCompany).n === outboxAfterSave
            && moneyDb.prepare("SELECT SUM(amount) AS v FROM worker_adjustments WHERE company_id=? AND worker_id=7 AND period_id='P' AND type='OKLAD'").get(moneyCompany).v === 2000000);
          if (!contextCanceled) throw Error('period change persisted a stale draft');
          await evalUi(`window.__money1cStore.setState(s=>({ currentPeriod:s.periods.find(p=>p.id==='P') }))`);
          await evalUi(`window.__money1cStore.setState(s=>({ licenseStatus:{...s.licenseStatus,companyId:''} }))`);
          await wait(80);
          const unboundDisabled = await evalUi(`!document.querySelector('input[aria-label="Oklad #7"]') || document.querySelector('input[aria-label="Oklad #7"]').disabled`);
          await evalUi(`window.renderMoney1cApp(${JSON.stringify(moneyCompany)})`);
          await waitFor(() => evalUi(`Boolean(window.__money1cStore.getState().payrollValuation?.workers?.find(w=>w.workerId===7))`), 'payroll restore after unbound context');
          await evalUi(`window.__money1cAuth.setAuth({permissions:[]})`);
         await wait(80);
         const roleGuard = await evalUi(`(() => { const input=document.querySelector('input[aria-label="Oklad #7"]');
           return { exists:!!input, disabled:!input || input.disabled, permissions:window.__money1cPermissions() }; })()`);
         const unauthorizedDisabled = roleGuard.disabled;
         await evalUi(`window.__money1cAuth.setAuth({status:'active',role:'admin',companyId:${JSON.stringify(moneyCompany)},permissions:window.__money1cAdminPermissions})`);
         await evalUi(`window.__money1cStore.setState(s=>({ licenseStatus:{...s.licenseStatus,companyId:'other-company'} }))`);
         await wait(80);
          const wrongCompanyDisabled = await evalUi(`document.querySelector('input[aria-label="Oklad #7"]')?.disabled`);
          await evalUi(`window.renderMoney1cApp(${JSON.stringify(moneyCompany)})`);
           await waitFor(() => evalUi(`Boolean(window.__money1cStore.getState().activeSheet==='Umumiy'
             && document.querySelector('.umumiy-report tbody tr.fast-row')?.textContent.includes('Worker 7'))`), 'restored company payroll view');
           await evalUi(`window.__money1cStore.setState({notifications:[]})`);
           await evalUi(`window.__money1cStore.getState().openModal({type:'worker_detail',workerId:7})`);
         await waitFor(() => evalUi(`Boolean(document.querySelector('.phase-c-worker-detail'))`), 'WorkerDetail modal');
         await wait(500);
         const detailCards = await evalUi(`([...document.querySelectorAll('.e3-detail-stats .kpi-card')].map(card=>card.textContent.replace(/\\s+/g,' ').trim()))`);
          const detailShot = path.join(screenshots, `worker-detail-1440-${process.pid}.png`);
          fsSync.writeFileSync(detailShot, (await window.webContents.capturePage()).toPNG());
          if (!closedDisabled || !unboundDisabled || !unauthorizedDisabled || !wrongCompanyDisabled || !detailCards.some(text=>text.includes('500 000'))
           || !detailCards.some(text=>text.includes('2 000 000')) || !detailCards.some(text=>text.includes('2 500 000'))
           || !detailCards.some(text=>text.includes('100 000')) || !detailCards.some(text=>text.includes('2 125 000')))
            throw Error('money 1c role/context/detail card evidence '+JSON.stringify({closedDisabled,unboundDisabled,contextCanceled,unauthorizedDisabled,wrongCompanyDisabled,detailCards}));
         await evalUi(`document.querySelector('.phase-c-worker-detail button')?.click()`);
         await wait(50);
         await evalUi(`window.__money1cStore.getState().openModal({type:'worker_detail',workerId:7})`);
         await wait(80);
         await evalUi(`([...document.querySelectorAll('.phase-c-worker-detail button')].find(button=>button.textContent.includes('Excelga eksport'))?.click())`);
          const csvText = await evalUi('window.readMoney1cCsv()');
          const normalizedCsv = String(csvText).replace(/[\s\u00a0\u202f]+/g, ' ');
          for (const [label, expected] of [['Piecework ish haqi', '500 000'], ['Oklad', '2 000 000'],
            ['Jami ish haqi', '2 500 000'], ['Magazin', '100 000'], ['Davr bo‘yicha sof qoldiq', '2 125 000']]) {
            if (!normalizedCsv.includes(label) || !normalizedCsv.includes(expected)) throw Error(`CSV missing ${label}/${expected}: ${normalizedCsv.slice(0,600)}`);
          }
          const csvSummary = parseCsv(csvText).map(row => String(row[0] || '').replace(/^\uFEFF/, ''));
          const csvAmounts = Object.fromEntries([
            ['piecework', 'Piecework ish haqi:'], ['oklad', 'Oklad (piecework ustiga qo‘shilgan):'],
            ['gross', 'Jami ish haqi (piecework + Oklad):'], ['magazin', 'Magazin (sof to‘lovdan ayriladi):'],
            ['avans', 'Avans:'], ['jarima', 'Jarima:'], ['staj', 'Staj:'], ['net', 'Davr bo‘yicha sof qoldiq:']
          ].map(([key, label]) => {
            const line = csvSummary.find(item => item.startsWith(label));
            if (!line) throw Error('Missing WorkerDetail CSV component '+label);
            const digits = line.slice(label.length).replace(/[^\d-]/g, '');
            return [key, Number(digits)];
          }));
          if (JSON.stringify(csvAmounts) !== JSON.stringify({ piecework:500000, oklad:2000000, gross:2500000,
            magazin:100000, avans:200000, jarima:50000, staj:25000, net:2125000 }))
            throw Error('WorkerDetail CSV numeric components disagree '+JSON.stringify(csvAmounts));
          await evalUi(`window.__money1cStore.setState({payrollValuation:{companyId:${JSON.stringify(moneyCompany)},period:null,workers:[],
            accountingStatus:'UNAVAILABLE',accountingReasons:['PAYROLL_VALUATION_UNAVAILABLE'],syncStatus:'UNKNOWN'}})`);
          await wait(100);
          await evalUi(`([...document.querySelectorAll('.phase-c-worker-detail button')].find(button=>button.textContent.includes('Excelga eksport'))?.click())`);
          const unavailableCsv = String(await evalUi('window.readMoney1cCsv()'));
          const normalizedUnavailableCsv = unavailableCsv.replace(/[\s\u00a0\u202f]+/g, ' ');
          if (!normalizedUnavailableCsv.includes('Piecework ish haqi: Noma’lum')
            || !normalizedUnavailableCsv.includes('Oklad (piecework ustiga qo‘shilgan): Noma’lum')
            || !normalizedUnavailableCsv.includes('Davr bo‘yicha sof qoldiq: Noma’lum'))
            throw Error('unavailable WorkerDetail CSV leaked a stale worker balance');
          const unavailableBase64 = await evalUi('window.exportMoney1cUnavailableXlsx()');
          const unavailablePath = path.join(fixtureRoot, `money-1c-unavailable-${process.pid}.xlsx`);
          fsSync.writeFileSync(unavailablePath, Buffer.from(unavailableBase64, 'base64'));
          try {
            const XLSX = require('xlsx-js-style');
            const workbook = XLSX.readFile(unavailablePath);
            const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Umumiy, { header:1, defval:'' });
            const headerIndex = rows.findIndex(row => row.includes('Jami ish haqi (ish + Oklad)'));
            const header = rows[headerIndex];
            const workerRow = rows.slice(headerIndex + 1).find(row => Number(row[0]) === 7);
            const unknownValues = ['Соф фойда','Стаж','Аванс','Jarima','Jami ish haqi (ish + Oklad)','Oklad','Magazin']
              .map(name => workerRow?.[header.indexOf(name)]);
            if (unknownValues.some(value => value !== 'Noma’lum')) throw Error('unavailable XLSX exported non-unknown values '+JSON.stringify(unknownValues));
          } finally { fsSync.unlinkSync(unavailablePath); }
          await evalUi(`window.renderMoney1cApp(${JSON.stringify(moneyCompany)})`);
          await waitFor(() => evalUi(`Boolean(window.__money1cStore.getState().payrollValuation?.workers?.find(w=>w.workerId===7))`), 'payroll restore after unavailable export');

          // The actual SQLite file survives a close/reopen and feeds the production XLSX builder.
         manager.closeCompanyDatabase(moneyCompany);
         moneyDb = manager.getCompanyDatabase(fixtureRoot, moneyCompany);
         projection = readWorkbookPayrollProjection(moneyDb, moneyCompany);
         payroll = projection.payrollValuation.workers.find(item => Number(item.workerId) === 7);
         if (payroll?.gross !== 2500000 || payroll?.net !== 2125000 || payroll?.pieceworkGross !== 500000)
           throw Error('money 1c restart readback '+JSON.stringify(payroll));
         await evalUi(`window.renderMoney1cApp(${JSON.stringify(moneyCompany)})`);
         const base64 = await evalUi('window.exportMoney1cXlsx()');
         const xlsxPath = path.join(fixtureRoot, `money-1c-export-${process.pid}.xlsx`);
         fsSync.writeFileSync(xlsxPath, Buffer.from(base64,'base64'));
         try {
           const XLSX = require('xlsx-js-style');
           const workbook = XLSX.readFile(xlsxPath);
           const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Umumiy, { header:1, defval:'' });
           const headerIndex = rows.findIndex(row => row.includes('Jami ish haqi (ish + Oklad)'));
           const header = rows[headerIndex];
           const workerRow = rows.slice(headerIndex + 1).find(row => Number(row[0]) === 7);
           const modelIndex = header.indexOf('Money fixture');
           const output = { header, workerRow, gross:workerRow?.[header.indexOf('Jami ish haqi (ish + Oklad)')],
             oklad:workerRow?.[header.indexOf('Oklad')], magazin:workerRow?.[header.indexOf('Magazin')],
             net:workerRow?.[header.indexOf('Соф фойда')], modelPiecework:workerRow?.[modelIndex] };
           console.log('MONEY_1C_XLSX ' + JSON.stringify(output));
           if (output.gross !== 2500000 || output.oklad !== 2000000 || output.magazin !== 100000
             || output.net !== 2125000 || output.modelPiecework !== 500000) throw Error('money 1c XLSX numeric readback');
          } finally { fsSync.unlinkSync(xlsxPath); }

          // Two different manual inputs for one worker must not race the same base revision.
          rejectNextMoneyCommand = true;
          holdNextMoneyCommand = true;
          await edit('Oklad #8', '10', 'enter');
          await waitFor(() => Boolean(releaseHeldMoneyCommand), 'held worker command');
          await edit('Magazin #8', '20', 'enter');
          if (moneyDb.prepare("SELECT COUNT(*) AS n FROM local_outbox WHERE company_id=? AND command_type='UpsertWorker'").get(moneyCompany).n !== outboxAfterSave)
            throw Error('rapid second edit persisted while first worker command pending');
          releaseHeldMoneyCommand();
          await wait(160);
          if (moneyDb.prepare("SELECT COUNT(*) AS n FROM local_outbox WHERE company_id=? AND command_type='UpsertWorker'").get(moneyCompany).n !== outboxAfterSave)
            throw Error('rejected rapid worker edit persisted');
          await evalUi(`window.renderMoney1cApp(${JSON.stringify(moneyCompany)})`);
          await waitFor(() => evalUi(`Boolean(window.__money1cStore.getState().payrollValuation?.workers?.find(w=>w.workerId===7))`), 'payroll restore after rapid edit rejection');

         await evalUi(`(() => { const s=window.__money1cStore.getState(); if(s.theme!=='dark') s.toggleTheme(); return true; })()`);
         window.setSize(760, 900);
         await waitFor(() => evalUi(`Boolean(document.querySelector('.umumiy-report'))`), 'narrow Umumiy');
         await evalUi(`(() => { const sc=document.querySelector('.umumiy-table-scroll'); sc.scrollTop=34*58;
           sc.scrollLeft=sc.scrollWidth; sc.dispatchEvent(new Event('scroll')); return true; })()`);
         await wait(350);
         const narrow = await evalUi(`(() => { const sc=document.querySelector('.umumiy-table-scroll'); const input=document.querySelector('input[aria-label="Magazin #41"]');
           if(!input) return {last:false,scrollWidth:sc.scrollWidth,clientWidth:sc.clientWidth};
           input.scrollIntoView({block:'nearest',inline:'center'}); input.focus({preventScroll:true});
            const rect=input.getBoundingClientRect(); const name=input.closest('tr')?.cells[1];
            const header=document.querySelector('.umumiy-report thead th:nth-child(2)');
            return {last:true,scrollWidth:sc.scrollWidth,clientWidth:sc.clientWidth,focused:document.activeElement===input,
              inputLeft:rect.left,inputRight:rect.right,inputTop:rect.top,inputBottom:rect.bottom,
              nameLeft:name?.getBoundingClientRect().left,headerNameLeft:header?.getBoundingClientRect().left,
              rowHeight:input.closest('tr')?.getBoundingClientRect().height,scrollLeft:sc.scrollLeft}; })()`);
         await evalUi(`window.__money1cStore.setState({notifications:[]})`);
         await wait(80);
          const narrowShot = path.join(screenshots, `umumiy-760-last-worker-${process.pid}.png`);
          fsSync.writeFileSync(narrowShot, (await window.webContents.capturePage()).toPNG());
          if (!narrow.last || narrow.scrollWidth <= narrow.clientWidth || !narrow.focused
            || narrow.inputLeft < narrow.nameLeft || narrow.inputRight > 760 || narrow.inputBottom < 0 || narrow.inputTop > 900
            || Math.abs(narrow.nameLeft - narrow.headerNameLeft) > 1 || Math.abs(narrow.rowHeight - 58) > 1)
           throw Error('money 1c narrow last virtual worker/focus '+JSON.stringify(narrow));
         await evalUi(`(() => { const input=document.querySelector('input[aria-label="Magazin #41"]');
           const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,'55');
            input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'55'}));
            input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); })()`);
         await wait(80);
         if (moneyDb.prepare("SELECT COUNT(*) AS n FROM local_outbox WHERE company_id=? AND command_type='UpsertWorker'").get(moneyCompany).n !== outboxAfterSave)
           throw Error('virtual worker Escape draft wrote a command');
          console.log('MONEY_1C_APP_PASS ' + JSON.stringify({ setup, outboxAfterSave, adjustmentCountAfterSave,
            gross:payroll.gross, net:payroll.net, pieceworkGross:payroll.pieceworkGross,
             csvAmounts, xlsx:'verified', rapidSameWorker:'rejected-without-extra-facts', narrow,
             screenshots:{ afterShot, detailShot, narrowShot } }));
         return;
       }
        if (process.env.VISUAL_EXISTING_ONLY === '1' || process.env.VISUAL_REFERENCE_FIX_ONLY === '1') { await runVisualExisting(); return; }
        if (process.env.REDESIGN_E5A_ONLY === '1') {
        const setup = await window.webContents.executeJavaScript('window.renderE5App()');
        window.showInactive();
        if (process.env.REDESIGN_E5_ESCAPE_ONLY === '1') {
          const escapeEvidence = await window.webContents.executeJavaScript(`(async () => {
            const wait = (ms=120) => new Promise(resolve => setTimeout(resolve,ms));
            const state = window.__store.getState;
            const key = (target,label='target') => { if (!target) throw Error('missing Escape target '+label+'; modal='+!!manager()+' text='+manager()?.textContent.slice(0,120)); const event=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}); target.dispatchEvent(event); return event.defaultPrevented; };
            const manager = () => document.querySelector('.phase-c-worker-manager');
            state().openModal({type:'worker_manager'}); await wait(650);
            if (!manager()) throw Error('worker manager did not mount');
            const edit = [...manager().querySelectorAll('button[title="Tahrirlash"]')][0];
            edit.click(); await wait();
            const staj = manager().querySelector('input[placeholder="Staj..."]');
            key(staj,'staj'); await wait();
            const stajCancel = { modalOpen:!!manager(), editing:!!manager()?.querySelector('input[placeholder="Staj..."]'), focusRestored:document.activeElement?.title==='Tahrirlash' };
            const editAgain = [...manager().querySelectorAll('button[title="Tahrirlash"]')][0];
            editAgain.click(); await wait();
            const name = manager().querySelector('.e3-manager-table tbody tr input[type="text"]');
            key(name,'name'); await wait();
            const nameCancel = { modalOpen:!!manager(), editing:!!manager()?.querySelector('.e3-manager-table tbody tr input[type="text"]'), focusRestored:document.activeElement?.title==='Tahrirlash' };
            const thirdEdit = [...manager().querySelectorAll('button[title="Tahrirlash"]')][0];
            thirdEdit.click(); await wait();
            key(manager()?.querySelector('input[placeholder="Staj..."]'),'second staj'); await wait();
            key(window); await wait();
            const nextEscapeClose = !manager();

            state().openModal({type:'worker_manager'}); await wait(650); key(window); await wait();
            const ordinaryClose = !manager();
            state().openModal({type:'new_model'}); await wait(400);
            key(document.querySelector('.modal-overlay input[placeholder*="Hudi"]')); await wait();
            const ordinaryInputEscape = !document.querySelector('.modal-overlay');

            state().setAvailableUpdate({version:'99.0.0',releaseNotes:'LOCAL STUB',downloadUrl:'https://invalid.local/no-network'});
            state().openModal({type:'app_update'}); await wait(400);
            key(document.querySelector('.modal-overlay button')); await wait();
            const ordinaryUpdateEscape = !document.querySelector('.modal-overlay');
            state().openModal({type:'app_update'}); await wait(400);
            [...document.querySelectorAll('.modal-overlay button')].find(button=>button.textContent.includes('Hozir Yangilash')).click();
            await wait(180);
            const updateStarted = document.body.textContent.includes('Yuklanmoqda...');
            const busyPrevented=key(document.querySelector('.modal-overlay button')); await wait();
            const busyEscapeGuard = { modalOpen:!!document.querySelector('.modal-overlay'), updateStarted, busyPrevented, modalType:state().modalState.type };
            window.__escapeConfirmResult = undefined;
            state().confirmAction({title:'Local confirmation',message:'Cancel only',isDanger:false}).then(result=>window.__escapeConfirmResult=result);
            await wait();
            const confirmWasOpen=!!document.querySelector('.phase-c-confirm-overlay');
            key(document.querySelector('.phase-c-confirm-overlay button')); await wait();
            const confirmationPriority = { confirmWasOpen, confirmOpen:!!document.querySelector('.phase-c-confirm-overlay'), confirmResult:window.__escapeConfirmResult,
              updateOpen:!!document.querySelector('.modal-overlay') };
            const outside = performance.getEntriesByType('resource').filter(item=>{try { const u=new URL(item.name); return !['file:','devtools:'].includes(u.protocol)&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname); } catch { return false; }}).map(item=>item.name);
            return { stajCancel,nameCancel,nextEscapeClose,ordinaryClose,ordinaryInputEscape,ordinaryUpdateEscape,busyEscapeGuard,confirmationPriority,outside };
          })()`);
          console.log('LOCAL_E5_ESCAPE_APP ' + JSON.stringify(escapeEvidence));
          if (!escapeEvidence.stajCancel.modalOpen || escapeEvidence.stajCancel.editing || !escapeEvidence.stajCancel.focusRestored
            || !escapeEvidence.nameCancel.modalOpen || escapeEvidence.nameCancel.editing || !escapeEvidence.nameCancel.focusRestored
            || !escapeEvidence.nextEscapeClose || !escapeEvidence.ordinaryClose || !escapeEvidence.ordinaryInputEscape
            || !escapeEvidence.ordinaryUpdateEscape || !escapeEvidence.busyEscapeGuard.modalOpen || !escapeEvidence.busyEscapeGuard.updateStarted
            || !escapeEvidence.confirmationPriority.confirmWasOpen || escapeEvidence.confirmationPriority.confirmOpen
            || escapeEvidence.confirmationPriority.confirmResult !== false || !escapeEvidence.confirmationPriority.updateOpen
            || escapeEvidence.outside.length) throw Error('E5 modal Escape acceptance '+JSON.stringify(escapeEvidence));
          return;
        }
        const e5Dir = path.join(root, '.opencode/deep-audit/output/redesign-phase-e5a-screenshots');
        fsSync.mkdirSync(e5Dir, { recursive: true });
        await new Promise(resolve => setTimeout(resolve, 350));
        fsSync.writeFileSync(path.join(e5Dir, 'app-umumiy-desktop.png'), (await window.webContents.capturePage()).toPNG());
        const evidence = await window.webContents.executeJavaScript(`(async () => {
          const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
          await pause(350);
          const store = window.__workbookStoreRef || window.__store;
          const state = () => store.getState();
          const sheet = name => { state().setActiveSheet(name); return pause(160); };
          const key = (name, ctrl = false) => window.dispatchEvent(new KeyboardEvent('keydown', { key: name, ctrlKey: ctrl, bubbles: true }));
          const assert = (condition, label) => { if (!condition) throw Error('E5A ' + label); };
          const css = el => { if (!el) throw Error('E5A missing style target ' + state().activeSheet); const s = getComputedStyle(el); return { font:s.fontFamily, fg:s.color, bg:s.backgroundColor, disabled:!!el.disabled }; };
          const rgb = value => (value.match(/[\\d.]+/g) || []).slice(0,3).map(Number);
          const luminance = rgb => { const channels = rgb.map(n => { const v=n/255; return v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4; }); return .2126*channels[0]+.7152*channels[1]+.0722*channels[2]; };
          const ratio = (fg,bg) => { const a=luminance(rgb(fg)), b=luminance(rgb(bg)); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05); };
          assert(document.querySelector('.umumiy-report')?.textContent.includes('≈ 84') && document.querySelector('.umumiy-report')?.textContent.includes('≈ 76'), 'financial report');
          const save = [...document.querySelectorAll('.excel-titlebar button')].find(el => el.textContent.trim()==='Saqlash');
          const license = [...document.querySelectorAll('.excel-title-right > div')].find(el => el.textContent.includes('Sinov:'));
          const title = document.querySelector('.excel-titlebar');
          const shell = { title:css(title), save:css(save), license:css(license),
            saveContrast:ratio(css(save).fg,css(save).bg), licenseContrast:ratio(css(license).fg,css(title).bg),
            licenseText:license?.textContent.trim(), bodyFont:css(document.body).font };
          assert(shell.saveContrast >= 4.5 && shell.licenseContrast >= 4.5 && !document.body.textContent.includes('Litsenziya: undefined'), 'titlebar contrast/license');
          key('b',true); await pause(); assert(document.querySelector('.excel-sidebar.open'), 'Ctrl+B drawer');
          key('Escape'); await pause(); assert(!document.querySelector('.excel-sidebar.open'), 'global Escape drawer');
          const model = state().models[0];
          await sheet(model.hisobSheetName);
          const scroll = document.querySelector('.excel-table')?.parentElement;
          const row = document.querySelector('tbody tr.fast-row');
          const grid = { columns:document.querySelectorAll('.phase-b-hisob col').length, font:css(row?.cells[1]),
            headerFont:css(document.querySelector('.phase-b-hisob thead td')), scrollWidth:scroll?.scrollWidth, clientWidth:scroll?.clientWidth,
            qty:row?.querySelector('input[title*="Ish sonini"]')?.value, text:document.querySelector('.phase-b-hisob')?.textContent.includes('≈ 84') };
          assert(grid.qty === '12' && grid.text && grid.scrollWidth > grid.clientWidth, 'Hisob geometry and amount '+JSON.stringify(grid));
          const input = row.querySelector('input[title*="Ish sonini"]');
          input.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
          setter.call(input,'15'); input.dispatchEvent(new Event('input',{ bubbles:true })); await pause();
          const edit = { focused:document.activeElement===input, draft:input.value };
          key('Escape'); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await pause();
          edit.restored = row.querySelector('input[title*="Ish sonini"]')?.value;
          assert(edit.focused && edit.draft==='15' && edit.restored==='12', 'draft Escape');
          await sheet('Patta');
          const before = state().pattaBatchConfigs[model.id];
          const batchInput = document.querySelector('.e2b-batch-card .e2b-batch-work input');
          setter.call(batchInput,'23'); batchInput.dispatchEvent(new Event('input',{bubbles:true})); await pause();
          await sheet('Umumiy'); await sheet('Patta');
          const draftNavigation = { before:before?.totalIshSoni, after:state().pattaBatchConfigs[model.id]?.totalIshSoni,
            shown:document.querySelector('.e2b-batch-card .e2b-batch-work input')?.value==='23' };
          assert(draftNavigation.after==='23' && draftNavigation.shown, 'local draft navigation '+JSON.stringify(draftNavigation));
          await sheet('Umumiy'); window.e5Role('type'); await pause();
          const role = { typeDenied:!!document.querySelector('main')?.textContent.includes('ruxsat'), typeReport:!!document.querySelector('.umumiy-report') };
          await sheet(model.hisobSheetName); role.typeHisob=!!document.querySelector('.phase-b-hisob');
          window.e5Role('print'); await pause(); role.printDenied=!!document.querySelector('main')?.textContent.includes('ruxsat');
          await sheet('Patta'); role.printBatch=!!document.querySelector('.phase-b-batch');
          window.e5Role('admin'); await pause(); role.adminBatch=!!document.querySelector('.phase-b-batch');
          role.blockedPermissions=window.e5InvalidLicense(); await pause(); role.blockedBatch=!!document.querySelector('.phase-b-batch');
          assert(role.typeReport && role.typeHisob && role.printDenied && role.printBatch && role.adminBatch && !role.blockedPermissions.length && !role.blockedBatch, 'RBAC '+JSON.stringify(role));
          await window.renderE5App(); await pause(200);
          await sheet('Umumiy');
          const period = window.e5Context('hisob_test_browser','wrong-period'); await pause();
          const context = { periodGross:period.workers?.[0]?.gross, unknown:document.querySelector('.umumiy-report')?.textContent.includes('Noma’lum') };
          const switched = window.e5Context('wrong-company','wrong-period'); await pause();
          context.companyStatus=switched.accountingStatus;
          assert(context.periodGross===84 && context.unknown && context.companyStatus==='UNAVAILABLE' && !document.querySelector('.umumiy-report')?.textContent.includes('≈ 76'), 'context money guard');
          return { shell, grid, edit, draftNavigation, role, context };
        })()`);
        await window.webContents.executeJavaScript('window.renderE5App()');
        const followup = await window.webContents.executeJavaScript(`(async () => {
          const wait = (ms=150) => new Promise(resolve => setTimeout(resolve,ms));
          const state = () => window.__store.getState();
          const model = state().models[0];
          state().setActiveSheet(model.hisobSheetName); await wait(350);
          const scroll = document.querySelector('.excel-table')?.parentElement;
          scroll.scrollTop = scroll.scrollHeight; scroll.scrollLeft = scroll.scrollWidth;
          scroll.dispatchEvent(new Event('scroll')); await wait(350);
          const last = [...document.querySelectorAll('tbody tr.fast-row')].some(row => row.cells[0]?.textContent.trim()==='1220');
          const grid = { last, workerCount:state().workers.length, operations:model.operations.length,
            scrollTop:scroll.scrollTop, scrollLeft:scroll.scrollLeft, scrollWidth:scroll.scrollWidth,
            selectedRows:document.querySelectorAll('tbody tr.fast-row').length };
          if (!last || grid.workerCount!==222 || grid.operations!==15 || !grid.scrollLeft) throw Error('E5A virtual bottom '+JSON.stringify(grid));
          state().setActiveSheet('Umumiy'); await wait(200);
          document.querySelector('button[title="Oylik davrini boshqarish va oyni yopish"]')?.click(); await wait(350);
          const modal = document.querySelector('.modal-overlay');
          const focusable = [...modal.querySelectorAll('button,input,select')].filter(el => !el.disabled);
          focusable[0]?.focus();
          const focus = { opened:!!modal, inside:modal.contains(document.activeElement), controls:focusable.length };
          const exit = [...modal.querySelectorAll('button')].find(el => el.textContent.includes('Chiqish'));
          exit?.click(); await wait(); focus.closed=!document.querySelector('.modal-overlay');
          state().openModal({type:'new_model'}); await wait(300);
          const nameInput=document.querySelector('.modal-overlay input[placeholder*="Hudi"]');
          focus.modelAutofocus=document.activeElement===nameInput;
          nameInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await wait();
          focus.modelEscape=!document.querySelector('.modal-overlay');
          if (!focus.opened || !focus.inside || !focus.closed || !focus.modelAutofocus || !focus.modelEscape) throw Error('E5A modal focus/close '+JSON.stringify(focus));
          return { grid, focus, outside:performance.getEntriesByType('resource').filter(item => {try { const u=new URL(item.name); return u.protocol!=='file:' && !['127.0.0.1','localhost'].includes(u.hostname); } catch { return false; }}).map(item=>item.name) };
        })()`);
        if (followup.outside.length) throw Error('E5A external resource ' + JSON.stringify(followup.outside));
        window.setContentSize(700,900);
        await window.webContents.executeJavaScript(`window.__store.setState({notifications:[]}); if (window.__store.getState().theme !== 'dark') window.__store.getState().toggleTheme(); else document.documentElement.setAttribute('data-theme','dark'); new Promise(resolve => setTimeout(resolve,300))`);
        const narrow = await window.webContents.executeJavaScript(`(() => {
          const report=document.querySelector('.umumiy-report'); const s=getComputedStyle(report);
          return { width:innerWidth, theme:document.documentElement.getAttribute('data-theme'), reportFont:s.fontFamily,
            reportVisible:!!report && report.getBoundingClientRect().width>0,
            gross:report?.textContent.includes('≈ 84'), provisional:report?.textContent.includes('Taxminiy'),
            titleWidth:document.querySelector('.excel-titlebar').getBoundingClientRect().width };
        })()`);
        if (narrow.width!==700 || narrow.theme!=='dark' || !narrow.reportVisible || !narrow.gross || !narrow.provisional) throw Error('E5A narrow '+JSON.stringify(narrow));
        fsSync.writeFileSync(path.join(e5Dir, 'app-umumiy-narrow-dark.png'), (await window.webContents.capturePage()).toPNG());
        const darkGrid = await window.webContents.executeJavaScript(`(async () => {
          const state=window.__store.getState(); state.setActiveSheet(state.models[0].hisobSheetName);
          await new Promise(resolve => setTimeout(resolve,400));
          const root=document.querySelector('.phase-b-hisob'); const scroll=root.querySelector('.excel-table').parentElement;
          return { theme:document.documentElement.getAttribute('data-theme'), width:innerWidth,
            operations:state.models[0].operations.length, horizontal:scroll.scrollWidth>scroll.clientWidth,
            qty:root.querySelector('tbody tr.fast-row input[title*="Ish sonini"]')?.value,
            font:getComputedStyle(root.querySelector('tbody tr.fast-row td')).fontFamily };
        })()`);
        if (darkGrid.theme!=='dark' || !darkGrid.horizontal || darkGrid.qty!=='12') throw Error('E5A dark grid '+JSON.stringify(darkGrid));
        fsSync.writeFileSync(path.join(e5Dir, 'app-hisob-narrow-dark.png'), (await window.webContents.capturePage()).toPNG());
        const idleBefore = fixtureDbReads;
        await new Promise(resolve => setTimeout(resolve, 15200));
        const idleAfter = fixtureDbReads;
        if (idleAfter !== idleBefore) throw Error('E5A idle SQLite reload '+JSON.stringify({idleBefore,idleAfter}));
        console.log('LOCAL_E5A_APP ' + JSON.stringify({ setup, evidence, followup, narrow, darkGrid, idleDbReads:[idleBefore,idleAfter], screenshots:e5Dir }));
        return;
      }
      const phaseA = await window.webContents.executeJavaScript(`(async () => {
        const title = document.querySelector('.excel-titlebar');
        const report = document.querySelectorAll('.excel-grid-container')[1];
        const toolbar = report?.querySelector('input[placeholder*="Ishchi qidirish"]');
        const before = { titlebar: !!title, periodAction: [...(title?.querySelectorAll('button') || [])].some(b => b.textContent.includes('P')),
          searchToolbar: !!toolbar, palette: getComputedStyle(document.body).backgroundColor,
          header: getComputedStyle(title).backgroundColor };
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 30));
        const sidebarOpened = document.querySelector('.excel-sidebar')?.classList.contains('open');
        const nav = [...document.querySelectorAll('.excel-sidebar-item')].find(b => b.textContent.includes('Umumiy Hisobot'));
        nav?.click();
        await new Promise(resolve => setTimeout(resolve, 30));
        return { ...before, sidebarOpened,
          reportNavigation: !!nav, reportActive: nav?.classList.contains('active') };
      })()`);
      console.log('LOCAL_PHASE_A_RENDER ' + JSON.stringify(phaseA));
      if (!phaseA.titlebar || !phaseA.periodAction || !phaseA.searchToolbar || !phaseA.sidebarOpened ||
        !phaseA.reportNavigation || !phaseA.reportActive) process.exitCode = 1;
      if (process.env.REDESIGN_E2B_ONLY === '1') {
        const dir = process.env.PATTA_FOCUS_ONLY === '1'
          ? path.join(root, '.opencode/deep-audit/output/post-redesign-patta-focus-screenshots')
          : path.join(root, '.opencode/deep-audit/output/redesign-phase-e2b-screenshots');
        fsSync.mkdirSync(dir, { recursive: true });
        window.showInactive();
        const capture = async name => fsSync.writeFileSync(path.join(dir, name), (await window.webContents.capturePage()).toPNG());
        const probe = async surface => window.webContents.executeJavaScript(`(() => {
          const root = document.querySelector('.phase-b-' + ${JSON.stringify(surface === 'batch' ? 'batch' : 'patta-entry')});
          const box = el => { const r = el?.getBoundingClientRect(); return r && { x:r.x, y:r.y, width:r.width, height:r.height }; };
          const cards = [...root.querySelectorAll('.e2b-batch-card')];
          return { viewport:[innerWidth,innerHeight], theme:document.documentElement.getAttribute('data-theme'),
            heading:box(root.querySelector('h1') || root.querySelector('.e2b-entry-title')),
            card:box(root.querySelector('.e2b-entry-card')),
            cards:cards.map(box), sizeCells:root.querySelectorAll('.e2b-batch-card:first-child .e2b-size-cell').length,
            work:root.querySelector('.e2b-batch-work input')?.value, count:root.querySelector('.e2b-batch-count')?.textContent,
            opRows:root.querySelectorAll('.e2b-entry-op').length, completed:root.querySelectorAll('.e2b-entry-op.is-complete').length,
            entered:root.querySelector('.e2b-entry-table input[type=number]:not(:disabled)')?.value,
            scrollWidth:root.scrollWidth, clientWidth:root.clientWidth,
            outside:performance.getEntriesByType('resource').filter(item => { try { const u = new URL(item.name); return u.protocol !== 'file:' && !['127.0.0.1','localhost'].includes(u.hostname); } catch { return false; } }).length };
        })()`);
        const results = {};
        for (const surface of ['batch', 'entry']) {
          await window.webContents.executeJavaScript(`window.renderE2B(${JSON.stringify(surface)})`);
         window.setContentSize(1920, 1000);
          await new Promise(resolve => setTimeout(resolve, 200));
          results[surface] = { desktop: await probe(surface) }; await capture(`${surface}-desktop-1440.png`);
          results[surface].actions = await window.webContents.executeJavaScript(`(async () => {
            const wait = () => new Promise(resolve => setTimeout(resolve, 80));
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            if (${JSON.stringify(surface)} === 'batch') {
              const toggle = [...document.querySelectorAll('[aria-label="Razmer turi"] button')].find(b => b.textContent.includes('Raqamli'));
              toggle.click(); await wait(); const switched = toggle.getAttribute('aria-pressed') === 'true';
              const numeric = document.querySelector('.e2b-batch-card:first-child .e2b-size-cell')?.textContent;
              const back = [...document.querySelectorAll('[aria-label="Razmer turi"] button')].find(b => b.textContent.includes('Harfli'));
              back.click(); await wait(); const preserved = document.querySelector('.e2b-batch-card:first-child input[value="3"]')?.value === '3';
              const missing = document.querySelector('.e2b-batch-card:nth-child(2) .e2b-size-cell input');
              setter.call(missing, '2'); missing.dispatchEvent(new Event('input',{ bubbles:true })); await wait();
              const count = document.querySelector('.e2b-batch-toolbar')?.textContent;
              const print = [...document.querySelectorAll('.e2b-batch-toolbar button')].find(b => b.textContent.includes('Ish sonini kiriting'));
              print?.click(); await wait();
              return { switched, numeric, preserved, count, missingFocused:document.activeElement === document.querySelector('.e2b-batch-card:nth-child(2) .e2b-batch-work input'),
                printDialogAbsent:!document.querySelector('.phase-c-print-preview') };
            }
            const root = document.querySelector('.phase-b-patta-entry');
            const conveyor = root.querySelector('.e2b-entry-meta input[type=text]');
            conveyor.focus(); conveyor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); await wait();
            const partyInput = root.querySelectorAll('.e2b-entry-meta input[type=text]')[1];
            const keyboardNext = document.activeElement === partyInput;
            const first = root.querySelector('.e2b-entry-op input');
            first.focus(); setter.call(first,'999'); first.dispatchEvent(new Event('input',{ bubbles:true })); await wait();
            const invalid = root.textContent.includes('Ishchi topilmadi! (999)');
            setter.call(first,'7'); first.dispatchEvent(new Event('input',{ bubbles:true })); await wait();
            const restored = root.querySelector('.e2b-entry-op.is-complete')?.textContent.includes('Demo worker');
            const add = [...root.querySelectorAll('button')].find(b => b.textContent.includes("Operatsiya qo'shish"));
            add.click(); await wait(); const inline = !!root.querySelector('input[placeholder="Operatsiya nomini yozing..."]');
            const close = [...root.querySelectorAll('button')].find(b => b.textContent.includes('Saqlash'))?.nextElementSibling;
            close?.click(); await wait();
            const sendButton = [...root.querySelectorAll('button')].find(b => b.textContent.includes('Jo'));
            const validParty = window.__store.getState().ticketForms[window.__store.getState().models[0].id].party;
            const modelId = window.__store.getState().models[0].id;
            window.__store.setState(state => ({ ticketForms: { ...state.ticketForms,
              [modelId]: { ...state.ticketForms[modelId], party: '999' } } })); await wait();
            sendButton.focus(); sendButton.click(); await wait();
            const invalidSubmitRetainedFocus = document.activeElement === sendButton;
            const validationErrorShown = window.__store.getState().notifications.some(n => n.title === 'Chop etilmagan partiya');
            window.__store.setState(state => ({ ticketForms: { ...state.ticketForms,
              [modelId]: { ...state.ticketForms[modelId], party: validParty } }, jonatish: () => Promise.resolve(true) })); await wait();
            const operation = root.querySelector('.e2b-entry-op input');
            operation.focus(); operation.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
            await new Promise(resolve => setTimeout(resolve, 120));
            const validSubmitFocusedKonveyer = document.activeElement === root.querySelector('[data-patta-konveyer-input="true"]');
            return { keyboardNext, invalid, restored, inline, canceled:!root.querySelector('input[placeholder="Operatsiya nomini yozing..."]'),
              party:partyInput?.value, invalidSubmitRetainedFocus, validationErrorShown, validSubmitFocusedKonveyer };
          })()`);
          window.setContentSize(700, 900);
          await window.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme','dark'); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
          await new Promise(resolve => setTimeout(resolve, 120));
          results[surface].narrow = await probe(surface); await capture(`${surface}-narrow-dark-700.png`);
          if (surface === 'batch') {
            results.batch.navigation = await window.webContents.executeJavaScript(`(async () => {
              const model = [...document.querySelectorAll('.excel-sidebar-item')].find(el => el.textContent.includes('Demo'));
              model?.click(); await new Promise(resolve => setTimeout(resolve, 80));
              const entered = !!document.querySelector('.phase-b-patta-entry');
              const batch = [...document.querySelectorAll('.excel-sidebar-item')].find(el => el.textContent.includes('Patta (Chiqarish)'));
              batch?.click(); await new Promise(resolve => setTimeout(resolve, 80));
              return { modelFound:!!model, entered, batchFound:!!batch, returned:!!document.querySelector('.phase-b-batch') };
            })()`);
          }
          await window.webContents.executeJavaScript(`document.documentElement.removeAttribute('data-theme')`);
        }
        console.log('LOCAL_E2B_RENDER ' + JSON.stringify({ results, screenshots:dir }));
        if (process.env.PATTA_FOCUS_ONLY === '1') {
          fsSync.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify({ scope: 'synthetic fixture; local rendered production PattaView', results }, null, 2));
        }
        if (results.batch.desktop.cards.length !== 3 || results.batch.desktop.work !== '4' || !results.batch.desktop.count.includes('3 ta')
          || !results.batch.actions.switched || !results.batch.actions.preserved || !results.batch.actions.count.includes('5 ta')
          || !results.batch.actions.missingFocused || !results.batch.actions.printDialogAbsent
          || !results.batch.navigation.modelFound || !results.batch.navigation.entered || !results.batch.navigation.batchFound || !results.batch.navigation.returned
           || results.entry.desktop.opRows !== 1 || results.entry.desktop.completed !== 1 || !results.entry.actions.invalid
           || !results.entry.actions.restored || !results.entry.actions.inline || !results.entry.actions.canceled || !results.entry.actions.keyboardNext
           || !results.entry.actions.invalidSubmitRetainedFocus || !results.entry.actions.validationErrorShown || !results.entry.actions.validSubmitFocusedKonveyer
          || results.batch.narrow.cards[0].width > 700 || results.entry.narrow.card.width > 700
          || results.batch.desktop.outside || results.entry.desktop.outside) process.exitCode = 1;
        return;
      }
       if (process.env.REDESIGN_E2C_ONLY === '1') {
         const dir = path.join(root, '.opencode/deep-audit/output/redesign-phase-e2c-screenshots');
         fsSync.mkdirSync(dir, { recursive: true });
         window.showInactive();
         const capture = async name => fsSync.writeFileSync(path.join(dir, name), (await window.webContents.capturePage()).toPNG());
         const probe = async surface => window.webContents.executeJavaScript(`(() => {
           const root = document.querySelector('.phase-b-' + ${JSON.stringify(surface === 'hisob' ? 'hisob' : 'konveyer')});
           const scroller = root.querySelector(${JSON.stringify(surface === 'hisob' ? '.e2c-hisob-grid' : '.e2c-conveyor-scroll')});
           const scroll = ${JSON.stringify(surface === 'hisob')} ? scroller?.parentElement : scroller;
           const box = el => { const r = el?.getBoundingClientRect(); return r && {x:r.x,y:r.y,width:r.width,height:r.height}; };
           return { viewport:[innerWidth,innerHeight], theme:document.documentElement.getAttribute('data-theme'),
             heading:box(root.querySelector('h2') || root.querySelector('.e2c-hisob-title')),
             headingFont:getComputedStyle(root.querySelector('h2') || root.querySelector('.e2c-hisob-title span')).fontSize,
             cards:[...root.querySelectorAll('.e2c-conveyor-kpis > div')].map(box),
             table:box(scroller), header:box(root.querySelector('thead tr')), row:box(root.querySelector('tbody tr.fast-row') || root.querySelector('.e2c-conveyor-matrix tbody tr')),
             widths:[...root.querySelectorAll('.e2c-hisob-grid col')].map(el => box(el)?.width),
             rowCount:root.querySelectorAll('tbody tr.fast-row').length,
             rowCells:root.querySelector('tbody tr.fast-row')?.cells.length,
             virtualBody:box(root.querySelector('tbody:first-of-type')), grid:getComputedStyle(root.querySelector('tbody tr.fast-row') || root.querySelector('thead tr')).gridTemplateColumns,
             matrixRows:root.querySelectorAll('.e2c-conveyor-matrix > tbody > tr').length,
             quantities:root.textContent.includes('12 dona'), provisional:root.textContent.includes('Taxminiy'),
             money:root.textContent.includes('≈ 84'), scrollWidth:scroll?.scrollWidth, clientWidth:scroll?.clientWidth,
             outside:performance.getEntriesByType('resource').filter(item => { try { const u = new URL(item.name); return u.protocol !== 'file:' && !['127.0.0.1','localhost'].includes(u.hostname); } catch { return false; } }).length };
         })()`);
         const results = {};
         for (const surface of ['conveyor', 'hisob']) {
           await window.webContents.executeJavaScript(`window.renderE2C(${JSON.stringify(surface)})`);
         window.setContentSize(1920, 1000);
           await window.webContents.executeJavaScript(`document.documentElement.removeAttribute('data-theme')`);
           await new Promise(resolve => setTimeout(resolve, 180));
           results[surface] = { desktop:await probe(surface) }; await capture(`${surface}-desktop-1440.png`);
           results[surface].actions = await window.webContents.executeJavaScript(`(async () => {
             const wait = () => new Promise(resolve => setTimeout(resolve, 90));
             const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
             if (${JSON.stringify(surface)} === 'conveyor') {
               const root = document.querySelector('.phase-b-konveyer');
               const matrix = root.querySelector('.e2c-conveyor-matrix');
               const initial = matrix.querySelectorAll('thead th').length;
               const modelShare = !!matrix.querySelector('[role=meter]');
               const toggle = root.querySelector('input[type=checkbox]'); toggle.click(); await wait();
               const filtered = matrix.querySelectorAll('thead th').length;
               toggle.click(); await wait();
               const search = root.querySelector('input[placeholder*="Konveyer yoki"]');
               setter.call(search,'B'); search.dispatchEvent(new Event('input',{bubbles:true})); await wait();
               const searched = matrix.querySelectorAll('tbody tr').length;
               setter.call(search,''); search.dispatchEvent(new Event('input',{bubbles:true})); await wait();
               matrix.querySelector('tbody tr')?.click(); await wait();
               const expanded = matrix.textContent.includes('topshirgan pattalar tafsiloti');
               const detail = [...root.querySelectorAll('button')].find(el => el.textContent.includes("Pattalar Ro'yxati")); detail.click(); await wait();
               return { initial, filtered, searched, expanded, detail:!!root.querySelector('input[placeholder*="Qidiruv (Partiya"]'),
                 modelShare, total:root.textContent.includes('12 dona') };
             }
             const root = document.querySelector('.phase-b-hisob');
             const scroll = root.querySelector('.e2c-hisob-grid').parentElement;
             const search = root.querySelector('input[placeholder="Ishchi qidirish..."]');
             setter.call(search,'Synthetic worker 144'); search.dispatchEvent(new Event('input',{bubbles:true})); await wait();
             const filtered = root.querySelectorAll('tbody tr.fast-row').length;
             setter.call(search,''); search.dispatchEvent(new Event('input',{bubbles:true})); await wait();
             scroll.scrollTop = scroll.scrollHeight;
             await new Promise(resolve => setTimeout(resolve, 260));
             const reachedLast = [...root.querySelectorAll('tbody tr.fast-row')].some(el => el.textContent.includes('Synthetic worker 144'));
             const bottom = { scrollTop:scroll.scrollTop, scrollHeight:scroll.scrollHeight, clientHeight:scroll.clientHeight,
               names:[...root.querySelectorAll('tbody tr.fast-row')].map(el => el.cells[1]?.textContent).slice(-4) };
             scroll.scrollTop = 0; await new Promise(resolve => setTimeout(resolve, 260));
             const input = root.querySelector('tbody tr.fast-row input[title*="Ish sonini"]');
             input.focus(); setter.call(input,'15'); input.dispatchEvent(new Event('input',{bubbles:true}));
             input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await wait();
             const canceled = input.value === '12';
             root.querySelector('tbody tr.fast-row td')?.click(); await wait();
             const selected = !!root.querySelector('.selected-row');
             window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await wait();
             return { filtered, reachedLast, bottom, canceled, selected, cleared:!root.querySelector('.selected-row'),
               quantity:input.value, total:root.textContent.includes('≈ 84') };
           })()`);
           if (surface === 'conveyor') await capture('conveyor-details-desktop-1440.png');
           if (surface === 'conveyor') await window.webContents.executeJavaScript(`(() => {
             const matrix = [...document.querySelectorAll('.phase-b-konveyer button')].find(el => el.textContent.includes('Modellar Matritsasi'));
             matrix?.click();
             document.querySelector('.e2c-conveyor-matrix tbody tr')?.click();
           })()`);
           window.setContentSize(700, 900);
           await window.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme','dark')`);
           await new Promise(resolve => setTimeout(resolve, 130));
           results[surface].narrow = await probe(surface); await capture(`${surface}-narrow-dark-700.png`);
           if (surface === 'hisob') results.hisob.horizontal = await window.webContents.executeJavaScript(`(async () => {
             const root = document.querySelector('.phase-b-hisob'); const s = root.querySelector('.e2c-hisob-grid').parentElement;
             const sample = () => { const row = root.querySelector('tbody tr.fast-row'), h = root.querySelector('thead tr');
               return { id:row?.cells[0].getBoundingClientRect().x, name:row?.cells[1].getBoundingClientRect().x,
                 headId:h?.cells[0].getBoundingClientRect().x, headName:h?.cells[1].getBoundingClientRect().x,
                 qty:row?.querySelector('input[title*="Ish sonini"]')?.value }; };
             const left = sample(); s.scrollLeft = s.scrollWidth; await new Promise(r => setTimeout(r,260));
             const right = sample(); return { left, right, scrollLeft:s.scrollLeft,
               finalHeader:root.querySelector('thead tr')?.lastElementChild?.textContent,
               finalCell:root.querySelector('tbody tr.fast-row')?.lastElementChild?.textContent,
               idDrift:Math.abs(right.id-right.headId), nameDrift:Math.abs(right.name-right.headName),
               rowHeight:root.querySelector('tbody tr.fast-row')?.getBoundingClientRect().height };
           })()`);
           if (surface === 'hisob') await capture('hisob-narrow-dark-horizontal-end-700.png');
         }
         console.log('LOCAL_E2C_RENDER ' + JSON.stringify({results,screenshots:dir}));
         const c = results.conveyor, h = results.hisob;
         if (c.desktop.cards.length !== 4 || c.desktop.header.height < 56 || c.desktop.header.height > 64 || c.desktop.row.height !== 92
           || c.actions.initial !== 6 || c.actions.filtered !== 5 || c.actions.searched !== 2 || !c.actions.expanded
           || !c.actions.detail || !c.actions.modelShare || !c.actions.total || c.narrow.cards.length !== 4 || c.narrow.matrixRows !== 3
           || h.desktop.rowCount < 1 || h.desktop.rowCount >= 46 || !h.desktop.money || !h.desktop.provisional
           || h.desktop.widths.length !== 33 || h.desktop.rowCells !== 33 || h.desktop.row.width < 4000
           || h.narrow.row.width < 4000 || h.actions.filtered !== 1 || !h.actions.reachedLast
           || !h.actions.canceled || !h.actions.selected || !h.actions.cleared || !h.actions.total
           || h.horizontal.scrollLeft < 4000 || !h.horizontal.finalHeader?.includes('Сумма')
           || !h.horizontal.finalCell?.includes('≈ 84') || h.horizontal.idDrift > 2 || h.horizontal.nameDrift > 2
            || h.horizontal.rowHeight !== 44 || c.desktop.outside || h.desktop.outside || h.narrow.theme !== 'dark') process.exitCode = 1;
         return;
       }
        if (process.env.REDESIGN_E2A_ONLY === '1') {
         await window.webContents.executeJavaScript('window.renderE2AJournal()');
         window.setContentSize(1440, 1000);
        window.showInactive();
        await new Promise(resolve => setTimeout(resolve, 180));
        const dir = path.join(root, '.opencode/deep-audit/output/redesign-phase-e2a-screenshots');
        fsSync.mkdirSync(dir, { recursive: true });
        const capture = async (name) => fsSync.writeFileSync(path.join(dir, name), (await window.webContents.capturePage()).toPNG());
        const measure = async () => window.webContents.executeJavaScript(`(() => {
          const box = el => { const r = el?.getBoundingClientRect(); return r && { x:r.x, y:r.y, width:r.width, height:r.height }; };
          const root = document.querySelector('.phase-b-patta-journal');
          return { viewport: [innerWidth, innerHeight], theme: document.documentElement.getAttribute('data-theme'),
            heading: box(root.querySelector('h1')), headingFont: getComputedStyle(root.querySelector('h1')).fontSize,
            cards: [...root.querySelectorAll('.journal-kpi')].map(box), values: [...root.querySelectorAll('.journal-kpi-value')].map(e => e.textContent.trim()),
            tabs: [...root.querySelectorAll('[role=tab]')].map(e => ({ label: e.textContent.trim(), selected: e.getAttribute('aria-selected') })),
            activeFilterColor: getComputedStyle(root.querySelector('.journal-filter-pills .soft-btn-primary')).color,
            columns: box(root.querySelector('.journal-model-columns')), model: box(root.querySelector('.journal-model-row')),
            partyRows: root.querySelectorAll('.journal-party-table > tbody > tr').length,
            ticketRows: root.querySelectorAll('.journal-party-table table tbody tr').length,
            partyText: root.querySelector('.journal-party-table')?.textContent.slice(0, 550),
            outside: performance.getEntriesByType('resource').filter(item => { try { return !['127.0.0.1','localhost'].includes(new URL(item.name).hostname) && new URL(item.name).protocol !== 'file:'; } catch { return false; } }).length };
        })()`);
        const initial = await measure();
        await capture('desktop-1440.png');
        const actions = await window.webContents.executeJavaScript(`(async () => {
          const wait = () => new Promise(resolve => setTimeout(resolve, 70));
          const root = document.querySelector('.phase-b-patta-journal');
          const model = root.querySelector('.journal-model-row'); model.focus(); model.click(); await wait();
          const expanded = model.getAttribute('aria-expanded') === 'true';
          const party = root.querySelector('.journal-party-table > tbody > tr'); party?.click(); await wait();
          const tickets = root.querySelectorAll('.journal-party-table table tbody tr').length;
          const detail = root.textContent.includes('Kiritilmagan') && root.textContent.includes('№ 1');
          const search = root.querySelector('input[placeholder*=qidirish]');
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
          search.focus(); setter.call(search, 'yoq-model'); search.dispatchEvent(new Event('input', { bubbles:true })); await wait();
          const absent = !root.querySelector('.journal-model-row');
          setter.call(search, 'Demo'); search.dispatchEvent(new Event('input', { bubbles:true })); await wait();
          const found = !!root.querySelector('.journal-model-row');
          setter.call(search, ''); search.dispatchEvent(new Event('input', { bubbles:true })); await wait();
          const closed = [...root.querySelectorAll('[role=tab]')].find(e => e.textContent.includes('Yopilgan'));
          closed.click(); await wait(); const closedSelected = closed.getAttribute('aria-selected') === 'true';
          const closedCount = root.querySelector('.journal-kpi-value')?.textContent;
          const active = [...root.querySelectorAll('[role=tab]')].find(e => e.textContent.includes('Patta hisob'));
          active.click(); await wait();
          return { expanded, tickets, detail, absent, found, closedSelected, closedCount,
            restored: active.getAttribute('aria-selected') === 'true', keyboardFocusable: model.tagName === 'BUTTON' };
        })()`);
        window.focus(); window.webContents.focus();
        const beforeKeyboard = await window.webContents.executeJavaScript(`(() => { const row = document.querySelector('.journal-model-row'); row.focus(); return row.getAttribute('aria-expanded'); })()`);
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        await new Promise(resolve => setTimeout(resolve, 80));
        actions.keyboardToggled = await window.webContents.executeJavaScript(`document.querySelector('.journal-model-row')?.getAttribute('aria-expanded') !== ${JSON.stringify(beforeKeyboard)}`);
        await window.webContents.executeJavaScript(`if (document.querySelector('.journal-model-row').getAttribute('aria-expanded') !== 'true') document.querySelector('.journal-model-row').click()`);
        await new Promise(resolve => setTimeout(resolve, 80));
        const expanded = await measure(); await capture('desktop-expanded-1440.png');
        window.setContentSize(700, 900);
        await window.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme','dark'); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        await new Promise(resolve => setTimeout(resolve, 150));
        const narrow = await measure(); await capture('narrow-dark-700.png');
        const narrowScroll = await window.webContents.executeJavaScript(`(() => {
          const root = document.querySelector('.phase-b-patta-journal');
          root.scrollTop = root.scrollHeight;
          return { scrollHeight: root.scrollHeight, clientHeight: root.clientHeight, scrollTop: root.scrollTop,
            modelVisible: !!root.querySelector('.journal-model-row'), nestedTickets: root.querySelectorAll('.journal-party-table table tbody tr').length };
        })()`);
         await new Promise(resolve => setTimeout(resolve, 80)); await capture('narrow-dark-scrolled-700.png');
         const keyboard = await window.webContents.executeJavaScript(`(() => {
           const root = document.querySelector('.phase-b-patta-journal');
           const focusable = el => [...el.querySelectorAll('button,input,[tabindex]:not([tabindex="-1"])')]
             .filter(node => !node.disabled && node.getClientRects().length);
           const rings = focusable(root).map(el => {
             el.focus(); const style = getComputedStyle(el);
             return { tag:el.tagName, label:(el.getAttribute('aria-label') || el.textContent || el.placeholder || '').trim().slice(0,50),
               visible:el.matches(':focus-visible'), outline:style.outlineStyle, outlineWidth:style.outlineWidth,
               shadow:style.boxShadow };
           });
           const scrollers = [...root.querySelectorAll('*')].filter(el => {
             const s=getComputedStyle(el); return el.scrollWidth>el.clientWidth+10 && ['auto','scroll'].includes(s.overflowX);
           });
           const scroller = scrollers.find(el => el.querySelector('.journal-party-table')) || scrollers.find(el => el.querySelector('table'));
           if (scroller) scroller.scrollLeft=0;
           const targets = scroller ? focusable(scroller) : [];
           targets[0]?.focus();
           return { ringCount:rings.length, visibleRings:rings.filter(r => r.visible &&
             ((r.outline !== 'none' && r.outlineWidth !== '0px') || r.shadow !== 'none')).length,
             focusables:targets.length, scrollBefore:scroller?.scrollLeft || 0,
             scrollExtent:scroller ? scroller.scrollWidth-scroller.clientWidth : 0,
             target:targets[0]?.outerHTML.slice(0,140) || null };
         })()`);
         let horizontalTab = false;
         for (let i=0; i<80 && !horizontalTab; i++) {
           window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'TAB' });
           window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'TAB' });
           await new Promise(resolve => setTimeout(resolve, 8));
           horizontalTab = await window.webContents.executeJavaScript(`(() => {
             const root=document.querySelector('.phase-b-patta-journal');
             return [...root.querySelectorAll('*')].some(el => el.scrollWidth>el.clientWidth+10 &&
               ['auto','scroll'].includes(getComputedStyle(el).overflowX) && el.scrollLeft>0);
           })()`);
         }
         keyboard.horizontalTabReachedContent = horizontalTab;
         keyboard.finalScroll = await window.webContents.executeJavaScript(`Math.max(0,...[...document.querySelectorAll('.phase-b-patta-journal *')].map(el=>el.scrollLeft))`);
         console.log('LOCAL_E2A_RENDER ' + JSON.stringify({ initial, actions, expanded, narrow, narrowScroll, keyboard, screenshots: dir }));
        if (initial.cards.length !== 3 || initial.values[0] !== '1 ta' || !initial.values[1].includes('1 / 3')
          || !initial.values[2].includes('4 / 12') || initial.headingFont !== '36px' || initial.outside
          || !actions.expanded || actions.tickets !== 3 || !actions.detail || !actions.absent || !actions.found
          || !actions.closedSelected || !actions.closedCount.includes('1 ta') || !actions.restored || !actions.keyboardFocusable || !actions.keyboardToggled
          || expanded.ticketRows !== 3 || narrow.cards.length !== 3 || narrow.theme !== 'dark'
          || narrow.cards[0].width > narrow.viewport[0] || narrow.activeFilterColor !== 'rgb(255, 255, 255)'
           || narrowScroll.scrollTop <= 0 || !narrowScroll.modelVisible || narrowScroll.nestedTickets !== 3
           || keyboard.visibleRings < 1 || !keyboard.focusables || !keyboard.horizontalTabReachedContent) process.exitCode = 1;
        return;
      }
      if (process.env.REDESIGN_E1_ONLY === '1') {
         for (let id = 8; id < 48; id++) db.prepare(`INSERT INTO workers(id,company_id,name,staj,created_at,updated_at)
          VALUES (?,'hisob_test_browser',?,0,?,?)`).run(id, `Synthetic worker ${id}`, now, now);
         db.prepare(`UPDATE workers SET name=? WHERE id=8 AND company_id='hisob_test_browser'`)
           .run('Шаҳноза Абдуллаева');
         for (let id = 48; id < 60; id++) db.prepare(`INSERT INTO workers(id,company_id,name,staj,created_at,updated_at)
           VALUES (?,'hisob_test_browser',?,0,?,?)`).run(id, `Синтетик ишчи ${id} · Worker with a long test display name`, now, now);
         await window.webContents.executeJavaScript('window.renderE1Report()');
         const fontEvidence = await window.webContents.executeJavaScript(`(async () => {
           await document.fonts.ready;
           const styles = getComputedStyle(document.querySelector('.umumiy-report'));
           const heading = getComputedStyle(document.querySelector('.umumiy-report-heading h1'));
           const input = document.querySelector('.umumiy-report-search input');
           const value = document.querySelector('.umumiy-kpi .kpi-value');
           const loadedFaces = [...document.fonts].filter(face => face.status === 'loaded')
             .map(face => ({ family: face.family, weight: face.weight, stretch: face.stretch, status: face.status }));
           return { ready: document.fonts.status, ibmPlexSans14: document.fonts.check('14px "IBM Plex Sans"', 'Ўзбекча'),
             ibmPlexSans600: document.fonts.check('600 14px "IBM Plex Sans"', 'Ўзбекча'),
             onest800: document.fonts.check('800 34px Onest', 'Ўзбекча'),
             bodyFamily: styles.fontFamily, headingFamily: heading.fontFamily,
             inputFamily: input && getComputedStyle(input).fontFamily, valueFamily: value && getComputedStyle(value).fontFamily,
             loadedFaces, fontResources: performance.getEntriesByType('resource').filter(entry => entry.name.toLowerCase().includes('.ttf')).map(entry => entry.name),
             externalRequests: performance.getEntriesByType('resource').filter(entry => { try { const u=new URL(entry.name); return !['127.0.0.1','localhost'].includes(u.hostname) && u.protocol !== 'file:'; } catch { return false; } }).map(entry => entry.name) };
         })()`);
         if (!fontEvidence.ibmPlexSans14 || !fontEvidence.ibmPlexSans600 || !fontEvidence.onest800
           || !fontEvidence.loadedFaces.some(face => face.family.replaceAll('"', '') === 'IBM Plex Sans')
           || !fontEvidence.loadedFaces.some(face => face.family.replaceAll('"', '') === 'Onest')
           || fontEvidence.externalRequests.length) throw Error('Actual locally loaded font-face evidence failed: '+JSON.stringify(fontEvidence));
         window.setContentSize(1920, 1000);
        window.showInactive();
        await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const probe = async () => window.webContents.executeJavaScript(`(() => {
          const box = el => { const r = el?.getBoundingClientRect(); return r && { x: r.x, y: r.y, width: r.width, height: r.height }; };
          const report = document.querySelector('.umumiy-report');
          const scroller = document.querySelector('.umumiy-table-scroll');
          const row = scroller?.querySelector('tbody tr.fast-row');
          const th = [...(scroller?.querySelectorAll('thead th') || [])].map(el => el.textContent.trim());
          const firstCard = report.querySelector('.umumiy-kpi');
          const cardLabel = firstCard?.querySelector('.kpi-label');
          const cardValue = firstCard?.querySelector('.kpi-value');
          const searchBox = report.querySelector('.umumiy-report-search input');
          const heading = report.querySelector('h1');
          return { viewport: [innerWidth, innerHeight], devicePixelRatio, zoom: visualViewport?.scale ?? 1,
            title: box(document.querySelector('.excel-titlebar')),
            report: box(report), cards: [...report.querySelectorAll('.umumiy-kpi')].map(box),
            bodyFontSize: getComputedStyle(report).fontSize,
            heading: { rect: box(heading), fontSize: getComputedStyle(heading).fontSize,
              fontWeight: getComputedStyle(heading).fontWeight, lineHeight: getComputedStyle(heading).lineHeight,
              letterSpacing: getComputedStyle(heading).letterSpacing },
             cardLayout: firstCard && { display: getComputedStyle(firstCard).display, direction: getComputedStyle(firstCard).flexDirection,
               minHeight: getComputedStyle(firstCard).minHeight, padding: getComputedStyle(firstCard).padding,
               icon: box(firstCard.querySelector('.kpi-icon-container')), label: box(cardLabel), value: box(cardValue),
               labelFont: getComputedStyle(cardLabel).font, valueFont: getComputedStyle(cardValue).font },
             kpiValues: [...report.querySelectorAll('.umumiy-kpi .kpi-value')].map(el => ({ text: el.innerText.trim(), width: el.clientWidth,
               scrollWidth: el.scrollWidth, fontSize: getComputedStyle(el).fontSize, long: el.classList.contains('kpi-value-long') })),
            search: box(searchBox), searchFont: searchBox && getComputedStyle(searchBox).font,
            theme: document.documentElement.getAttribute('data-theme'),
            cardBackground: getComputedStyle(report.querySelector('.umumiy-kpi')).backgroundColor,
            tableBackground: getComputedStyle(scroller).backgroundColor,
            headingFontFamily: getComputedStyle(heading).fontFamily,
            kpiFont: getComputedStyle(report.querySelector('.kpi-value')).fontSize,
            header: box(scroller.querySelector('thead tr')), row: box(row), footer: box(scroller.querySelector('.umumiy-total-row')),
            scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
            columns: th, status: report.querySelector('[role=status]')?.textContent,
            gross: scroller.querySelector('tbody tr.fast-row td:nth-child(3)')?.textContent,
            net: scroller.querySelector('tbody tr.fast-row td:nth-child(7)')?.textContent,
            bodyRows: scroller.querySelectorAll('tbody tr.fast-row').length,
            hasSearch: !!report.querySelector('input[placeholder*="Ishchi qidirish"]'),
            outside: performance.getEntriesByType('resource').filter(item => { try { return !['127.0.0.1','localhost'].includes(new URL(item.name).hostname) && new URL(item.name).protocol !== 'file:'; } catch { return false; } }).length
          };
        })()`);
        const wide = await probe();
        const e1Dir = path.join(root, '.opencode/deep-audit/output/visual-density-main-screenshots');
        fsSync.mkdirSync(e1Dir, { recursive: true });
        fsSync.writeFileSync(path.join(e1Dir, 'desktop-1920.png'), (await window.webContents.capturePage()).toPNG());
        window.setContentSize(1440, 1000);
        await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const desktop = await probe();
        fsSync.writeFileSync(path.join(e1Dir, 'desktop-1440.png'), (await window.webContents.capturePage()).toPNG());
        const visualChecks = await window.webContents.executeJavaScript(`(() => {
          const scroller=document.querySelector('.umumiy-table-scroll'), search=document.querySelector('.umumiy-report-search input');
          search.focus(); const focus=getComputedStyle(search);
          const headings=[...document.querySelectorAll('.umumiy-report thead th')].map(th=>th.innerText.trim());
          const inputs=[...document.querySelectorAll('.umumiy-report tbody tr.fast-row input')];
          const horizontal={scrollWidth:scroller.scrollWidth,clientWidth:scroller.clientWidth,maxScrollLeft:scroller.scrollWidth-scroller.clientWidth};
          scroller.scrollLeft=scroller.scrollWidth;
          const last=document.querySelector('.umumiy-report thead th:last-child').getBoundingClientRect();
          const lastColumnReachable=last.right<=scroller.getBoundingClientRect().right+1; scroller.scrollLeft=0;
          const nameCell=[...document.querySelectorAll('.umumiy-report tbody tr.fast-row')].find(row=>row.innerText.includes('Шаҳноза Абдуллаева'))?.cells[1];
          const nameVisual=nameCell?.querySelector('span,div')||nameCell;
          return {viewport:innerWidth,headings,nineHeadings:headings.length===9,inputCount:inputs.length,focus:{active:document.activeElement===search,outlineStyle:focus.outlineStyle,outlineWidth:focus.outlineWidth,outlineColor:focus.outlineColor,boxShadow:focus.boxShadow,borderColor:focus.borderColor,borderWidth:focus.borderWidth},horizontal,lastColumnReachable,longName:{present:!!nameCell,text:nameCell?.innerText,scrollWidth:nameVisual?.scrollWidth,clientWidth:nameVisual?.clientWidth,overflow:getComputedStyle(nameVisual).overflow,textOverflow:getComputedStyle(nameVisual).textOverflow,whiteSpace:getComputedStyle(nameVisual).whiteSpace}};
        })()`);
        fsSync.writeFileSync(path.join(e1Dir, 'visual-checks-1440.json'), JSON.stringify(visualChecks, null, 2));
        fsSync.writeFileSync(path.join(e1Dir, 'desktop-1440-search-focused.png'), (await window.webContents.capturePage()).toPNG());
        const interactions = await window.webContents.executeJavaScript(`(async () => {
          const scroller = document.querySelector('.umumiy-table-scroll');
          const search = document.querySelector('.umumiy-report-search input');
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          search.focus(); setter.call(search, 'Demo worker'); search.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(resolve => setTimeout(resolve, 80));
          const filtered = document.querySelectorAll('.umumiy-report tbody tr.fast-row').length;
          setter.call(search, ''); search.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(resolve => setTimeout(resolve, 80));
          scroller.scrollTop = 600;
          await new Promise(resolve => setTimeout(resolve, 80));
          const header = scroller.querySelector('thead th');
          const headerTop = header.getBoundingClientRect().top, scrollTop = scroller.getBoundingClientRect().top;
          const sticky = Math.abs(headerTop - scrollTop) < 3;
          scroller.scrollTop = scroller.scrollHeight;
          await new Promise(resolve => setTimeout(resolve, 100));
            const last = [...scroller.querySelectorAll('tbody tr.fast-row')].some(row => row.textContent.includes('Синтетик ишчи 59'));
          const first = scroller.querySelector('tbody tr.fast-row'); first?.querySelector('td')?.click();
          await new Promise(resolve => setTimeout(resolve, 40));
          const selected = !!scroller.querySelector('.selected-row');
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await new Promise(resolve => setTimeout(resolve, 30));
          const cleared = !scroller.querySelector('.selected-row');
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
          await new Promise(resolve => setTimeout(resolve, 30));
          const sidebar = !!document.querySelector('.excel-sidebar.open');
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          scroller.scrollTop = 0;
          return { filtered, last, sticky, headerTop, scrollTop, selected, cleared, sidebar };
        })()`);
        window.setContentSize(760, 900);
        await window.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme', 'dark'); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        await new Promise(resolve => setTimeout(resolve, 120));
        const narrow = await probe();
        const narrowChecks = await window.webContents.executeJavaScript(`(() => {
          const scroller=document.querySelector('.umumiy-table-scroll'),search=document.querySelector('.umumiy-report-search input');search.focus();
          const headings=[...document.querySelectorAll('.umumiy-report thead th')].map(th=>th.innerText.trim());
          const horizontal={scrollWidth:scroller.scrollWidth,clientWidth:scroller.clientWidth,maxScrollLeft:scroller.scrollWidth-scroller.clientWidth};
          scroller.scrollLeft=scroller.scrollWidth;const last=document.querySelector('.umumiy-report thead th:last-child').getBoundingClientRect();
          const lastColumnReachable=last.right<=scroller.getBoundingClientRect().right+1;scroller.scrollLeft=0;
          return {viewport:innerWidth,headings,nineHeadings:headings.length===9,searchFocused:document.activeElement===search,horizontal,lastColumnReachable};
        })()`);
        fsSync.writeFileSync(path.join(e1Dir, 'visual-checks-760.json'), JSON.stringify(narrowChecks, null, 2));
        fsSync.writeFileSync(path.join(e1Dir, 'narrow-dark-760.png'), (await window.webContents.capturePage()).toPNG());
         fsSync.writeFileSync(path.join(e1Dir, 'font-evidence.json'), JSON.stringify(fontEvidence, null, 2));
         const proofEvidence = { status: 'PASS', run: 'REDESIGN_E1_ONLY=1 node scripts/verify/render/payroll-display-runtime.cjs',
           fixture: { kind: 'production renderer/App with fresh own synthetic SQLite', fixtureRoot, rendererOutput: outDir,
             workers: db.prepare("SELECT COUNT(*) AS n FROM workers WHERE company_id='hisob_test_browser'").get().n,
             gross: result.umumiyGrossText, net: result.umumiyNetText, provisional: result.provisional, columns: desktop.columns.length },
           capture: { devicePixelRatio: 1, zoom: 1 }, fontEvidence,
           viewports: { '1920x1000': wide, '1440x1000': { ...desktop, visualChecks }, '760x900-dark': { ...narrow, narrowChecks } },
           interactions, screenshots: e1Dir };
         fsSync.writeFileSync(path.join(e1Dir, 'evidence.json'), JSON.stringify(proofEvidence, null, 2));
         console.log('LOCAL_E1_RENDER ' + JSON.stringify({ fontEvidence, wide, desktop, visualChecks, interactions, narrow, narrowChecks, screenshots: e1Dir }));
        if (wide.viewport[0] !== 1920 || wide.devicePixelRatio !== 1 || wide.zoom !== 1
          || wide.cards.length !== 4 || wide.cardLayout.direction !== 'row'
          || Math.abs(wide.cards[0].height - 101.39) > 0.1 || wide.cardLayout.icon.width !== 52
          || wide.search.x !== 56 || wide.search.height !== 44 || wide.search.width !== 440
          || desktop.title.height !== 76 || desktop.cards.length !== 4 || desktop.cards[0].width < 250
          || Math.abs(desktop.cards[0].height - 101.39) > 0.1
          || desktop.search.x !== 56 || desktop.heading.fontSize !== '36px' || desktop.heading.lineHeight !== '41.4px'
          || desktop.kpiFont !== '34px' || desktop.header.height !== 53 || desktop.row.height !== 58
          || desktop.footer.height !== 60 || desktop.columns[2] !== 'Umumiy ish haqi'
          || desktop.columns[6] !== 'Sof foyda' || !desktop.gross.includes('≈ 84')
          || !desktop.net.includes('≈ 76') || !desktop.status.includes('Taxminiy') || desktop.outside
          || interactions.filtered !== 2 || !interactions.last || !interactions.sticky
         || !interactions.selected || !interactions.cleared || !interactions.sidebar
         || !visualChecks.nineHeadings || !visualChecks.focus.active
         || !visualChecks.lastColumnReachable || visualChecks.horizontal.maxScrollLeft <= 0
         || !visualChecks.longName.present || visualChecks.longName.scrollWidth > visualChecks.longName.clientWidth
         || !narrowChecks.nineHeadings || !narrowChecks.searchFocused || !narrowChecks.lastColumnReachable || narrowChecks.horizontal.maxScrollLeft <= 0
         || wide.kpiValues.some(value => value.scrollWidth > value.width)
         || narrow.cards.length !== 4 || narrow.cards.some(card => card.height < 90 || card.height > 110)
          || narrow.cardLayout.direction !== 'row' || narrow.report.width > narrow.viewport[0]
          || narrow.viewport[0] !== 760 || narrow.theme !== 'dark' || narrow.cardBackground === 'rgb(255, 255, 255)') process.exitCode = 1;
        return;
      }
      // Keep the owner-visible preview focused; show this isolated test window inactive only for accurate captures.
      window.showInactive();
      const phaseBScreens = [];
      for (const surface of ((c1Only || c2Only) ? [] : ['batch', 'entry', 'journal', 'hisob', 'conveyor'])) {
        console.log(`LOCAL_PHASE_B_BEGIN ${surface}`);
        let mounted;
        try { mounted = await window.webContents.executeJavaScript(`window.renderPhaseBSurface(${JSON.stringify(surface)})`); }
        catch (error) { console.error(`LOCAL_PHASE_B_MOUNT_ERROR ${surface}`, error); throw error; }
        await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        await new Promise(resolve => setTimeout(resolve, 180));
        const actionNeedle = { batch: 'Pechat (', entry: 'Jo', journal: 'Barchasi', hisob: 'Yangi operatsiya', conveyor: 'Excel (CSV) Eksport' }[surface];
        const evidence = await window.webContents.executeJavaScript(`(() => {
          const root = document.querySelector('.phase-b-${surface === 'batch' ? 'batch' : surface === 'entry' ? 'patta-entry' : surface === 'journal' ? 'patta-journal' : surface}') || document.querySelector('.phase-b-view');
          const text = root?.textContent || '';
          const viewClass = [...(root?.classList || [])].find(name => name.startsWith('phase-b-') && name !== 'phase-b-view');
          return { surface: ${JSON.stringify(surface)}, mounted: !!root, viewClass,
            headings: root?.querySelectorAll('h1,h2,h3').length || 0, inputs: root?.querySelectorAll('input').length || 0,
            tables: root?.querySelectorAll('table').length || 0,
            action: [...(root?.querySelectorAll('button') || [])].some(button => button.textContent.includes(${JSON.stringify(actionNeedle)}) || button.className.includes('soft-btn-primary')),
            identifyingText: text.slice(0, 180) };
        })()`);
        const screenshot = await window.webContents.capturePage();
        const screenshotDir = path.join(fixtureRoot, 'phase-b-screenshots');
        const canonicalScreenshotDir = path.join(root, '.opencode/deep-audit/output/redesign-phase-b-screenshots');
        fsSync.mkdirSync(screenshotDir, { recursive: true });
        fsSync.mkdirSync(canonicalScreenshotDir, { recursive: true });
        const screenshotPath = path.join(screenshotDir, `${surface}.png`);
        fsSync.writeFileSync(screenshotPath, screenshot.toPNG());
        const canonicalScreenshotPath = path.join(canonicalScreenshotDir, `${surface}.png`);
        fsSync.writeFileSync(canonicalScreenshotPath, screenshot.toPNG());
        phaseBScreens.push({ ...mounted, ...evidence, screenshotPath: canonicalScreenshotPath });
        if (!evidence.mounted || !evidence.viewClass || evidence.inputs === 0 || !evidence.action) process.exitCode = 1;
        if (surface === 'batch') {
          const sizeAction = await window.webContents.executeJavaScript(`(async () => {
            const button = [...document.querySelectorAll('[aria-label="Razmer turi"] button')].find(item => item.textContent.includes('Raqamli'));
            button?.click(); await new Promise(resolve => setTimeout(resolve, 40));
            const selected = button?.getAttribute('aria-pressed') === 'true';
            button?.click(); return { exists: !!button, selected };
          })()`);
          if (!sizeAction.exists || !sizeAction.selected) process.exitCode = 1;
          phaseBScreens[phaseBScreens.length - 1].sizeToggleAction = sizeAction;
        }
        if (surface === 'entry') {
          const addOperation = await window.webContents.executeJavaScript(`(async () => {
            const button = [...document.querySelectorAll('.phase-b-patta-entry button')].find(item => item.textContent.includes("Operatsiya qo'shish"));
            button?.click(); await new Promise(resolve => setTimeout(resolve, 40));
            return { exists: !!button, inlineEntry: document.querySelectorAll('.phase-b-patta-entry input').length > ${evidence.inputs} };
          })()`);
          if (!addOperation.exists || !addOperation.inlineEntry) process.exitCode = 1;
          phaseBScreens[phaseBScreens.length - 1].addOperationAction = addOperation;
        }
        if (surface === 'journal') {
          const journalAction = await window.webContents.executeJavaScript(`(async () => {
            const tab = [...document.querySelectorAll('[role="tab"]')].find(button => button.textContent.includes('Yopilgan'));
            tab?.click(); await new Promise(resolve => setTimeout(resolve, 50));
            return { exists: !!tab, selected: tab?.getAttribute('aria-selected') };
          })()`);
          if (!journalAction.exists || journalAction.selected !== 'true') process.exitCode = 1;
          phaseBScreens[phaseBScreens.length - 1].journalTabAction = journalAction;
        }
        if (surface === 'conveyor') {
          const detailAction = await window.webContents.executeJavaScript(`(async () => {
            const tab = [...document.querySelectorAll('button')].find(button => button.textContent.includes("Pattalar Ro'yxati"));
            tab?.click(); await new Promise(resolve => setTimeout(resolve, 50));
            return { exists: !!tab, detailToolbar: !!document.querySelector('input[placeholder*="Qidiruv (Partiya"]') };
          })()`);
          if (!detailAction.exists || !detailAction.detailToolbar) process.exitCode = 1;
          phaseBScreens[phaseBScreens.length - 1].detailTabAction = detailAction;
        }
      }
      console.log('LOCAL_PHASE_B_RENDER ' + JSON.stringify(phaseBScreens));
      const phaseCScreens = [];
      const phaseCModalNames = c1Only ? ['worker-manager', 'worker-detail', 'period-manager']
        : c2Only ? ['new-model', 'new-operation', 'delete-operation', 'edit-ticket', 'print', 'backup',
          'license', 'update', 'developer', 'confirm', 'notification', 'loading']
        : ['worker-manager', 'worker-detail', 'period-manager', 'new-model', 'new-operation',
          'delete-operation', 'edit-ticket', 'print', 'backup', 'license', 'update', 'developer', 'confirm', 'notification', 'loading'];
      for (const modal of phaseCModalNames) {
        console.log(`LOCAL_PHASE_C_BEGIN ${modal}`);
        const mounted = await window.webContents.executeJavaScript(`window.renderPhaseCModal(${JSON.stringify(modal)})`);
        await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        await new Promise(resolve => setTimeout(resolve, 140));
        const evidence = await window.webContents.executeJavaScript(`(() => {
          const text = document.body.textContent || '';
          const modal = ${JSON.stringify(modal)};
          const visible = modal === 'print' ? !!document.querySelector('.phase-c-print-preview')
            : modal === 'notification' ? !!document.querySelector('.toast-item')
            : modal === 'loading' ? !!document.querySelector('.phase-c-loading-card')
            : modal === 'confirm' ? !!document.querySelector('.phase-c-confirm-card')
            : !!document.querySelector('.modal-overlay .modal-card');
          return { modal, visible, fixtureMarker: text.includes('LOCAL TEST FIXTURE'),
            fields: document.querySelectorAll('.modal-overlay input').length,
            statusText: [...document.querySelectorAll('[role="status"]')].map(el => el.textContent).join(' ').slice(0, 160),
            modalText: (document.querySelector('.phase-c-modal .modal-card')?.textContent || '').slice(0, 1800),
            text: text.slice(-350) };
        })()`);
         const modalScreenshotDir = path.join(root, e3Only ? '.opencode/deep-audit/output/redesign-phase-e3-screenshots' : '.opencode/deep-audit/output/redesign-phase-c-screenshots');
        fsSync.mkdirSync(modalScreenshotDir, { recursive: true });
        const screenshotPath = path.join(modalScreenshotDir, `${modal}.png`);
        fsSync.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
        console.log(`LOCAL_PHASE_C_CAPTURED ${modal}`);
         phaseCScreens.push({ ...mounted, ...evidence, screenshotPath });
         if (e3Only && c1Only) {
           const probe = () => window.webContents.executeJavaScript(`(() => {
             const card = document.querySelector('.phase-c-modal .modal-card');
             const box = e => { const r=e?.getBoundingClientRect(); return r && {x:r.x,y:r.y,width:r.width,height:r.height}; };
             const detail = document.querySelector('.e3-detail-card'), period = document.querySelector('.e3-period-card');
             return { viewport:[innerWidth,innerHeight], theme:document.documentElement.getAttribute('data-theme'), card:box(card),
               headingSize:getComputedStyle(card.querySelector('h2') || card.querySelector('.modal-header span')).fontSize,
               stats:[...(detail?.querySelectorAll('.e3-detail-stats .kpi-card') || [])].map(box),
               metrics:[...(period?.querySelectorAll('.e3-period-metrics > div') || [])].map(box),
               tabs:box(period?.querySelector('.e3-period-tabs')), table:box(detail?.querySelector('.e3-detail-table')),
               tableScroll:detail?.querySelector('.e3-detail-table')?.scrollWidth,
               text:card.textContent.slice(0,950), status:card.querySelector('[role=status]')?.textContent,
               outside:performance.getEntriesByType('resource').filter(item => { try { const u=new URL(item.name); return u.protocol !== 'file:' && !['localhost','127.0.0.1'].includes(u.hostname); } catch { return false; } }).length };
           })()`);
           const desktop = await probe();
           window.setContentSize(700, 900);
           await window.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme','dark')`);
           await new Promise(resolve => setTimeout(resolve, 340));
           const narrow = await probe();
           fsSync.writeFileSync(path.join(modalScreenshotDir, `${modal}-narrow-dark.png`), (await window.webContents.capturePage()).toPNG());
           window.setContentSize(1440, 1000);
           await window.webContents.executeJavaScript(`document.documentElement.removeAttribute('data-theme')`);
           await new Promise(resolve => setTimeout(resolve, 340));
           phaseCScreens[phaseCScreens.length-1].geometry = { desktop, narrow };
           if (!desktop.card || desktop.card.width > 970 || narrow.card.width > 700 || narrow.card.x < 0 || narrow.outside
             || (modal === 'worker-detail' && (desktop.stats.length !== 5 || desktop.headingSize !== '24px' || desktop.tableScroll < 1100))
             || (modal === 'period-manager' && (desktop.metrics.length !== 4 || desktop.headingSize !== '22px' || desktop.card.width > 650))) process.exitCode = 1;
         }
         if (e3Only && c2Only) {
           window.setContentSize(700, 900);
           await window.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme','dark')`);
           await new Promise(resolve => setTimeout(resolve, 340));
           const geometry = await window.webContents.executeJavaScript(`(() => {
             const el=document.querySelector('.phase-c-dialog .modal-card, .phase-c-confirm-card, .phase-c-loading-card, .phase-c-print-preview, .toast-item');
             const r=el?.getBoundingClientRect(); return { visible:!!r, x:r?.x, width:r?.width, theme:document.documentElement.getAttribute('data-theme') };
           })()`);
           fsSync.writeFileSync(path.join(modalScreenshotDir, `${modal}-narrow-dark.png`), (await window.webContents.capturePage()).toPNG());
           phaseCScreens[phaseCScreens.length-1].narrow = geometry;
           if (!geometry.visible || geometry.theme !== 'dark' || (modal !== 'print' && (geometry.x < 0 || geometry.width > 700))) process.exitCode = 1;
           window.setContentSize(1440, 1000);
           await window.webContents.executeJavaScript(`document.documentElement.removeAttribute('data-theme')`);
           await new Promise(resolve => setTimeout(resolve, 340));
         }
        if (!evidence.visible || !evidence.fixtureMarker) process.exitCode = 1;
         if (modal === 'worker-manager') {
          const searchAction = await window.webContents.executeJavaScript(`(async () => {
            const input = document.querySelector('input[placeholder^="Qidirish"]');
            if (!input) return { found: false, filtered: false };
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(input, 'no-match-local-test'); input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 45));
            return { found: true, filtered: document.querySelector('.modal-card tbody')?.textContent.includes('Ishchi topilmadi') === true };
          })()`);
          if (!searchAction.found || !searchAction.filtered) process.exitCode = 1;
           phaseCScreens[phaseCScreens.length - 1].searchAction = searchAction;
           if (e3Only) {
             const tabFocus = await window.webContents.executeJavaScript(`(() => { const input=document.querySelector('input[placeholder^="Qidirish"]'); input.focus(); return document.activeElement === input; })()`);
             phaseCScreens[phaseCScreens.length - 1].searchFocus = tabFocus;
             if (!tabFocus) process.exitCode = 1;
         }
          const cancelAction = await window.webContents.executeJavaScript(`(() => {
            const button = [...document.querySelectorAll('.phase-c-worker-manager button')].find(item => item.textContent.includes('Yopish'));
            button?.click(); return { found: !!button };
          })()`);
          if (!cancelAction.found) process.exitCode = 1;
          phaseCScreens[phaseCScreens.length - 1].cancelAction = cancelAction;
         }
         if (modal === 'worker-detail' && e3Only) {
           const searchAction = await window.webContents.executeJavaScript(`(async () => {
             const search=document.querySelector('.e3-detail-search input'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
             search.focus(); setter.call(search,'not-found-local'); search.dispatchEvent(new Event('input',{bubbles:true}));
             await new Promise(r=>setTimeout(r,45)); const empty=document.querySelector('.e3-detail-table')?.textContent.includes('Hozircha birorta bajarilgan ish topilmadi');
             setter.call(search,''); search.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,45));
             const table=document.querySelector('.e3-detail-table'); table.scrollLeft=table.scrollWidth;
             return {focused:document.activeElement===search, empty, restored:table.textContent.includes('≈ 84'), horizontal:table.scrollLeft>0};
           })()`);
           phaseCScreens[phaseCScreens.length-1].searchAction = searchAction;
           if (!searchAction.focused || !searchAction.empty || !searchAction.restored || !searchAction.horizontal) process.exitCode=1;
           const unknown = await window.webContents.executeJavaScript(`(async () => {
             window.switchPayrollContext('other-local-company'); await new Promise(r=>setTimeout(r,40));
             const text=document.querySelector('.e3-detail-stats')?.textContent || '';
             window.switchPayrollContext('hisob_test_browser'); return {unknown:text.includes('Noma’lum'), noStaleNet:!text.includes('≈ 76')};
           })()`);
           phaseCScreens[phaseCScreens.length-1].contextGuard = unknown;
           if (!unknown.unknown || !unknown.noStaleNet) process.exitCode=1;
         }
         if (modal === 'period-manager') {
           if (e3Only) {
             const editCancel = await window.webContents.executeJavaScript(`(async () => { const b=[...document.querySelectorAll('.e3-period-overview button')].find(e=>e.textContent.includes('Tahrirlash')); b?.click(); await new Promise(r=>setTimeout(r,35)); const editing=!!document.querySelector('.e3-period-overview input'); const cancel=[...document.querySelectorAll('.e3-period-overview button')].find(e=>e.textContent.includes('Bekor qilish')); cancel?.click(); await new Promise(r=>setTimeout(r,35)); return {editing,canceled:!document.querySelector('.e3-period-overview input')}; })()`);
             phaseCScreens[phaseCScreens.length-1].editCancel = editCancel;
             if (!editCancel.editing || !editCancel.canceled) process.exitCode = 1;
           }
          const historyAction = await window.webContents.executeJavaScript(`(async () => {
            const button = [...document.querySelectorAll('.modal-card button')].find(item => item.textContent.includes('Yopilgan Oylar Arxivi'));
            button?.click(); await new Promise(resolve => setTimeout(resolve, 50));
            return { found: !!button, archiveTab: document.body.textContent.includes('Q') && document.body.textContent.includes('Arxiv') };
          })()`);
          if (!historyAction.found || !historyAction.archiveTab) process.exitCode = 1;
          phaseCScreens[phaseCScreens.length - 1].historyAction = historyAction;
          const archiveReadAction = await window.webContents.executeJavaScript(`(async () => {
            const button = [...document.querySelectorAll('.phase-c-period-manager button')].find(item => item.textContent.includes('Hisobni ko'));
            button?.click(); await new Promise(resolve => setTimeout(resolve, 180));
            const summary = document.querySelector('[data-period-summary="archive_Q.json"]');
            const text = summary?.textContent || '';
            return { found: !!button, summary: !!summary, gross84: text.includes('≈ 84'), net76: text.includes('≈ 76'), provisional: text.includes('Taxminiy') };
          })()`);
          if (!archiveReadAction.found || !archiveReadAction.summary || !archiveReadAction.gross84
            || !archiveReadAction.net76 || !archiveReadAction.provisional) process.exitCode = 1;
          phaseCScreens[phaseCScreens.length - 1].archiveReadAction = archiveReadAction;
          const archiveScreenshotPath = path.join(modalScreenshotDir, 'period-archive-read.png');
          fsSync.writeFileSync(archiveScreenshotPath, (await window.webContents.capturePage()).toPNG());
          phaseCScreens[phaseCScreens.length - 1].archiveScreenshotPath = archiveScreenshotPath;
          const cancelAction = await window.webContents.executeJavaScript(`(() => {
            const button = [...document.querySelectorAll('.phase-c-period-manager button')].find(item => item.textContent.trim() === 'Chiqish');
            button?.click(); return { found: !!button };
          })()`);
          if (!cancelAction.found) process.exitCode = 1;
          phaseCScreens[phaseCScreens.length - 1].cancelAction = cancelAction;
        }
        if (modal === 'new-operation' || modal === 'new-model' || modal === 'delete-operation') {
          const cancelAction = await window.webContents.executeJavaScript(`(() => {
            const button = [...document.querySelectorAll('.modal-card button')].find(item => item.textContent.includes('Bekor qilish'));
            button?.click(); return { found: !!button };
          })()`);
          if (!cancelAction.found) process.exitCode = 1;
          phaseCScreens[phaseCScreens.length - 1].cancelAction = cancelAction;
        }
        if (modal === 'edit-ticket') {
          const escapeAction = await window.webContents.executeJavaScript(`(async () => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 45));
            return { closed: !document.querySelector('.modal-card') };
          })()`);
          if (!escapeAction.closed) process.exitCode = 1;
          phaseCScreens[phaseCScreens.length - 1].escapeAction = escapeAction;
        }
        if (modal === 'print') {
          const closeAction = await window.webContents.executeJavaScript(`(() => {
            const button = [...document.querySelectorAll('.phase-c-print-preview button')].find(item => item.textContent.includes('Yopish'));
            button?.click(); return { found: !!button };
          })()`);
          if (!closeAction.found) process.exitCode = 1;
          phaseCScreens[phaseCScreens.length - 1].closeAction = closeAction;
        }
        if (modal === 'confirm') {
          // Hide the isolated verification window before the existing resolve path requests focus.
          window.hide();
          const cancelAction = await window.webContents.executeJavaScript(`(() => {
            const button = [...document.querySelectorAll('.phase-c-confirm-card button')].find(item => item.textContent.includes('Bekor qilish'));
            button?.click(); return { found: !!button };
          })()`);
          await new Promise(resolve => setTimeout(resolve, 60));
          const canceled = await window.webContents.executeJavaScript('({ result: window.__fixtureConfirmResult, closed: window.readFixtureConfirmState() === null })');
          if (!cancelAction.found || canceled.result !== false || !canceled.closed) process.exitCode = 1;
          phaseCScreens[phaseCScreens.length - 1].cancelAction = { ...cancelAction, ...canceled };
          window.showInactive();
        }
      }
      console.log('LOCAL_PHASE_C_RENDER ' + JSON.stringify(phaseCScreens));
       if (c1Only) {
        const worker = phaseCScreens.find(item => item.modalName === 'worker-detail');
        const period = phaseCScreens.find(item => item.modalName === 'period-manager');
        const archive = period?.archiveReadAction;
        if (!worker?.modalText.includes('≈ 84') || !worker.modalText.includes('≈ 76')
          || !worker.statusText.includes('Taxminiy') || !archive?.summary || !archive.gross84 || !archive.net76
          || !archive.provisional || !period.cancelAction?.found) process.exitCode = 1;
        console.log('LOCAL_C1_FINANCIAL_AND_ARCHIVE ' + JSON.stringify({
          workerDetailGross84: worker?.modalText.includes('≈ 84'), workerDetailNet76: worker?.modalText.includes('≈ 76'),
          workerDetailProvisional: worker?.statusText.includes('Taxminiy'), archive, periodCancel: period?.cancelAction
        }));
      } else if (c2Only) {
        const byName = (name) => phaseCScreens.find(item => item.modalName === name);
        const cancelButtons = ['new-model', 'new-operation', 'delete-operation'].every(name => byName(name)?.cancelAction?.found);
        const ticketEscape = byName('edit-ticket')?.escapeAction?.closed === true;
        const printClose = byName('print')?.closeAction?.found === true;
        const confirmCancel = byName('confirm')?.cancelAction?.found === true
          && byName('confirm')?.cancelAction?.result === false && byName('confirm')?.cancelAction?.closed === true;
        const notification = byName('notification');
        if (!cancelButtons || !ticketEscape || !printClose || !confirmCancel
          || !notification?.visible || !byName('loading')?.visible) process.exitCode = 1;
        console.log('LOCAL_C2_SAFE_ACTIONS ' + JSON.stringify({ cancelButtons, ticketEscape, printClose,
          confirmCancel, notificationVisible: !!notification?.visible, loadingVisible: !!byName('loading')?.visible,
          writesAttempted: false, productionActionsExecuted: false }));
      } else {
      const licenseState = await window.webContents.executeJavaScript('window.changeLicenseContext()');
       const licenseCleared = await window.webContents.executeJavaScript(`({ cleared: [...document.querySelectorAll('.excel-grid-container')]
         .every(view => view.textContent.includes('Noma’lum')), text: [...document.querySelectorAll('.excel-grid-container')].map(view => view.textContent) })`);
       console.log('LOCAL_LICENSE_CONTEXT_UI ' + JSON.stringify({ oldMoneyCleared: licenseCleared.cleared,
         valuationStatus: licenseState.accountingStatus, text: licenseCleared.text }));
       if (!licenseCleared.cleared || licenseState.accountingStatus !== 'UNAVAILABLE') process.exitCode = 1;
       db.prepare(`UPDATE models SET operations_json='[{"id":"sew","name":"Sew","rate":9}]' WHERE id='m' AND company_id=?`).run(company);
      const openAtNine = readWorkbookPayrollProjection(db, company);
      await window.webContents.executeJavaScript(`window.renderPayrollFixture(${JSON.stringify(openAtNine)})`);
      const openRate = await window.webContents.executeJavaScript(`(() => {
        const view = document.querySelector('.excel-grid-container');
        const input = view.querySelector('thead input');
        return { amount: view.textContent.includes('≈ 108'), rate: input?.value, editable: Boolean(input) };
      })()`);
      console.log('LOCAL_OPEN_RATE_UI ' + JSON.stringify(openRate));
      if (!openRate.amount || openRate.rate !== '9' || !openRate.editable) process.exitCode = 1;
      await window.webContents.executeJavaScript("window.switchPayrollContext('other-company')");
      const wrongCompany = await window.webContents.executeJavaScript("[...document.querySelectorAll('.excel-grid-container')].every(view => view.textContent.includes('Noma’lum'))");
      await window.webContents.executeJavaScript("window.switchPayrollContext('hisob_test_browser','other-period')");
      const wrongPeriod = await window.webContents.executeJavaScript("[...document.querySelectorAll('.excel-grid-container')].every(view => view.textContent.includes('Noma’lum'))");
      console.log('LOCAL_CONTEXT_UI ' + JSON.stringify({ wrongCompany, wrongPeriod }));
      if (!wrongCompany || !wrongPeriod) process.exitCode = 1;
      db.prepare('UPDATE periods SET is_closed=1 WHERE id=? AND company_id=?').run('P', company);
      db.prepare(`UPDATE models SET operations_json='[{"id":"sew","name":"Sew","rate":9}]' WHERE id='m' AND company_id=?`).run(company);
       const closingP = { models: [{ id: 'm', operations: [{ name: 'Sew', rate: 7 }] }] };
       db.prepare(`INSERT INTO period_archives(company_id,period_id,archive_json,sha256,archived_at)
         VALUES (?,'P',? ,?,?)`).run(company, JSON.stringify(closingP), computePayloadHash(canonicalStringify(closingP)), now);
       const closed = readWorkbookPayrollProjection(db, company);
       if (closed.payrollValuation.syncStatus !== 'UNKNOWN' || closed.payrollValuation.feedEvidence?.status === 'CURRENT')
         throw Error('Synthetic SQLite without an as-of feed proof must remain UNKNOWN');
       await window.webContents.executeJavaScript(`window.renderPayrollFixture(${JSON.stringify(closed)})`);
      const frozen = await window.webContents.executeJavaScript(`(() => {
        const views = [...document.querySelectorAll('.excel-grid-container')];
        return { amount: views[0].textContent.includes('≈ 84'), net: views[1].textContent.includes('≈ 76'),
           closingRate: views[0].querySelector('thead [aria-label="Yopilish tarifi: 7"]')?.textContent === '7',
           noEditableRate: !views[0].querySelector('thead input'),
           qty: Number(views[0].querySelector('tbody tr.fast-row input')?.value) };
      })()`);
      console.log('LOCAL_CLOSED_UI ' + JSON.stringify(frozen));
       if (!frozen.amount || !frozen.net || !frozen.closingRate || !frozen.noEditableRate || frozen.qty !== 12) process.exitCode = 1;
       db.prepare("UPDATE period_archives SET archive_json=? WHERE company_id=? AND period_id='P'")
         .run(JSON.stringify({ ...closingP, models: [{ id: 'm', operations: [{ name: 'Sew', rate: 8 }] }] }), company);
       const tamperedArchive = readWorkbookPayrollProjection(db, company);
       if (tamperedArchive.payrollValuation.accountingStatus !== 'INCOMPLETE')
         throw Error('Archive bytes changed without the matching SHA-256 must be incomplete');
       await window.webContents.executeJavaScript(`window.renderPayrollFixture(${JSON.stringify(tamperedArchive)})`);
       const tampered = await window.webContents.executeJavaScript(`document.querySelector('.excel-grid-container tbody tr.fast-row td:nth-child(3)')?.textContent`);
       console.log('LOCAL_TAMPERED_ARCHIVE_UI ' + JSON.stringify({ operation: tampered }));
       if (tampered !== 'Noma’lum') process.exitCode = 1;
       db.prepare("DELETE FROM period_archives WHERE period_id='P' AND company_id=?").run(company);
      const incomplete = readWorkbookPayrollProjection(db, company);
      await window.webContents.executeJavaScript(`window.renderPayrollFixture(${JSON.stringify(incomplete)})`);
      const unknown = await window.webContents.executeJavaScript(`(() => {
        const views = [...document.querySelectorAll('.excel-grid-container')];
        return { operation: views[0].querySelector('tbody tr.fast-row td:nth-child(3)')?.textContent,
          price: views[1].textContent.includes('Noma’lum') };
      })()`);
      console.log('LOCAL_MISSING_ARCHIVE_UI ' + JSON.stringify(unknown));
       if (unknown.operation !== 'Noma’lum' || !unknown.price) process.exitCode = 1;
       const zeroArchiveData = { models: [{ id: 'm', operations: [{ name: 'Sew', rate: 0 }] }] };
       db.prepare(`INSERT INTO period_archives(company_id,period_id,archive_json,sha256,archived_at)
         VALUES (?,'P',?,?,?)`).run(company, JSON.stringify(zeroArchiveData), computePayloadHash(canonicalStringify(zeroArchiveData)), now);
      const zeroTariff = readWorkbookPayrollProjection(db, company);
      await window.webContents.executeJavaScript(`window.renderPayrollFixture(${JSON.stringify(zeroTariff)})`);
      const zero = await window.webContents.executeJavaScript(`(() => {
        const view = document.querySelector('.excel-grid-container');
        return { rate: view.querySelector('thead [aria-label="Yopilish tarifi: 0"]')?.textContent,
          locked: !view.querySelector('thead input') };
      })()`);
      console.log('LOCAL_ZERO_CLOSED_RATE_UI ' + JSON.stringify(zero));
      if (zero.rate !== '0' || !zero.locked) process.exitCode = 1;
      db.prepare("UPDATE periods SET is_closed=0,end_date=NULL WHERE id='P' AND company_id=?").run(company);
      db.prepare(`UPDATE models SET operations_json='[{"id":"sew","name":"Sew","rate":9}]' WHERE id='m' AND company_id=?`).run(company);
       db.prepare("UPDATE period_archives SET archive_json=?,sha256=?,archived_at=? WHERE company_id=? AND period_id='P'")
         .run(JSON.stringify(closingP), computePayloadHash(canonicalStringify(closingP)), now, company);
       const currentManagerData = readWorkbookPayrollProjection(db, company);
       const selectedValuation = require('../../../apps/desktop/electron/database/workbookPayrollRead.cjs')
        .readPeriodPayrollProjection(db, company, 'Q', closingArchive);
       if (currentManagerData.payrollValuation.workers[0].gross !== 108 || selectedValuation.workers[0].gross !== 84 || selectedValuation.workers[0].net !== 76) {
         throw Error('Period manager expected current 108 and selected closed 84/76');
       }
       const fixtureWindow = new BrowserWindow({ width: 1200, height: 850, show: false,
         webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
        await fixtureWindow.loadFile(path.join(outDir, 'scripts/verify/fixtures/payroll-display-fixture.html'));
       window.destroy();
       window = fixtureWindow;
       const archiveResponse = { success: true, companyId: company, periodId: 'Q', data: archivedData, payrollValuation: selectedValuation };
      await window.webContents.executeJavaScript(`window.renderPeriodManagerFixture(${JSON.stringify(currentManagerData)}, ${JSON.stringify(archiveResponse)})`);
      const currentKpi = await window.webContents.executeJavaScript(`(() => ({
        gross: document.body.textContent.includes('≈ 108'), net: document.body.textContent.includes('≈ 100'),
        status: [...document.querySelectorAll('[role=status]')].some(e => e.textContent.includes('Taxminiy'))
      }))()`);
      console.log('LOCAL_PERIOD_MANAGER_CURRENT_UI ' + JSON.stringify(currentKpi));
      if (!currentKpi.gross || !currentKpi.net || !currentKpi.status) process.exitCode = 1;
      await window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('Yopilgan Oylar Arxivi'))?.click())()`);
      await window.webContents.executeJavaScript(`new Promise(resolve => setTimeout(resolve, 60))`);
      await window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('Hisobni ko‘rish'))?.click())()`);
      await window.webContents.executeJavaScript(`new Promise(resolve => setTimeout(resolve, 100))`);
      const historyUi = await window.webContents.executeJavaScript(`(() => ({
        summary: document.querySelector('[data-period-summary="archive_Q.json"]')?.textContent || '',
        context: window.periodManagerContext()
      }))()`);
      console.log('LOCAL_PERIOD_MANAGER_HISTORY_UI ' + JSON.stringify(historyUi));
      if (!historyUi.summary.includes('≈ 84') || !historyUi.summary.includes('≈ 76')
        || historyUi.context.companyId !== company || historyUi.context.periodId !== 'P') process.exitCode = 1;
      const base64 = await window.webContents.executeJavaScript(`window.renderArchiveXlsx(${JSON.stringify({ ...archivedData, payrollValuation: selectedValuation })})`);
      const xlsxPath = path.join(fixtureRoot, 'period-Q-generated.xlsx');
      fsSync.writeFileSync(xlsxPath, Buffer.from(base64, 'base64'));
      try {
        const XLSX = require('xlsx-js-style');
        const reopened = XLSX.readFile(xlsxPath);
        const rows = XLSX.utils.sheet_to_json(reopened.Sheets['Q-hisob'], { header: 1, defval: '' });
        const summary = XLSX.utils.sheet_to_json(reopened.Sheets.Umumiy, { header: 1, defval: '' });
        const output = { rate: rows[1][2], qty: rows[2][3], amount: rows[2][2], totalQty: rows[3][3], total: rows[3][2], net: summary[2][2], gross: summary[2][6] };
        console.log('LOCAL_PERIOD_ARCHIVE_XLSX ' + JSON.stringify(output));
        if (output.rate !== 7 || output.qty !== 12 || output.amount !== 84 || output.totalQty !== 12 || output.total !== 84 || output.net !== 76 || output.gross !== 84) process.exitCode = 1;
      } finally { fsSync.unlinkSync(xlsxPath); }
      await window.webContents.executeJavaScript(`window.renderPeriodManagerFixture(${JSON.stringify(currentManagerData)}, { success: false, code: 'PERIOD_ARCHIVE_READ_FAILED' }, { success: false })`);
      await window.webContents.executeJavaScript(`new Promise(resolve => setTimeout(resolve, 80))`);
      const failedRead = await window.webContents.executeJavaScript(`({
        unknown: document.body.textContent.includes('Noma’lum'),
        summary: [...document.querySelectorAll('[role=status]')].map(e => e.textContent),
        amount: [...document.querySelectorAll('div')].find(e => e.textContent.includes('Jami hisoblangan'))?.parentElement?.textContent
      })`);
      console.log('LOCAL_PERIOD_MANAGER_FAILED_READ_UI ' + JSON.stringify(failedRead));
      if (!failedRead.unknown) process.exitCode = 1;
      await window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('Yopilgan Oylar Arxivi'))?.click())()`);
      await window.webContents.executeJavaScript(`new Promise(resolve => setTimeout(resolve, 40))`);
      await window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('Hisobni ko‘rish'))?.click())()`);
      await window.webContents.executeJavaScript(`new Promise(resolve => setTimeout(resolve, 50))`);
      const invalidArchive = await window.webContents.executeJavaScript(`({
        noStaleSummary: !document.querySelector('[data-period-summary]'),
        error: [...document.querySelectorAll('[role=status]')].some(e => e.textContent.includes('ishonchli o‘qib bo‘lmadi'))
      })`);
      console.log('LOCAL_PERIOD_MANAGER_INVALID_ARCHIVE_UI ' + JSON.stringify(invalidArchive));
      if (!invalidArchive.noStaleSummary || !invalidArchive.error) process.exitCode = 1;

      async function verifyWorkerDetail(tag, data, valuation, period, expected) {
        const detailData = JSON.parse(JSON.stringify(data));
        detailData.companyId = company;
        detailData.models[0].hisobQuantities = { 7: { Sew: 999 } };
        detailData.submittedTickets = (detailData.submittedTickets || []).filter(ticket => ticket.periodId === period.id);
        await window.webContents.executeJavaScript(`window.renderWorkerDetailFixture(${JSON.stringify(detailData)}, ${JSON.stringify(valuation)}, ${JSON.stringify(period)})`);
        await window.webContents.executeJavaScript(`new Promise(resolve => setTimeout(resolve, 60))`);
        const ui = await window.webContents.executeJavaScript(`({
          text: document.body.textContent,
           payrollRow: [...document.querySelectorAll('tbody tr')].find(row => row.textContent.includes('davr ish haqi'))?.textContent || '',
           auditOnly: document.body.textContent.includes('Ish haqiga qo‘shilmaydi')
        })`);
        if (!ui.text.includes(expected.gross) || !ui.text.includes(expected.net) || !ui.payrollRow.includes(String(expected.qty))
          || !ui.payrollRow.includes(String(expected.rate)) || ui.text.includes('999') || !ui.auditOnly) {
          console.error(`WORKER_DETAIL_${tag}_UI ` + JSON.stringify(ui)); process.exitCode = 1;
        } else console.log(`WORKER_DETAIL_${tag}_UI ` + JSON.stringify({ gross: expected.gross, net: expected.net, qty: expected.qty, rate: expected.rate, auditOnly: ui.auditOnly }));
        await window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('Excelga eksport'))?.click())()`);
        const csvText = await window.webContents.executeJavaScript(`window.readWorkerCsv()`);
        const parsed = parseCsv(csvText);
        const headerIndex = parsed.findIndex(row => row[0].replace(/^\uFEFF/, '') === 'Tur');
        const header = parsed[headerIndex];
        const payrollRow = parsed.slice(headerIndex + 1).find(row => row[0] === 'DAVR ISH HAQI');
         const auditRow = parsed.slice(headerIndex + 1).find(row => row[0].startsWith('PATTA MA’LUMOTI'));
        const csv = { header, payrollRow, auditRow, filename: await window.webContents.executeJavaScript('window.workerDetailContext().filename') };
        if (!payrollRow || payrollRow[11] !== String(expected.rate) || payrollRow[12] !== String(expected.qty)
          || payrollRow[13] !== String(expected.amount) || !auditRow || auditRow[11] !== '5' || auditRow[13] !== '') {
          console.error(`WORKER_DETAIL_${tag}_CSV ` + JSON.stringify(csv)); process.exitCode = 1;
        } else console.log(`WORKER_DETAIL_${tag}_CSV ` + JSON.stringify({ type: payrollRow[0], rate: payrollRow[11], qty: payrollRow[12], amount: payrollRow[13], auditRate: auditRow[11], auditAmount: auditRow[13], filename: csv.filename }));
        return { ui, csv };
      }
      await verifyWorkerDetail('OPEN', currentManagerData, currentManagerData.payrollValuation, currentManagerData.currentPeriod,
        { gross: '≈ 108', net: '≈ 100', qty: 12, rate: 9, amount: 108 });
      await verifyWorkerDetail('CLOSED', archivedData, selectedValuation, archivedData.period,
        { gross: '≈ 84', net: '≈ 76', qty: 12, rate: 7, amount: 84 });

      const failedValuation = { companyId: company, period: null, workers: [], accountingStatus: 'UNAVAILABLE',
        accountingReasons: ['PAYROLL_VALUATION_UNAVAILABLE'], syncStatus: 'UNKNOWN' };
      await window.webContents.executeJavaScript(`window.renderWorkerDetailFixture(${JSON.stringify(currentManagerData)}, ${JSON.stringify(failedValuation)}, ${JSON.stringify(currentManagerData.currentPeriod)})`);
      const failedWorker = await window.webContents.executeJavaScript(`document.body.textContent.includes('Hisoblangan Ish HaqiNoma’lum') && document.body.textContent.includes("Sof Foyda (Qo'lga)Noma’lum")`);
      console.log('WORKER_DETAIL_FAILED_READ ' + JSON.stringify({ unknown: failedWorker }));
      if (!failedWorker) process.exitCode = 1;
      await window.webContents.executeJavaScript(`window.renderWorkerDetailFixture(${JSON.stringify(currentManagerData)}, ${JSON.stringify(currentManagerData.payrollValuation)}, ${JSON.stringify({ ...currentManagerData.currentPeriod, id: 'wrong-period' })})`);
      const wrongPeriodDetail = await window.webContents.executeJavaScript(`document.body.textContent.includes('Hisoblangan Ish HaqiNoma’lum')`);
      console.log('WORKER_DETAIL_WRONG_PERIOD ' + JSON.stringify({ unknown: wrongPeriodDetail }));
      if (!wrongPeriodDetail) process.exitCode = 1;
      const wrongCompanyData = { ...currentManagerData, companyId: 'other-local-company' };
      await window.webContents.executeJavaScript(`window.renderWorkerDetailFixture(${JSON.stringify(wrongCompanyData)}, ${JSON.stringify(currentManagerData.payrollValuation)}, ${JSON.stringify(currentManagerData.currentPeriod)})`);
      const wrongCompanyDetail = await window.webContents.executeJavaScript(`document.body.textContent.includes('Hisoblangan Ish HaqiNoma’lum')`);
      console.log('WORKER_DETAIL_WRONG_COMPANY ' + JSON.stringify({ unknown: wrongCompanyDetail }));
      if (!wrongCompanyDetail) process.exitCode = 1;
      await window.webContents.executeJavaScript(`window.renderWorkerDetailFixture(${JSON.stringify(currentManagerData)}, ${JSON.stringify(currentManagerData.payrollValuation)}, ${JSON.stringify(currentManagerData.currentPeriod)}, 99)`);
      const wrongWorker = await window.webContents.executeJavaScript(`!document.querySelector('.modal-overlay')`);
      if (!wrongWorker) process.exitCode = 1;

      db.prepare('UPDATE models SET operations_json=? WHERE company_id=? AND id=?')
        .run(JSON.stringify([{ id: 'sew', name: 'Sew', rate: 7 }]), company, 'm');
      db.prepare(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,patta_number,qty,status,submitted_at,created_at,provenance)
        VALUES ('pending-detail',?,'m','P','1',3,3,'PENDING_SYNC',?,?,'LOCAL_COMMAND')`).run(company,now,now);
      db.prepare(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,qty,rate_snapshot,created_at)
        VALUES ('pending-detail-entry','pending-detail',?,'Sew',7,3,5,?)`).run(company,now);
      const pendingData = readWorkbookPayrollProjection(db, company);
      if (pendingData.payrollValuation.workers[0].gross !== 105) throw Error('Pending WorkerDetail fixture must be 105 from SQLite reader');
      await verifyWorkerDetail('PENDING105', pendingData, pendingData.payrollValuation, pendingData.currentPeriod,
        { gross: '≈ 105', net: '≈ 97', qty: 15, rate: 7, amount: 105 });
      db.prepare("UPDATE tickets SET status='CONFIRMED' WHERE company_id=? AND id='pending-detail'").run(company);
      const acceptedData = readWorkbookPayrollProjection(db, company);
      if (acceptedData.payrollValuation.workers[0].gross !== 105) throw Error('Accepted LOCAL WorkerDetail fact must remain exactly once');
      await verifyWorkerDetail('ACCEPTED_LOCAL105', acceptedData, acceptedData.payrollValuation, acceptedData.currentPeriod,
        { gross: '≈ 105', net: '≈ 97', qty: 15, rate: 7, amount: 105 });

      db.prepare("DELETE FROM period_archives WHERE company_id=? AND period_id='Q'").run(company);
       const missingArchive = require('../../../apps/desktop/electron/database/workbookPayrollRead.cjs')
        .readPeriodPayrollProjection(db, company, 'Q', null);
      await window.webContents.executeJavaScript(`window.renderWorkerDetailFixture(${JSON.stringify(archivedData)}, ${JSON.stringify(missingArchive)}, ${JSON.stringify(archivedData.period)})`);
      const missingRateUi = await window.webContents.executeJavaScript(`({ unknown: document.body.textContent.includes('Hisoblangan Ish HaqiNoma’lum'),
         line: [...document.querySelectorAll('tbody tr')].find(row => row.textContent.includes('davr ish haqi'))?.textContent || '' })`);
      console.log('WORKER_DETAIL_MISSING_ARCHIVE ' + JSON.stringify(missingRateUi));
      if (!missingRateUi.unknown || !missingRateUi.line.includes('Noma’lum')) process.exitCode = 1;
      const zeroArchive = { ...archivedData, models: [{ id: 'm', operations: [{ name: 'Sew', rate: 0 }] }] };
       const zeroValuation = require('../../../apps/desktop/electron/database/workbookPayrollRead.cjs')
        .readPeriodPayrollProjection(db, company, 'Q', zeroArchive);
      await verifyWorkerDetail('ZERO', archivedData, zeroValuation, archivedData.period,
        { gross: '≈ 0', net: '≈ -8', qty: 12, rate: 0, amount: 0 });

      db.prepare(`INSERT INTO periods(id,company_id,name,start_date,end_date,is_closed,created_at)
        VALUES ('T',?,'Captured audit','2026-07-01','2026-07-31',1,?)`).run(company,now);
      for (const item of [
        { id: 'cv-known', party: 'known', qty: 10, rate: 5 },
        { id: 'cv-zero', party: 'zero', qty: 3, rate: 0 },
        { id: 'cv-missing', party: 'missing', qty: 2, rate: null }
      ]) {
        db.prepare(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,patta_number,qty,status,submitted_at,created_at,provenance,konveyer)
          VALUES (?,?,'m','T',?,1,?,'CONFIRMED',?,?,'REMOTE_SYNC','Test')`).run(item.id,company,item.party,item.qty,now,now);
        db.prepare(`INSERT INTO ticket_entries(id,ticket_id,company_id,op_name,worker_id,qty,rate_snapshot,created_at)
          VALUES (?,?,?,'Sew',7,?,?,?)`).run(`${item.id}-entry`,item.id,company,item.qty,item.rate,now);
      }
        db.prepare(`INSERT INTO production_adjustments(adjustment_id,company_id,model_id,worker_id,op_name,
          delta_qty,reason,status,provenance,created_at,created_by,original_ticket_id,original_entry_id,
          original_period_id,attribution_status)
          VALUES ('t-plus',?,'m',7,'Sew',2,'fixture','APPROVED','REMOTE_SYNC',?,'test','cv-known','cv-known-entry','T','RESOLVED')`).run(company,now);
        const sourceFacts = require('../../../apps/desktop/electron/database/projectionReader.cjs')
         .loadTicketFactsFromSqlite(db, company, { id: 'T', startDate: '2026-07-01', endDate: '2026-07-31' });
       const capturedTickets = sourceFacts.map(ticket => ({ ...ticket, id: ticket.ticketId, periodId: ticket.periodId }));
        const tArchive = { companyId: company,
          period: { id: 'T', name: 'Captured audit', startDate: '2026-07-01', endDate: '2026-07-31', isClosed: true },
          models: [{ id: 'm', name: 'Demo', operations: [{ name: 'Sew', rate: 7 }] }],
          workers: [{ id: 7, name: 'Demo worker', staj: 1, avans: 0, jarima: 0 }] };
        db.prepare(`INSERT INTO period_archives(company_id,period_id,archive_json,sha256,archived_at)
          VALUES (?,?,?,?,?)`).run(company, 'T', canonicalStringify(tArchive), computePayloadHash(canonicalStringify(tArchive)), now);
         const tValuation = require('../../../apps/desktop/electron/database/workbookPayrollRead.cjs')
          .readPeriodPayrollProjection(db, company, 'T', tArchive);
        if (tValuation.workers[0].gross !== 119) throw Error('Conveyor period gross must include original-period correction');
       await window.webContents.executeJavaScript(`window.renderKonveyerFixture(${JSON.stringify({
         companyId: company, currentPeriod: { id: 'T', name: 'Captured audit', startDate: '2026-07-01', isClosed: true },
         models: currentManagerData.models, workers: currentManagerData.workers, submittedTickets: capturedTickets,
         payrollValuation: tValuation
       })})`);
       const conveyorKpi = await window.webContents.executeJavaScript(`({
         label: document.body.textContent.includes('Davr bo‘yicha jami hisoblangan ish haqi'),
          gross: document.body.textContent.includes('≈ 119')
       })`);
      await window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('Pattalar Ro'))?.click())()`);
      const conveyorRows = await window.webContents.executeJavaScript(`document.body.textContent`);
       console.log('KONVEYER_PERIOD_WAGE_UI ' + JSON.stringify({ ...conveyorKpi,
         ticketBase: conveyorRows.includes('70 so‘m'), capturedKnown: conveyorRows.includes('50 so‘m'),
         capturedZero: conveyorRows.includes('Saqlangan tarif bo‘yicha: 0 so‘m'),
         capturedMissing: conveyorRows.includes('Saqlangan tarif bo‘yicha: Noma’lum') }));
      if (!conveyorKpi.label || !conveyorKpi.gross || !conveyorRows.includes('70 so‘m') || !conveyorRows.includes('50 so‘m')
        || !conveyorRows.includes('Saqlangan tarif bo‘yicha: 0 so‘m')
        || !conveyorRows.includes('Saqlangan tarif bo‘yicha: Noma’lum')) process.exitCode = 1;
       await window.webContents.executeJavaScript(`window.renderKonveyerFixture(${JSON.stringify({
         companyId: 'wrong-company', currentPeriod: { id: 'T', name: 'T', isClosed: true },
         models: currentManagerData.models, workers: currentManagerData.workers, submittedTickets: capturedTickets,
         payrollValuation: tValuation
       })})`);
       const wrongConveyor = await window.webContents.executeJavaScript(`document.body.textContent.includes('Noma’lum so‘m') && !document.body.textContent.includes('≈ 119')`);
       if (!wrongConveyor) process.exitCode = 1;
      await window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('Excel (CSV) Eksport'))?.click())()`);
      const conveyorCsv = await window.webContents.executeJavaScript(`window.readWorkerCsv()`);
      const conveyorCsvRows = parseCsv(conveyorCsv);
       const conveyorCsvHeader = conveyorCsvRows[0].map(cell => cell.replace(/^\uFEFF/, '')).join('|');
       console.log('KONVEYER_QUANTITY_CSV ' + JSON.stringify({ header: conveyorCsvHeader }));
       if (conveyorCsvHeader.toLowerCase().includes('summa') || conveyorCsvHeader.toLowerCase().includes('ish haqi')) process.exitCode = 1;
      }
    } catch (error) { console.error(error); process.exitCode = 1; }
     finally { if (db.open && db.inTransaction) db.exec('ROLLBACK'); manager.closeAllCompanyDatabases(); window.destroy(); app.quit(); }
  }).catch(error => { console.error(error); app.quit(); process.exitCode = 1; });
} else {
  (async () => {
    const underLocalDbRoot = target => target === localDbRoot || target.startsWith(localDbRoot + path.sep);
    if (!underLocalDbRoot(outDir) || !underLocalDbRoot(fixtureRoot)) throw Error('Unsafe output directory');
    const { build } = await import('vite');
    await build({ configFile: false, root, base: './', logLevel: 'error',
      build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(__dirname, '..', 'fixtures', 'payroll-display-fixture.html') } } });
     const safeEnv = { ...process.env, PAYROLL_RENDER_CHILD: '1' };
    if (process.env.MODEL_SIZES_C_ONLY === '1') {
      safeEnv.MODEL_SIZES_C_FIXTURE_ROOT = fixtureRoot;
      safeEnv.MODEL_SIZES_C_RENDER_DIR = outDir;
    }
    if (process.env.FILTERS_2C_ONLY === '1' || process.env.FILTERS_2D_ONLY === '1' || process.env.FILTERS_2G_ONLY === '1' || process.env.PATTA_JUMP_ONLY === '1') {
      safeEnv.FILTERS_FIXTURE_ROOT = fixtureRoot;
      safeEnv.FILTERS_RENDER_DIR = outDir;
    }
    if (process.env.FILTERS_2A_ACTOR_STORAGE_ONLY === '1') {
      safeEnv.FILTERS_FIXTURE_ROOT = fixtureRoot;
      safeEnv.FILTERS_RENDER_DIR = outDir;
    }
    if (process.env.FILTERS_2D_ONLY === '1') safeEnv.FILTERS_2D_ONLY = '1';
    if (process.env.FILTERS_2A_ONLY === '1') safeEnv.FILTERS_2A_ONLY = '1';
    if (process.env.FILTERS_2A_ACTOR_STORAGE_ONLY === '1') safeEnv.FILTERS_2A_ACTOR_STORAGE_ONLY = '1';
          if (process.env.MODEL_SIZES_C_ONLY === '1' && process.env.PAYROLL_RENDER_CHILD === '1') {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            const waitFor = async (predicate, label, timeout = 20000) => {
              const until = Date.now() + timeout;
              while (Date.now() < until) { if (await predicate()) return; await wait(60); }
              throw Error(`model sizes C timeout: ${label}`);
            };
            const setup = await window.webContents.executeJavaScript('window.renderModelSizesCApp()');
            if (setup.modelIds.join(',') !== 'm,model-sizes-c-b' || setup.periodClosed || setup.archive)
              throw Error('Stage C isolated fixture context/model setup mismatch ' + JSON.stringify(setup));
            window.setSize(1440, 1100); window.show(); window.focus();
            await waitFor(() => window.webContents.executeJavaScript(`document.querySelectorAll('.e2b-batch-card').length===2`), 'production App Patta cards');
            await window.webContents.executeJavaScript(`window.__modelSizesCAuth.getState().setAuth({status:'active',role:'type',companyId:'hisob_test_browser',permissions:['view:umumiy','edit:hisob']})`);
            await wait(100);
            const typeDenied = await window.webContents.executeJavaScript(`document.querySelectorAll('.e2b-batch-card').length===0 && document.body.innerText.includes('faqat Admin')`);
            await window.webContents.executeJavaScript(`window.__modelSizesCAuth.getState().setAuth({status:'active',role:'admin',companyId:'hisob_test_browser',permissions:['view:umumiy','view:patta','edit:hisob']})`); await wait(100);
            if(!typeDenied) throw Error('Production App type role did not deny batch-card access');
            const wrongCompany = await window.webContents.executeJavaScript(`window.electronAPI.WorkbookCommand({companyId:'model-sizes-c-other-company',commandType:'UpdateBatchSettings',operationId:'model-sizes-c-wrong-company',entityId:'model-sizes-c-other-company',payload:{availableSizes:[],configs:[]}})`);
            if(wrongCompany.success!==false||wrongCompany.code!=='MODEL_SIZES_FIXTURE_SCOPE') throw Error('Stage C IPC fixture failed to reject wrong company command '+JSON.stringify(wrongCompany));
            const initialBConfig = await window.webContents.executeJavaScript(`JSON.stringify(window.__modelSizesCStore.getState().pattaBatchConfigs['model-sizes-c-b'])`);
            const shotDir = path.join(root,'.opencode/deep-audit/output/post-redesign-model-sizes-c-screenshots',path.basename(fixtureRoot));
            fsSync.mkdirSync(shotDir,{recursive:true});
            const card = id => `document.querySelector('.e2b-batch-card[data-model-id="${id}"]')`;
            const setInput = async (selector, value) => window.webContents.executeJavaScript(`(()=>{const i=${selector};if(!i)throw Error('missing input '+${JSON.stringify(selector)});const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(i,${JSON.stringify(String(value))});i.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(String(value))}}));i.dispatchEvent(new Event('change',{bubbles:true}));})()`);
            const clickInCard = async (id, text) => window.webContents.executeJavaScript(`(()=>{const c=${card(id)};const b=[...c.querySelectorAll('button')].find(x=>x.innerText.includes(${JSON.stringify(text)}));if(!b)throw Error('missing card button '+${JSON.stringify(text)});b.click()})()`);
            const addName = async (id, name) => {
              await clickInCard(id, "Razmer qo'shish"); await wait(40);
              await setInput(`document.querySelector('.modal-card input[type=text]')`, name);
              await window.webContents.executeJavaScript(`document.querySelector('.modal-card form button[type=submit]')?.click()`);
              await wait(120);
            };
            const rowNames = id => window.webContents.executeJavaScript(`(()=>[...${card(id)}.querySelectorAll('.e2b-size-cell')].map(r=>r.querySelector('span')?.innerText.trim()).filter(Boolean))()`);
            const setCount = async (id, size, value) => setInput(`(() => [...${card(id)}.querySelectorAll('.e2b-size-cell')].find(r=>r.querySelector('span')?.innerText.trim()==${JSON.stringify(size)})?.querySelector('input'))()`, value);
            await addName('m','XXL');
            if (!(await rowNames('m')).includes('XXL') || (await rowNames('model-sizes-c-b')).includes('XXL')) throw Error('Add XXL was not isolated to model A');
            if (initialBConfig!==await window.webContents.executeJavaScript(`JSON.stringify(window.__modelSizesCStore.getState().pattaBatchConfigs['model-sizes-c-b'])`))
              throw Error('Adding a custom row to A changed B config bytes');
            await addName('m','M');
            if ((await rowNames('m')).filter(x=>x==='M').length!==1) throw Error('Duplicate size name was accepted on model A');
            await addName('m','TEMP');
            await window.webContents.executeJavaScript(`(()=>{window.__oldPrompt=window.prompt;window.prompt=()=> 'TEMP2';${card('m')}.querySelector('[aria-label="TEMP razmerini nomlash"]').click();window.prompt=window.__oldPrompt})()`);
            if (!(await rowNames('m')).includes('TEMP2') || (await rowNames('m')).includes('TEMP')) throw Error('Empty custom size rename failed');
            await window.webContents.executeJavaScript(`(()=>${card('m')}.querySelector('[title="«TEMP2» razmerini o\'chirish"]').click())()`);
            await waitFor(() => window.webContents.executeJavaScript(`Boolean(document.querySelector('.confirm-modal')||document.body.innerText.includes('TEMP2'))`), 'remove confirmation');
            await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('button')].find(b=>b.innerText.includes("o'chirilsin"))?.click())()`); await wait(100);
            if ((await rowNames('m')).includes('TEMP2')) throw Error('Empty custom size removal failed');
            await setCount('m','XXL','2');
            await window.webContents.executeJavaScript(`(()=>${card('m')}.querySelector('[title="«XXL» razmerini o\'chirish"]').click())()`);
            await wait(40);
            await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('button')].find(b=>b.innerText.includes("o'chirilsin"))?.click())()`); await wait(100);
            const positiveRemove = await window.webContents.executeJavaScript(`({row:${card('m')}.innerText.includes('XXL'),count:[...${card('m')}.querySelectorAll('.e2b-size-cell')].find(r=>r.querySelector('span')?.innerText.trim()==='XXL')?.querySelector('input')?.value})`);
            if (!positiveRemove.row || positiveRemove.count!=='2') throw Error('Positive count was silently dropped on removal '+JSON.stringify(positiveRemove));
            await setCount('m','M','1'); await setCount('model-sizes-c-b','L','1');
            await setInput(`document.querySelector(${card('m')}+' .e2b-batch-work input')`,'10');
            await setInput(`document.querySelector(${card('model-sizes-c-b')}+' .e2b-batch-work input')`,'20');
            const beforeToggle = await rowNames('m');
            await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('[role=group][aria-label="Razmer turi"] button')].find(b=>b.innerText.includes('Raqamli'))?.click())()`); await wait(60);
            const numericRows = await rowNames('m');
            await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('[role=group][aria-label="Razmer turi"] button')].find(b=>b.innerText.includes('Harfli'))?.click())()`); await wait(60);
            if (!numericRows.some(x=>/^\d/.test(x)) || !(await rowNames('m')).includes('XXL') || !beforeToggle.includes('M')) throw Error('Size system toggle failed to preserve owned names');
            const keyboard = await window.webContents.executeJavaScript(`(()=>{const i=${card('m')}.querySelector('.e2b-batch-work input');i.focus();i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return document.activeElement===${card('m')}.querySelector('.e2b-batch-party input')})()`);
            if (!keyboard) throw Error('Card keyboard Enter navigation failed');
            const totals = await window.webContents.executeJavaScript(`(()=>({cards:[...document.querySelectorAll('.e2b-batch-card')].map(c=>({id:c.dataset.modelId,text:c.innerText})),print:[...document.querySelectorAll('button')].find(b=>b.innerText.includes('Pechat ('))?.innerText}))()`);
            if (!String(totals.print).includes('4 ta')) throw Error('Expected total 4 pattas, got '+JSON.stringify(totals));
            const configBefore = await window.webContents.executeJavaScript(`JSON.stringify(window.__modelSizesCStore.getState().pattaBatchConfigs)`);
            await waitFor(() => db.prepare('SELECT COUNT(*) AS n FROM patta_batch_settings WHERE company_id=?').get('hisob_test_browser').n > 0, 'canonical SQLite batch settings');
            manager.closeAllCompanyDatabases(); db = manager.getCompanyDatabase(fixtureRoot, 'hisob_test_browser');
            const settingsRow = db.prepare('SELECT * FROM patta_batch_settings WHERE company_id=?').get('hisob_test_browser');
            const initialProjection = readWorkbookPayrollProjection(db,'hisob_test_browser');
            const savedConfigs = initialProjection.pattaBatchConfigs || {};
            if (!savedConfigs.m || !savedConfigs['model-sizes-c-b']) throw Error('Canonical projection missing one model configuration '+JSON.stringify({settingsRow,savedConfigs}));
            if(savedConfigs.m.sizes.M!=='1'||savedConfigs.m.sizes.XXL!=='2'||!savedConfigs.m.sizeNames.includes('XXL')
              ||savedConfigs['model-sizes-c-b'].sizes.L!=='1'||savedConfigs['model-sizes-c-b'].sizeNames.includes('XXL'))
              throw Error('Fresh SQLite saved A/B configs/counts mismatch '+JSON.stringify(savedConfigs));
            const rendererReopen = await window.webContents.executeJavaScript('window.reloadModelSizesC()');
            if(rendererReopen.configs.m.sizes.M!=='1'||rendererReopen.configs.m.sizes.XXL!=='2'
              ||rendererReopen.configs['model-sizes-c-b'].sizes.L!=='1'||rendererReopen.configs['model-sizes-c-b'].sizeNames.includes('XXL'))
              throw Error('Renderer re-open projection lost or cross-contaminated A/B settings '+JSON.stringify(rendererReopen));
            const storedA = JSON.stringify(savedConfigs.m), storedBNames = JSON.stringify(savedConfigs['model-sizes-c-b'].sizeNames);
            fsSync.writeFileSync(path.join(shotDir,'before-print.png'),(await window.webContents.capturePage()).toPNG());
            await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('button')].find(b=>b.innerText.includes('Pechat (4 ta patta)'))?.click())()`);
            await waitFor(() => window.webContents.executeJavaScript(`document.querySelector('.phase-c-print-preview')?.innerText.includes('4 ta patta')`), 'actual print preview');
            const preview = await window.webContents.executeJavaScript(`(()=>({text:document.querySelector('.phase-c-print-preview')?.innerText, tickets:[...document.querySelectorAll('#printable-patta-area .print-ticket-box')].map(e=>e.innerText)}))()`);
            if (preview.tickets.length!==4 || !preview.tickets.some(t=>t.includes('Demo')&&t.includes('M')&&t.includes('10'))
              || preview.tickets.filter(t=>t.includes('XXL')).length!==2 || !preview.tickets.some(t=>t.includes('Jacket B')&&t.includes('L')&&t.includes('20')))
              throw Error('Actual print modal ticket rows mismatch '+JSON.stringify(preview));
            fsSync.writeFileSync(path.join(shotDir,'print-preview.png'),(await window.webContents.capturePage()).toPNG());
            await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('button')].find(b=>b.innerText.includes('Pechat qilish (4 ta patta)'))?.click())()`);
            await waitFor(()=>fsSync.existsSync(path.join(outDir,'generated-patta-stage-c.html')),'generated Patta HTML');
            const html=fsSync.readFileSync(path.join(outDir,'generated-patta-stage-c.html'),'utf8');
            const htmlDoc = await window.webContents.executeJavaScript(`(()=>{const d=new DOMParser().parseFromString(${JSON.stringify(html)},'text/html');return [...d.querySelectorAll('.print-ticket-box')].map(e=>e.innerText)})()`);
            if(htmlDoc.length!==4||htmlDoc.filter(t=>t.includes('XXL')).length!==2||!htmlDoc.some(t=>t.includes('Jacket B')&&t.includes('L')&&t.includes('20')))
              throw Error('Generated print HTML ticket details mismatch '+JSON.stringify(htmlDoc));
            await waitFor(()=>db.prepare('SELECT COUNT(*) AS n FROM parties WHERE company_id=?').get('hisob_test_browser').n===2,'canonical CompletePattaBatch parties');
            const persistedParties = db.prepare('SELECT id,model_id,party_number,patta_count,patta_start_number,patta_end_number,sizes_json,size_order_json,total_ish_soni FROM parties WHERE company_id=? ORDER BY model_id').all('hisob_test_browser');
            const resetProjection = readWorkbookPayrollProjection(db,'hisob_test_browser');
            const resetConfigs = resetProjection.pattaBatchConfigs || {};
            if(persistedParties.some(p=>!p.size_order_json)||JSON.parse(persistedParties.find(p=>p.model_id==='m').size_order_json).join(',')!=='M,XXL'
              ||JSON.parse(persistedParties.find(p=>p.model_id==='model-sizes-c-b').size_order_json).join(',')!=='L'
              ||resetConfigs.m.sizes.M!==''||resetConfigs.m.sizes.XXL!==''||resetConfigs.m.sizeNames.indexOf('XXL')<0
              ||persistedParties.find(p=>p.model_id==='m').total_ish_soni!==30
              ||persistedParties.find(p=>p.model_id==='model-sizes-c-b').total_ish_soni!==20
              ||persistedParties.find(p=>p.model_id==='m').patta_start_number!==1
              ||persistedParties.find(p=>p.model_id==='m').patta_end_number!==3
              ||persistedParties.find(p=>p.model_id==='model-sizes-c-b').patta_start_number!==4
              ||persistedParties.find(p=>p.model_id==='model-sizes-c-b').patta_end_number!==4)
              throw Error('Canonical print party order/count reset/definition mismatch '+JSON.stringify({persistedParties,resetConfigs}));
            if(storedBNames!==JSON.stringify(resetConfigs['model-sizes-c-b'].sizeNames)
              ||resetConfigs['model-sizes-c-b'].sizes.L!=='') throw Error('Printing/reset changed model B definition or failed to reset its count');
            const oldParty = JSON.stringify(persistedParties.find(p=>p.model_id==='m'));
            await window.webContents.executeJavaScript(`window.__modelSizesCStore.getState().updatePattaBatchConfig('m',{sizeNames:['S','M','L','XL','XXL','LATER']})`);
            await waitFor(()=>db.prepare('SELECT COUNT(*) AS n FROM patta_batch_settings WHERE company_id=?').get('hisob_test_browser').n>0,'later A edit persisted');
            if(oldParty!==JSON.stringify(db.prepare('SELECT id,model_id,party_number,patta_count,patta_start_number,patta_end_number,sizes_json,size_order_json,total_ish_soni FROM parties WHERE company_id=? AND model_id=\'m\'').get('hisob_test_browser')))
              throw Error('Later A size edit mutated immutable printed party/ticket slots');
            const evidence={fixtureRoot,outDir,setup,initialBConfig,rendererReopen,settingsRow,configBefore,savedConfigs,storedA,storedBNames,totals,keyboard,numericRows,preview,htmlDoc,persistedParties,resetConfigs,oldParty,screenshots:shotDir,htmlPath:path.join(outDir,'generated-patta-stage-c.html')};
            fsSync.writeFileSync(path.join(shotDir,'evidence.json'),JSON.stringify(evidence,null,2));
            console.log('MODEL_SIZES_C_PARTIAL_PASS '+JSON.stringify(evidence)); return;
          }
           if (process.env.MODEL_SIZES_C_ONLY === '1' && process.env.PAYROLL_RENDER_CHILD === '1') {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            const waitFor = async (predicate, label) => { const end=Date.now()+25000; while(Date.now()<end){if(await predicate())return;await wait(60)} throw Error('model sizes C timeout: '+label); };
            const setup=await window.webContents.executeJavaScript('window.renderModelSizesCApp()');
            if(setup.modelIds.join(',')!=='m,model-sizes-c-b'||setup.periodClosed||setup.archive) throw Error('fresh current-period fixture guard/context '+JSON.stringify(setup));
            window.setSize(1440,1100);window.show();window.focus();
            await waitFor(()=>window.webContents.executeJavaScript(`document.querySelectorAll('.e2b-batch-card').length===2`),'App Patta cards');
            const shots=path.join(root,'.opencode/deep-audit/output/post-redesign-model-sizes-c-screenshots',path.basename(fixtureRoot));fsSync.mkdirSync(shots,{recursive:true});
            const card=id=>`document.querySelector('.e2b-batch-card[data-model-id="${id}"]')`;
            const ev=js=>window.webContents.executeJavaScript(js);
            const setInput=(selector,value)=>ev(`(()=>{const i=${selector};if(!i)throw Error('Missing input '+${JSON.stringify(selector)});const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,${JSON.stringify(String(value))});i.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(String(value))}}));i.dispatchEvent(new Event('change',{bubbles:true}))})()`);
            const names=id=>ev(`(()=>[...${card(id)}.querySelectorAll('.e2b-size-cell span')].map(e=>e.innerText.trim()))()`);
            const add=async(id,name)=>{await ev(`(()=>[...${card(id)}.querySelectorAll('button')].find(b=>b.innerText.includes("Razmer qo'shish"))?.click())()`);await wait(30);await setInput(`document.querySelector('.modal-card input[type=text]')`,name);await ev(`document.querySelector('.modal-card form button[type=submit]')?.click()`);await wait(100)};
            const qty=async(id,size,n)=>setInput(`(()=>[...${card(id)}.querySelectorAll('.e2b-size-cell')].find(r=>r.querySelector('span')?.innerText.trim()==${JSON.stringify(size)})?.querySelector('input'))()`,n);
            const initialB=JSON.stringify(await ev(`window.__modelSizesCStore.getState().pattaBatchConfigs['model-sizes-c-b']`));
            await add('m','XXL');if(!(await names('m')).includes('XXL')||(await names('model-sizes-c-b')).includes('XXL'))throw Error('XXL add cross-model isolation failure');
            if(initialB!==JSON.stringify(await ev(`window.__modelSizesCStore.getState().pattaBatchConfigs['model-sizes-c-b']`)))throw Error('A add changed B config');
            await add('m','M');if((await names('m')).filter(n=>n==='M').length!==1)throw Error('duplicate M accepted');
            await add('m','TEMP');await ev(`(()=>{window.__oldPrompt=window.prompt;window.prompt=()=> 'TEMP2';${card('m')}.querySelector('[aria-label="TEMP razmerini nomlash"]').click();window.prompt=window.__oldPrompt})()`);
            if(!(await names('m')).includes('TEMP2'))throw Error('empty row rename failed');
            await ev(`(()=>${card('m')}.querySelector('[title^="«TEMP2»"]').click())()`);await wait(40);await ev(`(()=>[...document.querySelectorAll('button')].find(b=>b.innerText.includes("o'chirilsin"))?.click())()`);await wait(100);
            if((await names('m')).includes('TEMP2'))throw Error('empty row removal failed');
            await qty('m','XXL','2');await ev(`(()=>${card('m')}.querySelector('[title^="«XXL»"]').click())()`);await wait(40);await ev(`(()=>[...document.querySelectorAll('button')].find(b=>b.innerText.includes("o'chirilsin"))?.click())()`);await wait(80);
            const positive=await ev(`(()=>[...${card('m')}.querySelectorAll('.e2b-size-cell')].find(r=>r.querySelector('span')?.innerText.trim()==='XXL')?.querySelector('input')?.value)()`);if(positive!=='2')throw Error('positive count removed '+positive);
            await qty('m','M','1');await qty('model-sizes-c-b','L','1');await setInput(`document.querySelector(${card('m')}+' .e2b-batch-work input')`,'10');await setInput(`document.querySelector(${card('model-sizes-c-b')}+' .e2b-batch-work input')`,'20');
            const keyboard=await ev(`(()=>{const i=${card('m')}.querySelector('.e2b-batch-work input');i.focus();i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return document.activeElement===${card('m')}.querySelector('.e2b-batch-party input')})()`);if(!keyboard)throw Error('Patta keyboard navigation failure');
            await ev(`(()=>[...document.querySelectorAll('[role=group][aria-label="Razmer turi"] button')].find(b=>b.innerText.includes('Raqamli'))?.click())()`);await wait(50);const numeric=await names('m');await ev(`(()=>[...document.querySelectorAll('[role=group][aria-label="Razmer turi"] button')].find(b=>b.innerText.includes('Harfli'))?.click())()`);await wait(50);if(!numeric.some(n=>/^\d/.test(n))||!(await names('m')).includes('XXL'))throw Error('letter/numeric toggle failed');
            const total=await ev(`([...document.querySelectorAll('button')].find(b=>b.innerText.includes('Pechat ('))||{}).innerText`);if(!total.includes('4 ta'))throw Error('wrong per-card total '+total);
            await waitFor(()=>db.prepare('SELECT COUNT(*) n FROM patta_batch_settings WHERE company_id=?').get('hisob_test_browser').n===2,'settings canonical write');
            manager.closeAllCompanyDatabases();db=manager.getCompanyDatabase(fixtureRoot,'hisob_test_browser');const projection=readWorkbookPayrollProjection(db,'hisob_test_browser'),cfg=projection.pattaBatchConfigs;
            if(cfg.m.sizes.M!=='1'||cfg.m.sizes.XXL!=='2'||cfg['model-sizes-c-b'].sizes.L!=='1'||cfg['model-sizes-c-b'].sizeNames?.includes('XXL'))throw Error('SQLite save/reopen A/B values mismatch '+JSON.stringify(cfg));
            const reload=await ev('window.reloadModelSizesC()');if(reload.configs.m.sizes.XXL!=='2'||reload.configs['model-sizes-c-b'].sizes.L!=='1')throw Error('renderer projection reopen mismatch');
            fsSync.writeFileSync(path.join(shots,'before-print.png'),(await window.webContents.capturePage()).toPNG());
            await ev(`(()=>[...document.querySelectorAll('button')].find(b=>b.innerText.includes('Pechat (4 ta patta)'))?.click())()`);await waitFor(()=>ev(`Boolean(document.querySelector('#printable-patta-area .print-ticket-box'))`),'Patta print preview');
            const preview=await ev(`(()=>[...document.querySelectorAll('#printable-patta-area .print-ticket-box')].map(e=>e.innerText))()`);if(preview.length!==4||preview.filter(t=>t.includes('XXL')).length!==2||!preview.some(t=>t.includes('Jacket B')&&t.includes('L')&&t.includes('20')))throw Error('preview ticket mapping mismatch '+JSON.stringify(preview));
            fsSync.writeFileSync(path.join(shots,'print-preview.png'),(await window.webContents.capturePage()).toPNG());
            await ev(`(()=>[...document.querySelectorAll('button')].find(b=>b.innerText.includes('Pechat qilish (4 ta patta)'))?.click())()`);await waitFor(()=>fsSync.existsSync(path.join(outDir,'generated-patta-stage-c.html')),'print HTML output');
            const html=fsSync.readFileSync(path.join(outDir,'generated-patta-stage-c.html'),'utf8');const htmlTickets=await ev(`(()=>{const d=new DOMParser().parseFromString(${JSON.stringify(html)},'text/html');return [...d.querySelectorAll('.print-ticket-box')].map(x=>x.innerText)})()`);
            if(htmlTickets.length!==4||htmlTickets.filter(t=>t.includes('XXL')).length!==2||!htmlTickets.some(t=>t.includes('Jacket B')&&t.includes('L')&&t.includes('20')))throw Error('generated HTML ticket mismatch '+JSON.stringify(htmlTickets));
            await waitFor(()=>db.prepare('SELECT COUNT(*) n FROM parties WHERE company_id=?').get('hisob_test_browser').n===2,'CompletePattaBatch party writes');
            const parties=db.prepare('SELECT id,model_id,party_number,patta_count,patta_start_number,patta_end_number,sizes_json,size_order_json,total_ish_soni FROM parties WHERE company_id=? ORDER BY model_id').all('hisob_test_browser');
            const reset=readWorkbookPayrollProjection(db,'hisob_test_browser').pattaBatchConfigs;
            if(JSON.parse(parties[0].size_order_json).join(',')!=='M,XXL'||JSON.parse(parties[1].size_order_json).join(',')!=='L'||parties[0].patta_start_number!==1||parties[0].patta_end_number!==3||parties[1].patta_start_number!==4||parties[1].patta_end_number!==4||parties[0].total_ish_soni!==30||parties[1].total_ish_soni!==20||reset.m.sizes.XXL!==''||!reset.m.sizeNames.includes('XXL'))throw Error('canonical party order/range/work/reset mismatch '+JSON.stringify({parties,reset}));
            const oldParty=JSON.stringify(parties[0]);await ev(`window.__modelSizesCStore.getState().updatePattaBatchConfig('m',{sizeNames:[...window.__modelSizesCStore.getState().pattaBatchConfigs.m.sizeNames,'LATER']})`);await wait(1300);
            if(oldParty!==JSON.stringify(db.prepare("SELECT id,model_id,party_number,patta_count,patta_start_number,patta_end_number,sizes_json,size_order_json,total_ish_soni FROM parties WHERE company_id=? AND model_id='m'").get('hisob_test_browser')))throw Error('later A edit mutated printed party size order/identity');
            const outbox=db.prepare("SELECT command_type,status FROM local_outbox WHERE company_id=? AND command_type IN ('UpdateBatchSettings','CompletePattaBatch')").all('hisob_test_browser');
            if(!outbox.some(r=>r.command_type==='UpdateBatchSettings')||!outbox.some(r=>r.command_type==='CompletePattaBatch'))throw Error('canonical outbox records missing '+JSON.stringify(outbox));
            const evidence={fixtureRoot,outDir,setup,initialB,keyboard,numeric,total,reload,preview,htmlTickets,parties,reset,outbox,screenshots:shots,htmlPath:path.join(outDir,'generated-patta-stage-c.html')};fsSync.writeFileSync(path.join(shots,'evidence.json'),JSON.stringify(evidence,null,2));console.log('MODEL_SIZES_C_PASS '+JSON.stringify(evidence));return;
          }
          if (process.env.FILTERS_2B_ONLY === '1') {
      safeEnv.FILTERS_2B_ONLY = '1';
      safeEnv.FILTERS_2B_FIXTURE_ROOT = fixtureRoot;
      safeEnv.FILTERS_2B_RENDER_DIR = outDir;
    }
    if (process.env.FILTERS_2G_ONLY === '1') safeEnv.FILTERS_2G_ONLY = '1';
    if (process.env.PATTA_JUMP_ONLY === '1') safeEnv.PATTA_JUMP_ONLY = '1';
    for (const key of ['DATABASE_URL', 'DIRECT_URL', 'NOVDA_PG_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'TELEGRAM_BOT_TOKEN', 'BOT_TOKEN']) delete safeEnv[key];
    const result = spawnSync(require('electron'), [__filename], { cwd: root,
        env: safeEnv, encoding: 'utf8', timeout: process.env.VISUAL_REFERENCE_FIX_ONLY === '1' ? 360000 : process.env.VISUAL_EXISTING_ONLY === '1' ? 300000 : process.env.MODEL_SIZES_C_ONLY === '1' || process.env.REDESIGN_E3_ONLY === '1' || process.env.MONEY_1C_ONLY === '1' || process.env.FILTERS_2A_ONLY === '1' || process.env.FILTERS_2A_ACTOR_STORAGE_ONLY === '1' || process.env.FILTERS_2B_ONLY === '1' || process.env.FILTERS_2C_ONLY === '1' || process.env.FILTERS_2D_ONLY === '1' || process.env.FILTERS_2G_ONLY === '1' || process.env.PATTA_JUMP_ONLY === '1' ? 240000 : 90000 });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = 1;
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
