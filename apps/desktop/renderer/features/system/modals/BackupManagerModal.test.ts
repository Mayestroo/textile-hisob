import { describe, expect, it, vi } from 'vitest';
import { requestBackupRestore } from './BackupManagerModal';

describe('backup restore production contract', () => {
  it('passes the active company through the renderer API contract', async () => {
    const backupRestore = vi.fn().mockResolvedValue({ success: true });
    await requestBackupRestore({ backupRestore }, 'backup.json', 'company-a');
    expect(backupRestore).toHaveBeenCalledWith('backup.json', 'company-a');
  });

  it('fails closed without an active company', async () => {
    const backupRestore = vi.fn();
    await expect(requestBackupRestore({ backupRestore }, 'backup.json', undefined)).rejects.toThrow('company context');
    expect(backupRestore).not.toHaveBeenCalled();
  });
});
