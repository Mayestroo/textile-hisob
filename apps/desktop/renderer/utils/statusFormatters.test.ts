import { describe, expect, it } from 'vitest';
import { resolveDatabaseStatusLabel } from './statusFormatters';

describe('database status label', () => {
  it('distinguishes an online server from queued and rejected local operations', () => {
    expect(resolveDatabaseStatusLabel({ runtimeMode: 'sync', online: true, isServerConnected: true, isSaving: false }))
      .toBe('VPS bilan sinxron');
    expect(resolveDatabaseStatusLabel({ runtimeMode: 'sync', online: false, isServerConnected: false, isSaving: false }))
      .toBe('Offline · Lokal');
    expect(resolveDatabaseStatusLabel({ runtimeMode: 'sync', online: true, isServerConnected: false, isSaving: false }))
      .toBe('VPS sync kutilmoqda');
    expect(resolveDatabaseStatusLabel({ runtimeMode: 'sync', online: true, isServerConnected: true, isSaving: false, pendingChanges: 2 }))
      .toBe('VPS navbatida · 2');
    expect(resolveDatabaseStatusLabel({ runtimeMode: 'sync', online: true, isServerConnected: true, isSaving: false, failedChanges: 1 }))
      .toBe('Sync xatosi · 1');
  });

  it('keeps legacy status labels scoped to legacy runtime', () => {
    expect(resolveDatabaseStatusLabel({ runtimeMode: 'legacy', online: false, isServerConnected: false, isSaving: false }))
      .toBe('Lokal xotira');
  });
});
