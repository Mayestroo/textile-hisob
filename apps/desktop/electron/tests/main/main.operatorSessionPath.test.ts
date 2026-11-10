import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'main.cjs'), 'utf8');
const storeSource = fs.readFileSync(path.join(__dirname, '..', '..', 'security', 'operatorSessionStore.cjs'), 'utf8');

describe('operator IPC session path', () => {
  it('uses userData/credentials for login, read and revoke across working directories and companies', async () => {
    const userData = fs.mkdtempSync(path.join(__dirname, 'operator-session-fixture-'));
    const credentials = path.join(userData, 'credentials');
    const handlers = new Map<string, (event: unknown, args: any) => Promise<any>>();
    const clients: Array<{ operatorToken: string; companyId?: string }> = [];
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value, 'utf8'),
      decryptString: (value: Buffer) => value.toString('utf8')
    };
    let cwd = path.join(userData, 'launch-one');
    const initialCwd = cwd;

    try {
      const storeModule: { exports: any } = { exports: {} };
      vm.runInNewContext(storeSource, {
        module: storeModule, require, Buffer, Date, process: { cwd: () => cwd }
      }, { filename: 'operatorSessionStore.cjs' });
      const store = storeModule.exports;
      const checkedOptions = (options: { baseDir?: string }) => {
        // Fail before the store can touch a fallback path if an IPC call omits baseDir.
        expect(options.baseDir).toBe(credentials);
        return { ...options, safeStorage };
      };
      const start = source.indexOf("  const operatorSessionDir = path.join(app.getPath('userData'), 'credentials');");
      const end = source.indexOf("  ipcMain.handle('sync-dispatch'", start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      vm.runInNewContext(source.slice(start, end), {
        path,
        app: { getPath: (key: string) => key === 'userData' ? userData : undefined, getVersion: () => 'test', isPackaged: false },
        process: { cwd: () => cwd },
        ipcMain: { handle: (channel: string, handler: (event: unknown, args: any) => Promise<any>) => handlers.set(channel, handler) },
        assertRuntimeReady: (companyId: string) => ({ companyId }),
        readDeviceCredential: () => 'device-token',
        license: { checkLicenseStatus: () => ({ machineId: 'device-id' }) },
        resolveApiBaseUrl: () => 'http://localhost',
        SyncClient: class {
          operatorToken: string;
          constructor(options: { operatorToken: string }) {
            this.operatorToken = options.operatorToken;
            clients.push(this);
          }
          async loginOperator(operatorId: string) { return { token: `session-${operatorId}`, operatorId, companyId: 'test' }; }
          async revokeOperator() { return true; }
        },
        storeOperatorSession: (companyId: string, token: string, options: { baseDir?: string }) => store.storeOperatorSession(companyId, token, checkedOptions(options)),
        readOperatorSession: (companyId: string, options: { baseDir?: string }) => store.readOperatorSession(companyId, checkedOptions(options)),
        deleteOperatorSession: (companyId: string, options: { baseDir?: string }) => store.deleteOperatorSession(companyId, checkedOptions(options)),
        ErrorResponse: (error: Error) => ({ success: false, error: error.message })
      });

      const login = handlers.get('operator-login')!;
      const revoke = handlers.get('operator-revoke')!;
      expect((await login(null, { companyId: 'co-a', operatorId: 'alice', password: 'password' })).success).toBe(true);
      cwd = path.join(userData, 'launch-two');
      expect((await login(null, { companyId: 'co-b', operatorId: 'bob', password: 'password' })).success).toBe(true);
      expect(fs.existsSync(path.join(credentials, 'co-a.operator.enc'))).toBe(true);
      expect(fs.existsSync(path.join(credentials, 'co-b.operator.enc'))).toBe(true);

      cwd = path.join(userData, 'launch-three');
      expect((await revoke(null, 'co-a')).success).toBe(true);
      expect(clients.at(-1)?.operatorToken).toBe('session-alice');
      expect(fs.existsSync(path.join(credentials, 'co-a.operator.enc'))).toBe(false);
       expect(store.readOperatorSession('co-b', { baseDir: credentials, safeStorage })).toBe('session-bob');
      expect((await revoke(null, 'co-b')).success).toBe(true);
      expect(clients.at(-1)?.operatorToken).toBe('session-bob');
      expect(fs.existsSync(path.join(credentials, 'co-b.operator.enc'))).toBe(false);
       for (const launch of ['launch-one', 'launch-two', 'launch-three']) {
         expect(fs.existsSync(path.join(userData, launch))).toBe(false);
       }
       // Prove the actual store's fallback follows the controlled VM CWD, not
       // the test runner's process CWD. All fallback artifacts stay in userData.
       store.storeOperatorSession('fallback', 'fixture-token', { safeStorage });
       expect(store.readOperatorSession('fallback', { safeStorage })).toBe('fixture-token');
       expect(fs.existsSync(path.join(cwd, '.credentials_vault', 'fallback.operator.enc'))).toBe(true);
       expect(store.deleteOperatorSession('fallback')).toBe(true);
    } finally {
      cwd = initialCwd;
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });
});
