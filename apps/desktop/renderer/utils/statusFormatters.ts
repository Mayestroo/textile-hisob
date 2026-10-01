export type DatabaseRuntimeMode = 'checking' | 'legacy' | 'sync';

export function resolveDatabaseStatusLabel(input: {
  runtimeMode: DatabaseRuntimeMode;
  online: boolean;
  isServerConnected: boolean;
  isSaving: boolean;
}): string {
  if (input.runtimeMode === 'checking') return 'Tekshirilmoqda…';
  if (input.isSaving) return 'Saqlanmoqda…';
  if (input.runtimeMode === 'sync') {
    if (!input.online) return 'Offline · Lokal';
    return input.isServerConnected ? 'Online · ' : ' · Lokal';
  }
  return input.isServerConnected ? 'Server faol' : 'Lokal xotira';
}
