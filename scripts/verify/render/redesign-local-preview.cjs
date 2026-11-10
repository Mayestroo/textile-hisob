// Persistent HMR preview server for the real renderer against a synthetic-only Electron fixture.
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { createServer } = require('vite');

const root = path.resolve(__dirname, '../../..');
const output = path.join(root, '.opencode/deep-audit/output');
const entry = path.join(__dirname, '..', 'fixtures', 'payroll-display-fixture.html');
const electronEntry = path.join(__dirname, 'redesign-preview-electron.cjs');
const statusFile = path.join(output, 'redesign-local-preview-status.json');
const electronLog = path.join(output, 'redesign-local-preview-electron.log');
const preview20w10m = process.argv.includes('--preview-20w10m');
if (process.argv.slice(2).some((arg) => arg !== '--preview-20w10m') || process.argv.filter((arg) => arg === '--preview-20w10m').length > 1) {
  throw new Error('Unsupported preview option. Use only --preview-20w10m when requested.');
}
let viteServer;
let electron;
let shuttingDown = false;

for (const key of ['DATABASE_URL', 'DIRECT_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD',
  'TELEGRAM_BOT_TOKEN', 'BOT_TOKEN', 'CUSTOMER_PROFILE', 'NODE_OPTIONS']) delete process.env[key];

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electron && !electron.killed) electron.kill();
  if (viteServer) await viteServer.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
  const reactPlugin = (await import('@vitejs/plugin-react')).default;
  viteServer = await createServer({ configFile: false, root, base: '/', logLevel: 'error', plugins: [reactPlugin()],
    server: { host: '127.0.0.1', port: 4178, strictPort: true, open: false,
      allowedHosts: ['127.0.0.1'], watch: { ignored: ['**/.opencode/**', '**/node_modules/**', '**/dist/**'] },
      hmr: { host: '127.0.0.1', protocol: 'ws', clientPort: 4178 } },
    appType: 'mpa', optimizeDeps: { noDiscovery: true, include: [] },
    build: { rollupOptions: { input: entry } } });
  await viteServer.listen();
  const electronBinary = require('electron');
  const childEnv = { ...process.env, REDESIGN_PREVIEW_HELPER_PID: String(process.pid),
    ELECTRON_NO_ATTACH_CONSOLE: '1' };
  if (preview20w10m) childEnv.VISUAL_PREVIEW_20W10M = '1';
  delete childEnv.ELECTRON_RUN_AS_NODE;
  electron = spawn(electronBinary, [electronEntry], { cwd: root, env: childEnv,
    detached: false, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(electronLog, '');
  electron.stdout.setEncoding('utf8').on('data', (chunk) => fs.appendFileSync(electronLog, chunk));
  electron.stderr.setEncoding('utf8').on('data', (chunk) => fs.appendFileSync(electronLog, chunk));
  electron.on('exit', (code, signal) => {
    if (!shuttingDown) {
      let previous = {};
      try { previous = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch {}
      if (previous.state !== 'failed') fs.writeFileSync(statusFile, JSON.stringify({ ...previous, state: 'stopped',
        helperPid: process.pid, electronPid: electron.pid, exitCode: code, signal }, null, 2));
    }
  });
  fs.writeFileSync(statusFile, JSON.stringify({ state: 'starting', helperPid: process.pid,
    electronPid: electron.pid, url: 'http://127.0.0.1:4178/scripts/verify/fixtures/payroll-display-fixture.html' }, null, 2));
  console.log(`REDESIGN_PREVIEW_HELPER_READY pid=${process.pid} electronPid=${electron.pid} url=http://127.0.0.1:4178/scripts/verify/fixtures/payroll-display-fixture.html`);
})().catch((error) => {
  console.error(error);
  shutdown();
});
