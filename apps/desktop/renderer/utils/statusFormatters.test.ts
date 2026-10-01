import { describe, expect, it } from 'vitest';
import { resolveDatabaseStatusLabel } from './statusFormatters';

describe('database status label', () => {
  it('describes  connectivity without implying a legacy JSON provider', () => {
    expect(resolveDatabaseStatusLabel({ runtimeMode: 'sync', online: true, isServerConnected: true, isSaving: false }))
      .toBe('Online · ');
    expect(resolveDatabaseStatusLabel({ runtimeMode: 'sync', online: false, isServerConnected: false, isSaving: false }))
      .toBe('Offline · Lokal');
    expect(resolveDatabaseStatusLabel({ runtimeMode: 'sync', online: true, isServerConnected: false, isSaving: false }))
      .toBe(' · Lokal');
  });

  it('keeps legacy status labels scoped to legacy runtime', () => {
    expect(resolveDatabaseStatusLabel({ runtimeMode: 'legacy', online: false, isServerConnected: false, isSaving: false }))
      .toBe('Lokal xotira');
  });
});
