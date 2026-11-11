'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');

async function createLocalFaultGateway(upstream) {
  assert.equal(new URL(upstream).hostname, '127.0.0.1');
  let offline = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    try {
      if (req.url === '/__fixture/offline/on' && req.method === 'POST') { offline = true; return res.end('ok'); }
      if (req.url === '/__fixture/offline/off' && req.method === 'POST') { offline = false; return res.end('ok'); }
      if (offline) {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: { code: 'FIXTURE_NETWORK_INTERRUPTED' } }));
      }
      assert(req.url.startsWith('/api/'));
      let body = '';
      for await (const chunk of req) body += chunk;
      const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
      const response = await fetch(new URL(req.url, upstream), { method: req.method, headers, body: body || undefined });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json' });
      res.end(await response.text());
    } catch { res.writeHead(502); res.end('Local fixture upstream failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
module.exports = { createLocalFaultGateway };
