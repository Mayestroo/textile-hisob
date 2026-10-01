import { describe, expect, it } from 'vitest';

// @ts-ignore CommonJS boundary under test
const runtimeMode = require('./runtimeMode.cjs');

function healthyDependencies() {
  return runtimeMode.loadDefaultDependencies();
}

function healthyInput(overrides: Record<string, unknown> = {}) {
  return {
    companyId: 'company-a',
    licenseStatus: {
      isActivated: true,
      isBlocked: false,
      companyId: 'company-a'
    },
    db: { open: true },
    deviceCredential: 'device-token',
    syncServerUrl: 'https://sync.example.test',
    verifySchemaVersionConsistency: () => runtimeMode.LATEST_SCHEMA_VERSION,
    runDatabaseIntegrityChecks: () => ({ integrityCheck: 'ok', foreignKeyCheck: [] }),
    dependencies: healthyDependencies(),
    ...overrides
  };
}

describe('explicit Electron runtime mode', () => {
  it('defaults to local mode and accepts only the exact sync opt-in value', () => {
    expect(runtimeMode.resolveRuntimeMode({})).toBe('legacy');
    expect(runtimeMode.resolveRuntimeMode({ NOVDA_SYNC_ENABLED: '0' })).toBe('legacy');
    expect(runtimeMode.resolveRuntimeMode({ NOVDA_SYNC_ENABLED: '01' })).toBe('legacy');
    expect(runtimeMode.resolveRuntimeMode({ NOVDA_SYNC_ENABLED: 'true' })).toBe('legacy');
    expect(runtimeMode.resolveRuntimeMode({ NOVDA_SYNC_ENABLED: '1' })).toBe('sync');
  });

  it('forces packaged clients onto sync regardless of opt-out values', () => {
    expect(runtimeMode.resolveRuntimeMode({ NOVDA_SYNC_ENABLED: '0' }, { packaged: true })).toBe('sync');
    expect(runtimeMode.resolveRuntimeMode({}, { packaged: true })).toBe('sync');
  });

  it('keeps the activation screen available while  authorization is pending, but fails closed for runtime defects', () => {
    expect(runtimeMode.canOpenActivationUi({ code: 'COMPANY_BINDING_REQUIRED' })).toBe(true);
    expect(runtimeMode.canOpenActivationUi({ code: 'LICENSE_NOT_ACTIVATED' })).toBe(true);
    expect(runtimeMode.canOpenActivationUi({ code: 'DEVICE_CREDENTIAL_REQUIRED' })).toBe(true);
    expect(runtimeMode.canOpenActivationUi({ code: 'DATABASE_CORRUPT' })).toBe(false);
  });

  it('rejects a missing company binding', () => {
    expect(() => runtimeMode.assertReadiness(healthyInput({ companyId: null }))).toThrowError(
      expect.objectContaining({ code: 'COMPANY_BINDING_REQUIRED' })
    );
  });

  it('rejects a license without activation or with a revoked status', () => {
    expect(() => runtimeMode.assertReadiness(healthyInput({
      licenseStatus: { companyId: 'company-a', isActivated: false, isBlocked: false }
    }))).toThrowError(expect.objectContaining({ code: 'LICENSE_NOT_ACTIVATED' }));

    expect(() => runtimeMode.assertReadiness(healthyInput({
      licenseStatus: { companyId: 'company-a', isActivated: true, isBlocked: false, status: 'revoked' }
    }))).toThrowError(expect.objectContaining({ code: 'LICENSE_REVOKED' }));

    expect(() => runtimeMode.assertReadiness(healthyInput({
      licenseStatus: { companyId: 'company-a', isActivated: true, isBlocked: true }
    }))).toThrowError(expect.objectContaining({ code: 'LICENSE_BLOCKED' }));
  });

  it('rejects a missing device credential and malformed sync URL', () => {
    expect(() => runtimeMode.assertReadiness(healthyInput({ deviceCredential: '' }))).toThrowError(
      expect.objectContaining({ code: 'DEVICE_CREDENTIAL_REQUIRED' })
    );
    expect(() => runtimeMode.assertReadiness(healthyInput({ syncServerUrl: 'sync.example.test' }))).toThrowError(
      expect.objectContaining({ code: 'SYNC_SERVER_URL_INVALID' })
    );
    expect(() => runtimeMode.assertReadiness(healthyInput({ syncServerUrl: 'ftp://sync.example.test' }))).toThrowError(
      expect.objectContaining({ code: 'SYNC_SERVER_URL_INVALID' })
    );
  });

  it('fails closed when SQLite is unavailable or schema is not current', () => {
    expect(() => runtimeMode.assertReadiness(healthyInput({ db: null }))).toThrowError(
      expect.objectContaining({ code: 'DATABASE_OPEN_FAILED' })
    );
    expect(() => runtimeMode.assertReadiness(healthyInput({
      verifySchemaVersionConsistency: () => runtimeMode.LATEST_SCHEMA_VERSION - 1
    }))).toThrowError(expect.objectContaining({ code: 'SCHEMA_VERSION_MISMATCH' }));
    expect(() => runtimeMode.assertReadiness(healthyInput({
      databaseError: Object.assign(new Error('open failed'), { code: 'DATABASE_OPEN_FAILED' })
    }))).toThrowError(expect.objectContaining({ code: 'DATABASE_OPEN_FAILED' }));
  });

  it('fails closed on SQLite integrity and foreign-key failures', () => {
    expect(() => runtimeMode.assertReadiness(healthyInput({
      runDatabaseIntegrityChecks: () => {
        throw Object.assign(new Error('corrupt'), { code: 'DATABASE_CORRUPT' });
      }
    }))).toThrowError(expect.objectContaining({ code: 'DATABASE_CORRUPT' }));

    expect(() => runtimeMode.assertReadiness(healthyInput({
      runDatabaseIntegrityChecks: () => ({
        integrityCheck: 'ok',
        foreignKeyCheck: [{ table: 'ticket_entries', rowid: 1 }]
      })
    }))).toThrowError(expect.objectContaining({ code: 'DATABASE_FOREIGN_KEY_VIOLATION' }));
  });

  it('fails closed when a required  dependency is missing', () => {
    expect(() => runtimeMode.assertReadiness(healthyInput({ dependencies: {} }))).toThrowError(
      expect.objectContaining({ code: 'SYNC_DEPENDENCIES_UNAVAILABLE' })
    );
  });

  it('returns  readiness without providing a legacy fallback', () => {
    expect(runtimeMode.assertReadiness(healthyInput())).toEqual({ mode: 'sync', companyId: 'company-a' });
  });
});
