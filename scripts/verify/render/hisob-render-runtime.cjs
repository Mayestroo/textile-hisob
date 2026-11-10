// Isolated production bundle + Electron DOM geometry check; no application profile or DB.
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const outDir = path.join(__dirname, '.hisob-render-runtime');

if (process.env.HISOB_RENDER_CHILD === '1') {
  const { app, BrowserWindow, session } = require('electron');
  const fsSync = require('node:fs');
  const userData = path.join(outDir, 'isolated-user-data');
  fsSync.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  app.commandLine.appendSwitch('no-sandbox');
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('devtools:') }));
    const window = new BrowserWindow({ width: 1100, height: 750, show: true,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    try {
      await window.loadFile(path.join(outDir, 'scripts/verify/fixtures/hisob-render-fixture.html'));
      if (process.env.HISOB_CSS_PROBE === '1') {
        await new Promise(resolve => setTimeout(resolve, 800));
        app.focus(); window.show(); window.focus(); window.webContents.focus();
        const inspect = await window.webContents.executeJavaScript(await fs.readFile(path.join(__dirname, 'hisob-css-probe.js'), 'utf8'));
        const runs = [];
        const debuggerApi = window.webContents.debugger;
        debuggerApi.attach('1.3');
        let traceCounts = {};
        let completeTrace;
        debuggerApi.on('message', (_event, method, params) => {
          if (method === 'Tracing.dataCollected') for (const item of params.value) {
            if (['Paint', 'Layout', 'UpdateLayerTree', 'CompositeLayers'].includes(item.name))
              traceCounts[item.name] = (traceCounts[item.name] || 0) + 1;
          }
          if (method === 'Tracing.tracingComplete') completeTrace?.();
        });
        try {
          for (const disabled of [false, true, true, false]) {
            await window.webContents.executeJavaScript('window.hisobCssProbe.end()');
            const point = await window.webContents.executeJavaScript(`window.hisobCssProbe.begin(${disabled})`);
            window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
            traceCounts = {};
            await debuggerApi.sendCommand('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReportEvents' });
            // One RAF stream per run; real Electron mouse-wheel input at a stationary position.
            for (let i = 0; i < 55; i++) {
              window.webContents.sendInputEvent({ type: 'mouseWheel', x: point.x, y: point.y,
                deltaX: -22, deltaY: -34 });
              await new Promise(resolve => setTimeout(resolve, 16));
            }
            await new Promise(resolve => setTimeout(resolve, 100));
            const metrics = await window.webContents.executeJavaScript('window.hisobCssProbe.end()');
            const done = new Promise(resolve => { completeTrace = resolve; });
            await debuggerApi.sendCommand('Tracing.end');
            await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(Error('trace timeout')), 5000))]);
            completeTrace = null;
            runs.push({ effectsOff: disabled, ...metrics, paintTrace: traceCounts });
          }
        } finally { debuggerApi.detach(); await window.webContents.executeJavaScript('window.hisobCssProbe.cleanup()'); }
        console.log('CSS_PROBE ' + JSON.stringify({ inspect, runs, window: { visible: window.isVisible(), focused: window.isFocused() }, gpu: app.getGPUFeatureStatus() }));
      }
      const result = await window.webContents.executeJavaScript(`(async () => {
        const wait = () => new Promise(resolve => setTimeout(resolve, 200));
        await wait();
        const scroll = document.querySelector('.excel-table').parentElement;
        const table = scroll.querySelector('table');
        const row = () => [...table.querySelectorAll('tbody tr.fast-row')].find(r => r.cells[0].textContent.trim() === '123456789012345');
        const widths = () => [...table.querySelectorAll('col')].map(c => c.getBoundingClientRect().width);
        const before = widths();
        const horizontal = scroll.scrollWidth > scroll.clientWidth;
        const vertical = scroll.scrollHeight > scroll.clientHeight;
        scroll.scrollTop = 199 * 32;
        scroll.scrollLeft = 650;
        scroll.dispatchEvent(new Event('scroll'));
        await new Promise(resolve => setTimeout(resolve, 700));
         const target = row();
        if (!target) throw Error('long-ID row did not mount near index 199: ' + JSON.stringify({
          scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight,
          rows: [...table.querySelectorAll('tbody tr.fast-row')].map(r => r.cells[0].textContent.trim()) }));
         const id = target.cells[0], name = target.cells[1];
         const footer = [...table.querySelectorAll('tbody tr')].find(r => r.textContent.includes('ЖАМИ (ИТОГО)'));
         const headerCell = table.querySelector('thead tr:nth-child(2)').cells[3];
         const aligned = !!footer && Math.abs(footer.cells[1].getBoundingClientRect().left - target.cells[2].getBoundingClientRect().left) < 2 &&
           Math.abs(footer.cells[2].getBoundingClientRect().left - headerCell.getBoundingClientRect().left) < 2 &&
           Math.abs(footer.cells[footer.cells.length - 1].getBoundingClientRect().right - target.cells[target.cells.length - 1].getBoundingClientRect().right) < 2;
         const extent = Math.abs(scroll.scrollHeight - (222 * 32 + 32 + 30 + 40)) <= 4;
        const headerName = table.querySelector('thead tr:first-child').cells[1];
        const secondName = table.querySelector('thead tr:nth-child(2)').cells[1];
        const offset = before[0];
        const sticky = [name, headerName, secondName].every(c => Math.abs(parseFloat(getComputedStyle(c).left) - offset) < 1)
          && name.getBoundingClientRect().left >= id.getBoundingClientRect().right - 1;
        const actualIdWidth = id.getBoundingClientRect().width;
        const fit = (el, padding = 1) => {
          const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
          ctx.font = getComputedStyle(el).font;
          return ctx.measureText(el.textContent.trim()).width + padding <= el.getBoundingClientRect().width;
        };
        const nameFit = fit(name, 20), moneyFit = fit(target.cells[30], 12);
        const qtyInput = target.cells[31].querySelector('input');
        const quantityFit = qtyInput.scrollWidth <= qtyInput.clientWidth + 1 &&
          Number(qtyInput.value) === 987654321;
        scroll.scrollTop = 0;
        scroll.dispatchEvent(new Event('scroll'));
        await wait();
        const offscreenBeforeUpdate = !row();
        const next = window.renderFixture.updateOffscreen();
        const updated = widths();
        const offscreenAfterUpdate = !row();
        window.renderFixture.fallbackCanvas(next);
        const fallback = widths()[0] > updated[0];
        scroll.scrollTop = 199 * 32;
        scroll.dispatchEvent(new Event('scroll'));
        await wait();
        const updatedRow = row();
        const updatedQuantity = updatedRow?.cells[31].querySelector('input');
        const updatedCellFit = updatedQuantity?.scrollWidth <= updatedQuantity?.clientWidth + 1 &&
          Number(updatedQuantity.value) === 999999999999999;
        const stableScroll = scroll.scrollTop > 0 && scroll.scrollLeft > 0;
         return { workers: 222, operations: 15, horizontal, vertical, sticky, aligned, extent, offset,
          actualIdWidth, nameFit, moneyFit, quantityFit,
          offscreenBeforeUpdate, offscreenAfterUpdate, offscreenWidthGrew: updated[31] > before[31],
          updatedCellFit, fallback, stableScroll,
          beforeQuantityWidth: before[31], afterQuantityWidth: updated[31] };
      })()`);
      console.log(JSON.stringify(result));
       if (!result.horizontal || !result.vertical || !result.sticky || !result.aligned || !result.extent || !result.nameFit || !result.moneyFit ||
        !result.quantityFit || !result.offscreenBeforeUpdate || !result.offscreenAfterUpdate ||
        !result.offscreenWidthGrew || !result.updatedCellFit || !result.fallback || !result.stableScroll) process.exitCode = 1;
    } catch (error) { console.error(error); process.exitCode = 1; }
    finally { window.destroy(); app.quit(); }
  }).catch(error => { console.error(error); app.quit(); process.exitCode = 1; });
} else {
  (async () => {
    try {
      const { build } = await import('vite');
      await build({ configFile: false, root, base: './', logLevel: 'error',
      build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(__dirname, '..', 'fixtures', 'hisob-render-fixture.html') } } });
      const result = spawnSync(require('electron'), [__filename], { cwd: root,
        env: { ...process.env, HISOB_RENDER_CHILD: '1' }, encoding: 'utf8', timeout: 90000 });
      process.stdout.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
      if (result.error) throw result.error;
      if (result.status !== 0) process.exitCode = 1;
    } finally { await fs.rm(outDir, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
