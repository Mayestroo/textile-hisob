import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
const { createDiagnostics, installRuntimeDiagnostics } = require('../diagnostics.cjs');
const roots: string[] = [];
const directory = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-diagnostics-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe('bounded privacy-safe operational diagnostics', () => {
  it('whitelists fields instead of attempting to redact arbitrary business payloads', () => {
    const dir = directory();
    createDiagnostics(dir)('SYNC_FAILURE', { code: 'ETIMEDOUT', message: 'secret worker amount token', url: 'postgres://password', payload: { amount: 100 } });
    const text = fs.readFileSync(path.join(dir, 'desktop-events.jsonl'), 'utf8');
    expect(text).toContain('ETIMEDOUT'); expect(text).not.toMatch(/secret|worker|amount|password|postgres/);
  });
  it('retains at most one previous bounded log', () => {
    const dir = directory(), record = createDiagnostics(dir, { maximumBytes: 100 });
    for (let i = 0; i < 20; i++) record('MAIN_STARTED');
    expect(fs.readdirSync(dir).sort()).toEqual(['desktop-events.jsonl', 'desktop-events.jsonl.previous']);
    for (const file of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, file)).size).toBeLessThan(250);
  });
  it('terminates once on uncaught main errors even when diagnostic storage is unavailable', () => {
    const app = new EventEmitter(), target = new EventEmitter(), exits: number[] = [];
    const dir = directory(), invalid = path.join(dir, 'not-a-directory'); fs.writeFileSync(invalid, 'retained');
    installRuntimeDiagnostics({ app, processTarget: target, directory: invalid, exit: (code: number) => exits.push(code) });
    target.emit('uncaughtException', new Error('private business values'));
    target.emit('unhandledRejection', new Error('another error'));
    expect(exits).toEqual([1]);
  });
});
