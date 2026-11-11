import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
describe('read-only Windows signature release refusal', () => {
  it('never treats a matching hash or signtool log as signing evidence', () => {
    if (process.platform !== 'win32') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-unsigned-fixture-'));
    try {
      const file = path.join(dir, 'unsigned.exe'); fs.writeFileSync(file, 'not a signed release');
      const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
        path.resolve(__dirname, '../verify-windows-signature.ps1'), '-Artifact', file,
        '-ExpectedSha256', hash, '-ExpectedSignerThumbprint', '0'.repeat(40)], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ Status: 'FAIL', HashMatches: true,
        ExpectedSignerMatches: false, TimestampPresent: false });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
