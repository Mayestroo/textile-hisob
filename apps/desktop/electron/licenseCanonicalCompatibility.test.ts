import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const license = require('./license.cjs');
const ROOT = path.resolve(__dirname, '../../..');

const PYTHON_BRIDGE = String.raw`
import base64
import importlib.util
import json
import os
import sys
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

root = sys.argv[1]
admin_dir = os.path.join(root, 'admin-bot')
sys.path.insert(0, root)
key = Ed25519PrivateKey.generate()

def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

payload_helper = load_module('novda_payload_helper', os.path.join(root, 'scripts', 'tools', 'generate_license.py'))
payload = json.load(sys.stdin)
payload_helper_bytes = payload_helper.canonical_payload(payload)

sys.path.insert(0, admin_dir)
sys.modules.pop('license_payload', None)
admin_bot = load_module('novda_admin_bot', os.path.join(admin_dir, 'admin_bot.py'))
admin_bytes = admin_bot.canonical_activation_payload(payload)
admin_signed = admin_bot.create_activation(payload, key)

public_pem = key.public_key().public_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PublicFormat.SubjectPublicKeyInfo,
).decode('ascii')
print(json.dumps({
    'payloadHelperCanonical': base64.b64encode(payload_helper_bytes).decode('ascii'),
    'adminBotCanonical': base64.b64encode(admin_bytes).decode('ascii'),
    'adminBotSignature': admin_signed['signature'],
    'adminAuthorized': admin_bot.is_authorized_admin(12345678, {'12345678'}),
    'adminUnauthorized': admin_bot.is_authorized_admin(87654321, {'12345678'}),
    'missingSigner': admin_bot.load_signer('')[1],
    'publicKey': public_pem,
}))
`;

describe('Python Ed25519 signer compatibility', () => {
  it('uses Electron canonical bytes for the  admin-bot signer', () => {
    const payload = {
      activationId: '22222222-2222-4222-8222-222222222222',
      companyId: 'novda-test',
      companyName: 'Novda — Sinov',
      expiresAt: null,
      issuedAt: '2026-09-23T00:00:00.000Z',
      machineId: 'ABCD-1234-ABCD-1234',
      requireTicketValidation: true,
      role: 'admin',
      schema: 'novda-license-v1',
      status: 'active'
    };
    const python = spawnSync(process.env.PYTHON || 'python', ['-c', PYTHON_BRIDGE, ROOT], {
      cwd: ROOT,
      encoding: 'utf8',
      input: JSON.stringify(payload),
      env: {
        ...process.env,
        ...(process.platform === 'win32' ? {
          USERPROFILE: process.env.USERPROFILE || os.homedir(),
          APPDATA: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
        } : {}),
        ADMIN_BOT_TOKEN: '',
        NOVDA_ADMIN_API_TOKEN: '',
        NOVDA_ADMIN_TELEGRAM_IDS: '',
        NOVDA_LICENSE_ED25519_PRIVATE_KEY: '',
        NOVDA_LICENSE_ED25519_PRIVATE_KEY_FILE: '',
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8'
      }
    });

    expect(python.error).toBeUndefined();
    expect(python.status, python.stderr).toBe(0);
    const result = JSON.parse(python.stdout);
    const electronCanonical = Buffer.from(license.canonicalActivationPayload(payload)).toString('base64');

    expect(result.payloadHelperCanonical).toBe(electronCanonical);
    expect(result.adminBotCanonical).toBe(electronCanonical);
    expect(result.adminAuthorized).toBe(true);
    expect(result.adminUnauthorized).toBe(false);
    expect(result.missingSigner).toBe('SIGNER_NOT_CONFIGURED');
    const adminRuntime = fs.readFileSync(path.join(ROOT, 'admin-bot/admin_bot.py'), 'utf8');
    expect(adminRuntime).not.toMatch(/firebase|render\.com|onrender|ielts/i);
    expect(license.verifyActivationRecord(payload.machineId, {
      payload,
      signature: result.adminBotSignature
    }, result.publicKey).valid).toBe(true);
  });
});
