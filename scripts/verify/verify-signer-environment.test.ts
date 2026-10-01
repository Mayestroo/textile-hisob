import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

describe('signer environment gate', () => {
  it('checks Ed25519-only signing, worker-secret isolation, and missing-key failure', () => {
    const root = path.resolve(__dirname, '../..');
    const result = spawnSync(process.execPath, ['scripts/verify/verify-signer-environment.cjs'], {
      cwd: root,
      env: {
        ...process.env,
        NOVDA_LICENSE_ED25519_PRIVATE_KEY: '',
        NOVDA_LICENSE_ED25519_PRIVATE_KEY_FILE: ''
      },
      encoding: 'utf8'
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('SIGNER_ENVIRONMENT_PASS');
  });
});
