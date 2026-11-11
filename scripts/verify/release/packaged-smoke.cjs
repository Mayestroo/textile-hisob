'use strict';
// Starts the ACTUAL packaged main/preload/renderer, not a replacement main.
// Isolated blank profile, no activation substitution, no production API access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const asar = require('@electron/asar');
const { sourceFingerprint } = require('./release-gates.cjs');
async function main() {
  const executable = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3]);
  assert(executable.startsWith('C:\\Users\\bekbo\\AppData\\Local\\Temp\\opencode\\'), 'Disposable packaged executable required');
  fs.mkdirSync(output, { recursive: false }); // Never reuse an existing profile/evidence.
  const archive = path.join(path.dirname(executable), 'resources/app.asar');
  const fingerprint = sourceFingerprint();
  const files = asar.listPackage(archive).map(name => name.replaceAll('\\', '/'));
  const forbidden = files.filter(name => /(^|\/)(tests|server|ops|scripts)\//.test(name)
    || /\.test\.|\.(map|sqlite|db|py|md)$|(^|\/)\.env/.test(name));
  assert.deepEqual(forbidden, [], 'Packaged application contains forbidden content');
  const root = path.resolve(__dirname, '../../..');
  let matchedFiles = 0;
  for (const name of files.filter(name => /\.(cjs|js|ts|tsx|css|html)$/.test(name)
    && ['/apps/desktop/electron/', '/packages/', '/dist/'].some(prefix => name.startsWith(prefix)))) {
    const relative = name.slice(1);
    assert(fs.existsSync(path.join(root, relative)), 'Unknown packaged source: ' + relative);
    assert(asar.extractFile(archive, path.normalize(relative)).equals(fs.readFileSync(path.join(root, relative))), 'Stale packaged source/build output: ' + relative);
    matchedFiles++;
  }
  for (const required of ['apps/desktop/electron/main.cjs', 'apps/desktop/electron/preload.cjs', 'dist/index.html',
    'packages/domain/payrollReducer.cjs', 'packages/contracts/ticketEntryIdentity.cjs']) {
    assert(files.includes('/' + required), 'Missing runtime file: ' + required);
  }
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const env = { ...process.env, NODE_ENV: 'test', NOVDA_SYNC_SERVER_URL: 'https://127.0.0.1:9' };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DATABASE_URL', 'NOVDA_PG_URL', 'NOVDA_API_TOKEN', 'NOVDA_DEVICE_ID']) delete env[key];
  const child = spawn(executable, ['--user-data-dir=' + path.join(output, 'profile'), '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', socket;
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.on('error', error => { log += error.code; });
  try {
    const deadline = Date.now() + 45000;
    let target;
    while (!target && Date.now() < deadline && child.exitCode === null) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'); } catch { /* startup */ }
      if (!target) await delay(100);
    }
    assert(target?.webSocketDebuggerUrl, 'Packaged startup did not expose a renderer; ' + log.slice(-2000));
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let ordinal = 0;
    const pending = new Map();
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      const entry = pending.get(message.id);
      if (entry) { pending.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); }
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++ordinal; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    });
    await call('Network.enable');
    await call('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    const evaluate = async expression => {
      const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert(!result.exceptionDetails, 'Packaged renderer evaluation failed: ' + JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    let view;
    do {
      view = await evaluate(`({text:document.body.innerText,bridge:!!window.electronAPI,requireType:typeof require})`);
      if (view.bridge && view.text.length > 40) break;
      await delay(100);
    } while (Date.now() < deadline);
    assert(view.bridge && view.text.length > 40, 'Packaged UI blank or preload absent');
    assert.equal(view.requireType, 'undefined', 'Renderer Node access must remain disabled');
    const result = await evaluate(`(async()=>({runtime:await window.electronAPI.getRuntimeMode(),version:await window.electronAPI.getAppVersion(),
      license:await window.electronAPI.getLicenseStatus(),read:await window.electronAPI.dbRead('smoke-unlicensed')}))()`);
    assert.equal(result.runtime.mode, 'sync');
    assert.equal(result.license.isActivated, false);
    assert.equal(result.read.success, false, 'Unlicensed packaged startup must not allow business reads');
    assert.match(view.text, /aktiv|litsenz|activation/i, 'Activation surface not displayed');
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, 'activation.png'), Buffer.from(screenshot.data, 'base64'));
    const evidence = { status: 'PASS', scope: 'Packaged blank-profile startup, real main/preload/IPC/DOM; NOT activated business acceptance or installer upgrade',
      appAsarSha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
      executableSha256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),
      sourceFingerprint: fingerprint, matchedSourceAndBuildFiles: matchedFiles,
      packagedFiles: files.length, forbiddenFiles: forbidden.length, runtimeMode: result.runtime.mode,
      appVersion: result.version, unlicensedReadRejected: !result.read.success, sandboxedRenderer: view.requireType === 'undefined',
      environment: 'NODE_ENV=test permits loopback HTTPS sink; real license code unchanged; no activation/network writes' };
    // CDP may close its socket before acknowledging Browser.close. Require the
    // actual process exit, not a response on the disappearing debug connection.
    await Promise.race([call('Browser.close').catch(() => {}), delay(1000)]);
    const stopped = await Promise.race([exited, delay(5000).then(() => null)]);
    assert(stopped && stopped.code === 0, 'Packaged application did not shut down cleanly');
    assert.equal(sourceFingerprint(), fingerprint, 'Source changed during packaged acceptance');
    evidence.cleanExit = true;
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
  } finally {
    socket?.close();
    if (child.exitCode === null) child.kill(); // Only the process created by this fixture.
    fs.writeFileSync(path.join(output, 'process.log'), log);
  }
}
const timeout = setTimeout(() => { console.error('PACKAGED_SMOKE_TIMEOUT'); process.exit(1); }, 60000);
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => clearTimeout(timeout));
