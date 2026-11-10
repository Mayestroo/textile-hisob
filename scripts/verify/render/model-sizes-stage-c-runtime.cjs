'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = async function runModelSizesStageC({ window, db, manager, root, fixtureRoot, outDir, setDb }) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const evalUi = (source) => window.webContents.executeJavaScript(source);
  const waitFor = async (predicate, label, timeout = 25000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (await predicate()) return; await wait(60); }
    throw Error(`MODEL_SIZES_C timeout: ${label}`);
  };
  const setup = await evalUi('window.renderModelSizesCApp()');
  if (setup.modelIds.join(',') !== 'm,model-sizes-c-b' || setup.periodClosed || setup.archive)
    throw Error(`Fresh fixture context mismatch: ${JSON.stringify(setup)}`);
  window.setSize(1440, 1100); window.show(); window.focus();
  await waitFor(() => evalUi(`document.querySelectorAll('.e2b-batch-card').length === 2`), 'production Patta cards');
  await evalUi(`window.__modelSizesCAuth.getState().setAuth({status:'active',role:'type',companyId:'hisob_test_browser',permissions:['view:umumiy','edit:hisob']})`);
  await wait(100);
  const typeDenied = await evalUi(`document.querySelectorAll('.e2b-batch-card').length===0 && document.body.innerText.includes('faqat Admin')`);
  await evalUi(`window.__modelSizesCAuth.getState().setAuth({status:'active',role:'admin',companyId:'hisob_test_browser',permissions:['view:umumiy','view:patta','edit:hisob']})`);
  await wait(100);
  if (!typeDenied) throw Error('Production App type role did not deny Patta batch access');
  const wrongCompany = await evalUi(`window.electronAPI.WorkbookCommand({companyId:'model-sizes-c-other-company',commandType:'UpdateBatchSettings',operationId:'model-sizes-c-wrong-company',entityId:'model-sizes-c-other-company',payload:{availableSizes:[],configs:[]}})`);
  if (wrongCompany.success !== false || wrongCompany.code !== 'MODEL_SIZES_FIXTURE_SCOPE') throw Error(`Wrong-company command was not denied: ${JSON.stringify(wrongCompany)}`);
  const screenshots = path.join(root, '.opencode/deep-audit/output/post-redesign-model-sizes-c-screenshots', path.basename(fixtureRoot));
  fs.mkdirSync(screenshots, { recursive: true });
  const card = (id) => `document.querySelector('.e2b-batch-card[data-model-id="${id}"]')`;
  const names = (id) => evalUi(`(()=>[...${card(id)}.querySelectorAll('.e2b-size-cell span')].map(x=>x.innerText.trim()))()`);
  const setInput = (selector, value) => evalUi(`(()=>{const i=${selector};if(!i)throw Error('missing input');const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,${JSON.stringify(String(value))});i.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(String(value))}}));i.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const add = async (id, value) => {
    await evalUi(`(()=>[...${card(id)}.querySelectorAll('button')].find(b=>b.innerText.includes("Razmer qo'shish"))?.click())()`);
    await wait(40);
    await setInput(`document.querySelector('.modal-card input[type=text]')`, value);
    await evalUi(`document.querySelector('.modal-card form button[type=submit]')?.click()`);
    await wait(100);
  };
  const count = (id, size, value) => setInput(`(()=>[...${card(id)}.querySelectorAll('.e2b-size-cell')].find(r=>r.querySelector('span')?.innerText.trim()===${JSON.stringify(size)})?.querySelector('input'))()`, value);
  await count('model-sizes-c-b', 'L', 1);
  const initialB = JSON.stringify(await evalUi(`window.__modelSizesCStore.getState().pattaBatchConfigs['model-sizes-c-b']`));

  await add('m', 'XXL');
  const afterAddA = await names('m'), afterAddB = await names('model-sizes-c-b');
  if (!afterAddA.includes('XXL') || afterAddB.includes('XXL')) throw Error(`XXL was not isolated to model A: A=${JSON.stringify(afterAddA)}, B=${JSON.stringify(afterAddB)}, configs=${JSON.stringify(await evalUi(`window.__modelSizesCStore.getState().pattaBatchConfigs`))}`);
  if (initialB !== JSON.stringify(await evalUi(`window.__modelSizesCStore.getState().pattaBatchConfigs['model-sizes-c-b']`))) throw Error('Adding to A changed B config bytes');
  await add('m', 'M');
  if ((await names('m')).filter((name) => name === 'M').length !== 1) throw Error('Duplicate M was accepted');
  await add('m', 'TEMP');
  await evalUi(`(()=>${card('m')}.querySelector('[aria-label="TEMP razmerini nomlash"]').click())()`);
  await setInput(`document.querySelector('.modal-card form input')`, 'TEMP2');
  await evalUi(`document.querySelector('.modal-card form button[type=submit]')?.click()`);
  await wait(100);
  if (!(await names('m')).includes('TEMP2')) throw Error('Renaming empty custom row failed');
  const remove = async (id, name) => {
    await evalUi(`(()=>{const b=[...${card(id)}.querySelectorAll('button')].find(x=>x.title.includes(${JSON.stringify(name)})&&x.title.includes("o'chirish"));if(!b)throw Error('missing delete button '+${JSON.stringify(name)}+'; titles='+JSON.stringify([...${card(id)}.querySelectorAll('button')].map(x=>x.title)));b.click()})()`);
    await wait(50);
    await evalUi(`(()=>[...document.querySelectorAll('button')].find(b=>b.innerText.includes("o'chirilsin"))?.click())()`);
    await wait(100);
  };
  await remove('m', 'TEMP2');
  if ((await names('m')).includes('TEMP2')) throw Error('Removing empty custom row failed');
  await add('m', 'GUARD'); await count('m', 'GUARD', 2); await remove('m', 'GUARD');
  const positiveCount = await evalUi(`(()=>[...${card('m')}.querySelectorAll('.e2b-size-cell')].find(r=>r.querySelector('span')?.innerText.trim()==='GUARD')?.querySelector('input')?.value)()`);
  if (positiveCount !== '2') throw Error(`Positive count was dropped on remove: ${positiveCount}`);
  await count('m', 'GUARD', 0); await remove('m', 'GUARD');

  await count('m', 'M', 1); await count('m', 'XXL', 2);
  if (initialB !== JSON.stringify(await evalUi(`window.__modelSizesCStore.getState().pattaBatchConfigs['model-sizes-c-b']`))) throw Error('A quantity/rename/remove changed B names/count bytes');
  await setInput(`(${card('m')}).querySelector('.e2b-batch-work input')`, 10);
  await setInput(`(${card('model-sizes-c-b')}).querySelector('.e2b-batch-work input')`, 20);
  const keyboard = await evalUi(`(()=>{const i=${card('m')}.querySelector('.e2b-batch-work input');i.focus();i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return document.activeElement===${card('m')}.querySelector('.e2b-batch-party input')})()`);
  if (!keyboard) throw Error('Per-card Enter navigation failed');
  await evalUi(`(()=>[...document.querySelectorAll('[role=group][aria-label="Razmer turi"] button')].find(b=>b.innerText.includes('Raqamli'))?.click())()`); await wait(50);
  const numericNames = await names('m');
  await evalUi(`(()=>[...document.querySelectorAll('[role=group][aria-label="Razmer turi"] button')].find(b=>b.innerText.includes('Harfli'))?.click())()`); await wait(50);
  if (!numericNames.some((name) => /^\d/.test(name)) || !(await names('m')).includes('XXL')) throw Error('Numeric/letter mode toggle lost rows');
  const printTotal = await evalUi(`([...document.querySelectorAll('button')].find(b=>b.innerText.includes('Pechat ('))||{}).innerText`);
  if (!printTotal.includes('4 ta')) throw Error(`Expected four pattas, saw ${printTotal}`);
  await waitFor(() => db.prepare('SELECT COUNT(*) n FROM patta_batch_settings WHERE company_id=?').get('hisob_test_browser').n === 2, 'canonical settings write');
  manager.closeAllCompanyDatabases(); db = manager.getCompanyDatabase(fixtureRoot, 'hisob_test_browser'); setDb(db);
  const readProjection = require('../../../apps/desktop/electron/database/readers/projectionReader.cjs').loadWorkbookProjectionFromSqlite;
  let projection = readProjection(db, 'hisob_test_browser');
  const configs = projection.pattaBatchConfigs;
  if (configs.m.sizes.M !== '1' || configs.m.sizes.XXL !== '2' || configs['model-sizes-c-b'].sizes.L !== '1' || configs['model-sizes-c-b'].sizeNames?.includes('XXL'))
    throw Error(`Canonical save/reopen configs mismatch: ${JSON.stringify(configs)}`);
  const rendererReopen = await evalUi('window.reloadModelSizesC()');
  if (rendererReopen.configs.m.sizes.XXL !== '2' || rendererReopen.configs['model-sizes-c-b'].sizes.L !== '1') throw Error('Renderer readback did not preserve model definitions/counts');
  const printRevision = readProjection(db, 'hisob_test_browser').batchSettingsPrintRevision;
  const rendererRevision = await evalUi('window.__modelSizesCStore.getState().batchSettingsPrintRevision');
  if (!Number.isSafeInteger(printRevision) || printRevision < 1 || rendererRevision !== printRevision)
    throw Error(`Renderer did not hydrate queued canonical print revision: ${JSON.stringify({printRevision,rendererRevision})}`);
  await evalUi(`(()=>{const s=window.__modelSizesCStore.getState();for(const n of s.notifications||[])s.removeNotification(n.id);document.activeElement?.blur()})()`);
  await wait(250);
  fs.writeFileSync(path.join(screenshots, 'before-print.png'), (await window.webContents.capturePage()).toPNG());

  await evalUi(`(()=>[...document.querySelectorAll('button')].find(b=>b.innerText.includes('Pechat (4 ta patta)'))?.click())()`);
  await waitFor(() => evalUi(`Boolean(document.querySelector('#printable-patta-area .print-ticket-box'))`), 'production print modal');
  const preview = await evalUi(`(()=>[...document.querySelectorAll('#printable-patta-area .print-ticket-box')].map(e=>e.innerText))()`);
  const ticketFacts = (tickets) => tickets.map((ticket) => {
    const sizeLine = ticket.split('\n').find((line) => line.includes('Иш сони')) || '';
    const row = sizeLine.split('\t');
    const pattaLine = ticket.split('\n').find((line) => line.includes('Патта\t')) || '';
    const partyLine = ticket.split('\n').find((line) => line.includes('Партия\t')) || '';
    return { size: row[row.length - 1]?.trim(), work: Number(row[2]), model: ticket.match(/Модел- ([^\n]+)/)?.[1], patta: Number(pattaLine.split('\t')[2]), party: partyLine.split('\t')[2] };
  });
  const previewFacts = ticketFacts(preview);
  if (preview.length !== 4 || previewFacts.map((ticket) => ticket.size).sort().join(',') !== 'L,M,XXL,XXL'
    || !preview.some((ticket) => ticket.includes('Jacket B') && ticket.includes('L') && ticket.includes('20'))
    || !preview.some((ticket) => ticket.includes('Demo') && ticket.includes('M') && ticket.includes('10'))
    || previewFacts.reduce((sum, ticket) => sum + ticket.work, 0) !== 50) throw Error(`Print preview mismatch: ${JSON.stringify(preview)}`);
  fs.writeFileSync(path.join(screenshots, 'print-preview.png'), (await window.webContents.capturePage()).toPNG());
  await evalUi(`(()=>[...document.querySelectorAll('button')].find(b=>b.innerText.includes('Pechat qilish (4 ta patta)'))?.click())()`);
  const htmlPath = path.join(outDir, 'generated-patta-stage-c.html');
  await waitFor(() => fs.existsSync(htmlPath), 'generated HTML');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const htmlTickets = await evalUi(`(()=>{const f=document.createElement('iframe');f.style.cssText='position:fixed;left:-10000px;top:0;width:1200px;height:1600px';document.body.appendChild(f);const d=f.contentDocument;d.open();d.write(${JSON.stringify(html)});d.close();void f.contentWindow.getComputedStyle(d.body).height;const a=[...d.querySelectorAll('.print-ticket-box')].map(e=>e.innerText);f.remove();return a})()`);
  const htmlFacts = ticketFacts(htmlTickets);
  if (htmlTickets.length !== 4 || htmlFacts.map((ticket) => ticket.size).sort().join(',') !== 'L,M,XXL,XXL'
    || htmlFacts.map((ticket) => ticket.patta).sort((a,b)=>a-b).join(',') !== '1,2,3,4'
    || !htmlFacts.some((ticket) => ticket.model === 'Jacket B' && ticket.size === 'L' && ticket.work === 20))
    throw Error(`Generated HTML mismatch facts=${JSON.stringify(htmlFacts)}: ${JSON.stringify(htmlTickets)}`);
  await waitFor(() => db.prepare('SELECT COUNT(*) n FROM parties WHERE company_id=?').get('hisob_test_browser').n === 2, 'canonical CompletePattaBatch');
  const parties = db.prepare('SELECT id,model_id,party_number,patta_count,patta_start_number,patta_end_number,sizes_json,size_order_json,total_ish_soni FROM parties WHERE company_id=? ORDER BY model_id').all('hisob_test_browser');
  projection = readProjection(db, 'hisob_test_browser');
  const reset = projection.pattaBatchConfigs;
  if (JSON.parse(parties[0].size_order_json).join(',') !== 'M,XXL' || JSON.parse(parties[1].size_order_json).join(',') !== 'L'
    || parties[0].patta_start_number !== 1 || parties[0].patta_end_number !== 3 || parties[1].patta_start_number !== 4 || parties[1].patta_end_number !== 4
    || parties[0].total_ish_soni !== 30 || parties[1].total_ish_soni !== 20 || reset.m.sizes.XXL !== '' || !reset.m.sizeNames.includes('XXL'))
    throw Error(`Canonical party/order/range/reset mismatch: ${JSON.stringify({ parties, reset })}`);
  const partyBefore = JSON.stringify(parties[0]);
  const submittedTicketBefore = JSON.stringify(db.prepare("SELECT id,model_id,party_number,patta_number,qty,size FROM tickets WHERE company_id=? AND id='entered'").get('hisob_test_browser'));
  const batchNamesB = JSON.stringify(reset['model-sizes-c-b'].sizeNames);
  const archiveBefore = db.prepare('SELECT archive_json,sha256 FROM period_archives WHERE company_id=? AND period_id=?').get('hisob_test_browser', 'Q');
  await evalUi(`window.__modelSizesCStore.getState().loadArchivedPeriod('archive_Q.json')`);
  const archiveLoaded = await evalUi(`({filename:window.__modelSizesCStore.getState().selectedArchiveFilename,period:window.__modelSizesCStore.getState().selectedArchiveData?.period?.id})`);
  if (archiveLoaded.filename !== 'archive_Q.json' || archiveLoaded.period !== 'Q') throw Error(`Production archive context did not load: ${JSON.stringify(archiveLoaded)}`);
  await evalUi(`window.__modelSizesCStore.setState(s=>({currentPeriod:s.periods.find(p=>p.id==='Q')}))`);
  await evalUi(`window.__modelSizesCStore.getState().updatePattaBatchConfig('m',{sizeNames:[...window.__modelSizesCStore.getState().pattaBatchConfigs.m.sizeNames,'LATER']})`);
  await wait(1400);
  const partyAfter = JSON.stringify(db.prepare("SELECT id,model_id,party_number,patta_count,patta_start_number,patta_end_number,sizes_json,size_order_json,total_ish_soni FROM parties WHERE company_id=? AND model_id='m'").get('hisob_test_browser'));
  if (partyBefore !== partyAfter) throw Error('Later A edit mutated existing printed party/order/ticket slot identity');
  const printedTicket = db.prepare("SELECT id,model_id,party_number,patta_number,qty,size FROM tickets WHERE company_id=? AND id='entered'").get('hisob_test_browser');
  if (submittedTicketBefore !== JSON.stringify(printedTicket)) throw Error('Later A edit changed a submitted ticket ID/size/quantity/history');
  const configAfterAEdit = readProjection(db, 'hisob_test_browser').pattaBatchConfigs;
  const archiveAfter = db.prepare('SELECT archive_json,sha256 FROM period_archives WHERE company_id=? AND period_id=?').get('hisob_test_browser', 'Q');
  if (JSON.stringify(configAfterAEdit['model-sizes-c-b'].sizeNames) !== batchNamesB
    || configAfterAEdit['model-sizes-c-b'].sizes.L !== ''
    || JSON.stringify(archiveAfter) !== JSON.stringify(archiveBefore)
    || JSON.stringify(await evalUi(`window.__modelSizesCStore.getState().selectedArchiveData`)) === 'null')
    throw Error('A edit changed B definition or archive/current-period context '+JSON.stringify({archiveLoaded,archiveAfter}));
  const outbox = db.prepare("SELECT command_type,status FROM local_outbox WHERE company_id=? AND command_type IN ('UpdateBatchSettings','CompletePattaBatch')").all('hisob_test_browser');
  if (!outbox.some((row) => row.command_type === 'UpdateBatchSettings') || !outbox.some((row) => row.command_type === 'CompletePattaBatch')) throw Error(`Canonical outbox missing batch commands: ${JSON.stringify(outbox)}`);
  const persistedOutbox = db.prepare("SELECT command_type,status,payload_json FROM local_outbox WHERE company_id=? AND command_type IN ('UpdateBatchSettings','CompletePattaBatch')").all('hisob_test_browser');
  const printedPayload = JSON.parse(persistedOutbox.find((row) => row.command_type === 'CompletePattaBatch').payload_json);
  if (printedPayload.batchSettingsBaseRevision !== printRevision) throw Error('Canonical UI print outbox lost the projected base revision');
  const updatePayload = persistedOutbox.filter((row) => row.command_type === 'UpdateBatchSettings').map((row) => JSON.parse(row.payload_json)).find((payload) => payload.configs?.some((config) => config.modelId === 'm' && config.sizeNames?.includes('XXL')));
  if (!updatePayload || updatePayload.configs.find((config) => config.modelId === 'model-sizes-c-b').sizeNames.includes('XXL')) throw Error(`Outbox payload lost or cross-contaminated model definitions: ${JSON.stringify(updatePayload)}`);
  const evidence = { fixtureRoot, outDir, setup, typeDenied, wrongCompany, numericNames, keyboard, printTotal, rendererReopen, preview, previewFacts, htmlTickets, htmlFacts, parties, reset, archiveLoaded, archiveBefore, archiveAfter, configAfterAEdit, outbox: persistedOutbox.map((row) => ({ command_type: row.command_type, status: row.status })), updatePayload, printedTicket, screenshots, htmlPath };
  fs.writeFileSync(path.join(screenshots, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`MODEL_SIZES_C_PASS ${JSON.stringify(evidence)}`);
};
