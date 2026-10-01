import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const mainSource = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');
const channel = 'command-resolve-reconciliation';

function registeredHandlerSource() {
  const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
  const end = mainSource.indexOf("ipcMain.handle('outbox-diagnostics'", start);
  return mainSource.slice(start, end);
}

describe('reconciliation IPC boundary', () => {
  it('exposes one fixed renderer bridge and no generic command executor', () => {
    expect(preloadSource).toContain(`ResolveReconciliationCandidate: (command) => ipcRenderer.invoke('${channel}', command)`);
    expect(preloadSource).not.toMatch(/(?:executeCommand|genericCommand|commandExecute)\s*:/);
    expect(mainSource).not.toMatch(/ipcMain\.handle\(['"](?:execute-command|command-execute)['"]/);
  });

  it('validates malformed commands before forwarding to the reconciliation command boundary', () => {
    const handler = registeredHandlerSource();
    expect(handler).toContain('validateTargetCompanyId(command?.companyId)');
    expect(handler.indexOf('validateTargetCompanyId(command?.companyId)')).toBeLessThan(
      handler.indexOf('executeResolveReconciliationCandidateCommand')
    );
  });

  it('forwards the original command exactly once to the authorized reconciliation boundary', () => {
    const handler = registeredHandlerSource();
    const invocations = handler.match(/executeResolveReconciliationCandidateCommand\(userData, compId, command\)/g) || [];
    expect(invocations).toHaveLength(1);
    expect(handler).toContain('const result = commandPipeline.executeResolveReconciliationCandidateCommand(userData, compId, command);');
  });

  it('returns command authorization and domain errors, including details, to the renderer', () => {
    const handler = registeredHandlerSource();
    expect(handler).toContain("code: err.code || 'COMMAND_FAILED'");
    expect(handler).toContain('details: err.details || null');
    expect(handler).toContain('error: err.message');
  });
});
