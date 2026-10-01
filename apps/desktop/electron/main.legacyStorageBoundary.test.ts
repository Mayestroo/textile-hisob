import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const mainSource = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

function handlerBlock(channel: string): string {
  const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
  if (start < 0) throw new Error(`Handler not found: ${channel}`);
  const next = mainSource.indexOf('\nipcMain.handle(', start + 1);
  return mainSource.slice(start, next < 0 ? mainSource.length : next);
}

describe('legacy archive and backup IPC boundary', () => {
  it.each([
    'archives-list-meta',
    'archives-list',
    'archive-save',
    'archive-read',
    'backups-list',
    'backup-read',
    'backup-restore'
  ])('rejects %s before legacy storage access in ', (channel) => {
    const block = handlerBlock(channel);
    const guard = block.indexOf("if (selectedRuntimeMode === 'sync') return LegacyStorageForbidden();");
    expect(guard).toBeGreaterThanOrEqual(0);

    for (const forbidden of [
      'validateTargetCompanyId',
      'getArchivesDir',
      'getBackupsDir',
      'fs.readFileSync',
      'fs.writeFileSync',
      'fs.promises.readFile'
    ]) {
      const access = block.indexOf(forbidden);
      if (access >= 0) expect(guard).toBeLessThan(access);
    }
  });
});
