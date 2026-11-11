'use strict';

// Real current HTML/JS and DOM events; only Telegram transport and a lost HTTP
// response are substituted. Signed admin routes and PostgreSQL stay real.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function verifyAdminFinancialUi({ baseUrl, initData }) {
  assert.equal(new URL(baseUrl).hostname, '127.0.0.1');
  const writes = [];
  let dropNext = false;
  let holdPayroll = false;
  let heldPayroll = null;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/fixture-telegram.js') {
        res.setHeader('content-type', 'application/javascript');
        return res.end(`window.Telegram={WebApp:{initData:${JSON.stringify(initData)},ready(){},expand(){},onEvent(){},BackButton:{onClick(){},hide(){},show(){}},setHeaderColor(){},setBackgroundColor(){}}};`);
      }
      if (url.pathname === '/__fixture/drop-next' && req.method === 'POST') { dropNext = true; return res.end('ok'); }
      if (url.pathname === '/__fixture/hold-payroll' && req.method === 'POST') { holdPayroll = true; return res.end('ok'); }
      if (url.pathname === '/__fixture/payroll-held') return res.end(heldPayroll ? 'yes' : 'no');
      if (url.pathname === '/__fixture/release-payroll' && req.method === 'POST') {
        assert(heldPayroll, 'No held payroll response'); heldPayroll(); heldPayroll = null; return res.end('ok');
      }
      if (url.pathname === '/__fixture/writes') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(writes)); }
      assert(url.pathname.startsWith('/admin-app') || url.pathname.startsWith('/api/admin/webapp/'));
      let body = '';
      for await (const chunk of req) body += chunk;
      const response = await fetch(new URL(req.url, baseUrl), { method: req.method,
        headers: { ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}) }, body: body || undefined });
      let text = await response.text();
      if (holdPayroll && url.pathname === '/api/admin/webapp/payroll') {
        holdPayroll = false;
        await new Promise(resolve => { heldPayroll = resolve; });
      }
      if (req.method === 'PUT') {
        writes.push({ path: url.pathname, body: JSON.parse(body), status: response.status });
        if (dropNext) {
          assert.equal(response.status, 200, text); dropNext = false;
          // A gateway lost the committed upstream response. A raw socket close is
          // automatically retried by Chromium for PUT and cannot prove UI recovery.
          res.writeHead(503, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: { code: 'FIXTURE_UPSTREAM_RESPONSE_LOST' } }));
        }
      }
      if (url.pathname === '/admin-app') text = text.replace('https://telegram.org/js/telegram-web-app.js', '/fixture-telegram.js');
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'text/plain', 'cache-control': 'no-store' });
      res.end(text);
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = { ...process.env, NOVDA_FINANCIAL_UI_URL: `http://127.0.0.1:${server.address().port}` };
    delete env.ELECTRON_RUN_AS_NODE;
    const output = await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [path.join(__dirname, 'admin-financial-ui-electron.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let result = '';
      child.stdout.on('data', chunk => { result += chunk; });
      child.stderr.on('data', chunk => { result += chunk; });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve(result) : reject(new Error(result)));
    });
    assert(String(output).includes('FINANCIAL_UI_PASS'), 'Browser exited before completing acceptance: ' + output);
    assert.equal(writes.length, 5, 'Three intents plus one lost-response replay and one explicit tariff update');
    assert(writes.every(write => write.status === 200));
    assert.deepEqual(writes[0].body, writes[1].body, 'Reload must replay the original revision and all IDs');
    assert.equal(new Set(writes.map(write => write.body.operationId)).size, 4);
    return { output: String(output).trim(), writes: writes.length, distinctFinancialIntents: 3, explicitRateUpdates: 1 };
  } finally {
    if (heldPayroll) heldPayroll();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

module.exports = { verifyAdminFinancialUi };
