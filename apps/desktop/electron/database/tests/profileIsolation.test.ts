import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const manager = require('../core/databaseManager.cjs');
describe('same-company SQLite connections across isolated upgrade/restore profiles', () => {
  const directories: string[] = [];
  afterEach(() => {
    manager.closeAllCompanyDatabases();
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });
  it('uses the requested file identity instead of reusing another profile by company ID', () => {
    const profile = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-profile-isolation-')); directories.push(dir); return dir; };
    const firstRoot = profile(), secondRoot = profile();
    const first = manager.getCompanyDatabase(firstRoot, 'same-company');
    first.prepare("INSERT INTO local_meta(key,value,updated_at) VALUES ('profile-proof','first',datetime('now'))").run();
    const second = manager.getCompanyDatabase(secondRoot, 'same-company');
    expect(second.name).not.toBe(first.name);
    expect(second.prepare("SELECT value FROM local_meta WHERE key='profile-proof'").get()).toBeUndefined();
    second.prepare("INSERT INTO local_meta(key,value,updated_at) VALUES ('profile-proof','second',datetime('now'))").run();
    expect(manager.getCompanyDatabase(firstRoot, 'same-company')).toBe(first);
    expect(first.prepare("SELECT value FROM local_meta WHERE key='profile-proof'").get().value).toBe('first');
    expect(manager.closeCompanyDatabase('same-company')).toBe(true);
    expect(first.open).toBe(false); expect(second.open).toBe(false);
  });
});
