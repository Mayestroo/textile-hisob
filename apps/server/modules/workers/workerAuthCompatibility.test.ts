import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const { verifyWorkerWebToken } = require('./workerRoutes.cjs');
const ROOT = path.resolve(__dirname, '../../../..');
const PYTHON = String.raw`
import importlib.util
import json
import os
import sys

root = sys.argv[1]
sys.path.insert(0, os.path.join(root, 'worker-bot'))
spec = importlib.util.spec_from_file_location('novda_worker_sync', os.path.join(root, 'worker-bot', 'worker_bot.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
expires = int(sys.argv[2])
print(json.dumps({'token': module.worker_web_token('company-a', 27, '123456789', expires, 'test-worker-secret')[1]}))
`;
const PYTHON_UNPROTECTED_BINDING = String.raw`
import importlib.util
import json
import os
import sys

root = sys.argv[1]
sys.path.insert(0, os.path.join(root, 'worker-bot'))
spec = importlib.util.spec_from_file_location('novda_worker_sync', os.path.join(root, 'worker-bot', 'worker_bot.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.get_worker_id_binding = lambda _company_id, _worker_id: None
module.get_worker_enrollment = lambda _company_id, _worker_id: {
    'worker_id': 27, 'worker_name': 'Worker 27', 'pin_required': True, 'pin_configured': False
}
messages = []
module.send_message = lambda _chat_id, text, *_args: messages.append(text)
state = {'step': 'WAITING_WORKER_ID', 'company_id': 'company-a'}
module.start_worker_id_check(99, {'id': 123456789}, '123456789', state, '27')
print(json.dumps({'state': state, 'messages': messages}))
`;

describe('worker web authentication compatibility', () => {
  it('uses the same expiring HMAC scope in the  worker bot and API', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const python = spawnSync(process.env.PYTHON || 'python', ['-c', PYTHON, ROOT, String(expiresAt)], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, WORKER_BOT_TOKEN: '', NOVDA_WORKER_API_TOKEN: '', WORKER_AUTH_HMAC_SECRET: '' }
    });
    expect(python.error).toBeUndefined();
    expect(python.status, python.stderr).toBe(0);
    const { token } = JSON.parse(python.stdout);
    const params = { companyId: 'company-a', workerId: '27', telegramId: '123456789', expiresAt: String(expiresAt) };

    expect(verifyWorkerWebToken(params, token, 'test-worker-secret')).toBe(true);
    expect(verifyWorkerWebToken({ ...params, companyId: 'company-b' }, token, 'test-worker-secret')).toBe(false);
    expect(verifyWorkerWebToken({ ...params, expiresAt: String(expiresAt - 601) }, token, 'test-worker-secret', expiresAt - 600)).toBe(false);
  });

  it('does not offer confirmation as a fallback when a worker PIN is not configured', () => {
    const python = spawnSync(process.env.PYTHON || 'python', ['-c', PYTHON_UNPROTECTED_BINDING, ROOT], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    expect(python.error).toBeUndefined();
    expect(python.status, python.stderr).toBe(0);
    const result = JSON.parse(python.stdout);
    expect(result.state.step).toBe('WAITING_WORKER_ID');
    expect(result.state.worker_id).toBeUndefined();
    expect(result.messages.join('\n')).toMatch(/PIN|ma'muriyat/i);
  });

  it('displays the staj deduction used by the  payroll projection', () => {
    const webApp = fs.readFileSync(path.join(ROOT, 'worker-bot', 'webapp', 'index.html'), 'utf8');

    expect(webApp).toContain('id="stajAmount"');
    expect(webApp).toContain('Sof = Jami - Avans - Jarima - Staj');
    expect(webApp).toContain("staj: Number(profile.staj) || 0");
    expect(webApp).toContain("getElementById('stajAmount').textContent = formatMoney(c.staj)");
  });

  it('keeps Firebase and IELTS out of the VPS worker runtime', () => {
    const source = fs.readFileSync(path.join(ROOT, 'worker-bot', 'worker_bot.py'), 'utf8');
    const webApp = fs.readFileSync(path.join(ROOT, 'worker-bot', 'webapp', 'index.html'), 'utf8');
    expect(source).not.toMatch(/firebase|render\.com|onrender|ielts/i);
    expect(webApp).not.toMatch(/firebase|render\.com|onrender|ielts|hisobQuantities/i);
    expect(webApp).toContain('/api/worker/profile');
    expect(webApp).toContain('/api/worker/tickets?limit=50');
    expect(source).toContain('/api/worker/bindings/by-telegram/');
    expect(source).toContain('/api/worker/bindings/by-worker');
    expect(source).not.toMatch(/\/v2\//i);
    expect(webApp).not.toMatch(/\/v2\//i);
    const inlineScript = webApp.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
    expect(inlineScript).toBeTruthy();
    expect(() => new vm.Script(inlineScript || '')).not.toThrow();
    expect(source).toContain('WORKER_AUTH_HMAC_SECRET');
    expect(source).not.toContain('NOVDA_LICENSE_ED25519_PRIVATE_KEY');
  });
});
