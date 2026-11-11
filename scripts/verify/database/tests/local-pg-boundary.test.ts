import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const guard = path.resolve(__dirname, '../assert-local-pg.cjs');
const check = (url?: string) => spawnSync(process.execPath, [guard], {
  env: { NOVDA_LOCAL_TEST_PG_URL: url }, encoding: 'utf8', timeout: 10000
});

describe('standalone acceptance database boundary', () => {
  it('accepts an explicit loopback-only disposable database without an untracked local file', () => {
    expect(check('postgresql://fixture@127.0.0.1:55432/hisob_test_boundary').status).toBe(0);
  });

  it.each([
    undefined,
    'postgresql://fixture@example.com:5432/hisob_test_boundary',
    'postgresql://fixture@127.0.0.1:55432/novda_prod',
    'postgresql://fixture@127.0.0.1/hisob_test_boundary',
    'postgresql://fixture@127.0.0.1:55432/hisob_test_boundary?host=example.com'
  ])('rejects unsafe or implicit acceptance targets before opening a connection: %s', (url) => {
    expect(check(url).status).not.toBe(0);
  });
});
