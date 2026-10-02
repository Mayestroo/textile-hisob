export type DatabaseRuntimeMode = 'checking' | 'legacy' | 'sync';

export function resolveDatabaseStatusLabel(input: {
  runtimeMode: DatabaseRuntimeMode;
  online: boolean;
  isServerConnected: boolean;
  isSaving: boolean;
  pendingChanges?: number;
  failedChanges?: number;
}): string {
  if (input.runtimeMode === 'checking') return 'Tekshirilmoqda…';
  if (input.isSaving) return 'Saqlanmoqda…';
  if (input.runtimeMode === 'sync') {
    if (!input.online) return 'Offline · Lokal';
    if ((input.failedChanges || 0) > 0) return `Sync xatosi · ${input.failedChanges}`;
    if (!input.isServerConnected) return 'VPS tasdig‘i yo‘q';
    if ((input.pendingChanges || 0) > 0) return `VPS navbatida · ${input.pendingChanges}`;
    return 'VPS bilan sinxron';
  }
  return input.isServerConnected ? 'Server faol' : 'Lokal xotira';
}
