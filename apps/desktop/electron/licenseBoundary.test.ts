import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const boundary = require('./licenseBoundary.cjs');
const license = require('./license.cjs');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hisob-license-boundary-'));
}

describe('Electron license trust boundary', () => {
  it('rejects renderer company assignment without reading or writing license state', () => {
    const userDataDir = makeTempDir();
    const licensePath = path.join(userDataDir, 'license.lic');
    fs.writeFileSync(licensePath, JSON.stringify({ payload: { companyId: 'company-a' } }));
    const result = license.setLicenseCompany(userDataDir, 'company-b', 'B');
    expect(result).toMatchObject({ success: false, code: boundary.AUTHORIZATION_UNAVAILABLE });
    expect(JSON.parse(fs.readFileSync(licensePath, 'utf8')).payload.companyId).toBe('company-a');
  });

  it('rejects legacy keys without creating local activation state', () => {
    const userDataDir = makeTempDir();
    const result = license.saveLicense(userDataDir, 'ACT-ADMIN-MACHINE-KEY');
    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'license.lic'))).toBe(false);
  });
});
