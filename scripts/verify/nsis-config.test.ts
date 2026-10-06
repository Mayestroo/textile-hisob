import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package-lock.json'), 'utf8'));

describe('Windows NSIS release configuration', () => {
  it('keeps the existing application identity and x64 installer artifact name', () => {
    expect(packageJson.build.appId).toBe('com.novda.hisob');
    expect(packageJson.build.productName).toBe('Novda-hisob-kitob');
    expect(packageJson.build.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
    expect(packageJson.build.files).toContain('!apps/desktop/build/installer.nsh');
    expect(packageJson.build.nsis.artifactName).toBe(
      'Novda-hisob-kitob-Setup-${version}-win10-11-x64.exe'
    );
  });

  it('pins installation to the existing per-user scope and preserves Electron userData', () => {
    expect(packageJson.build.nsis).toMatchObject({
      oneClick: true,
      perMachine: false,
      deleteAppDataOnUninstall: false,
      include: 'apps/desktop/build/installer.nsh'
    });
    expect(packageJson.build.nsis).not.toHaveProperty('allowToChangeInstallationDirectory');
  });

  it('logs the old-uninstaller failure and accepts only a positive no-process result', () => {
    const installerInclude = fs.readFileSync(path.resolve(__dirname, '../../apps/desktop/build/installer.nsh'), 'utf8');
    const resultGuard = installerInclude.indexOf('IfFileExists "$PLUGINSDIR\\Novda-process-check.txt" 0 NovdaProcessCheckNoPreviousResult');
    const staleResultDelete = installerInclude.indexOf('Delete "$PLUGINSDIR\\Novda-process-check.txt"');

    expect(resultGuard).toBeGreaterThanOrEqual(0);
    expect(staleResultDelete).toBeGreaterThan(resultGuard);
    expect(installerInclude).toContain('OldUninstallerExitCode=$R0');
    expect(installerInclude).toContain('Get-CimInstance -ClassName Win32_Process');
    expect(installerInclude).toContain('StartsWith');
    expect(installerInclude).toContain('SetEnvironmentVariable(t, t)');
    expect(installerInclude).toContain('NOVDA_NSIS_INSTALL_DIR');
    expect(installerInclude).toContain("'NO_PROCESS'");
    expect(installerInclude).toContain("'PROCESS_RUNNING'");
    expect(installerInclude).toContain("'CHECK_FAILED'");
    expect(installerInclude).toContain(').R3');
    expect(installerInclude).toContain(').R4');
    expect(installerInclude).not.toContain(').r3');
    expect(installerInclude).not.toContain(').r4');
    expect(installerInclude).toContain('Delete "$PLUGINSDIR\\Novda-process-check.txt"');
    expect(installerInclude).not.toMatch(/^\s*FileDelete\s/m);
    expect(installerInclude).toContain('StrCpy $R2 1');
    expect(installerInclude).toContain('${andIf} $R2 == 1');
    expect(installerInclude).toContain('${andIf} $R1 == "NO_PROCESS"');
    expect(installerInclude).toContain('IfSilent NovdaProcessCheckSilentAbort');
    expect(installerInclude).not.toContain("StartsWith('$INSTDIR'");
    expect(installerInclude).toContain('RecoveryDecision=continue-with-in-place-file-replacement');
    expect(installerInclude).toContain('SetErrorLevel 2');
  });

  it('does not mistake PowerShell parse failure for a no-process result on quoted paths', () => {
    const installerInclude = fs.readFileSync(path.resolve(__dirname, '../../apps/desktop/build/installer.nsh'), 'utf8');
    const commandMatch = installerInclude.match(/powershell\.exe[^\r\n]*-Command "([^"]+)"/);
    expect(commandMatch).not.toBeNull();
    const powershellScript = commandMatch![1].replace(/\$\$/g, '$');
    expect(powershellScript).toContain("[IO.Path]::GetFullPath($root).TrimEnd([char]92)");
    expect(powershellScript).toContain("[StringComparison]::OrdinalIgnoreCase");
    if (process.platform !== 'win32') return;

    const resultPath = path.join(os.tmpdir(), `novda-process-check-${process.pid}.txt`);

    try {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershellScript], {
        encoding: 'utf8',
        env: {
          ...process.env,
          NOVDA_NSIS_INSTALL_DIR: path.join(os.tmpdir(), "O'Connor", 'Novda-hisob-kitob'),
          NOVDA_NSIS_PROCESS_CHECK_RESULT: resultPath
        }
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(fs.readFileSync(resultPath, 'utf8')).toBe('NO_PROCESS');
    } finally {
      fs.rmSync(resultPath, { force: true });
    }
  });

  it('keeps package and lockfile release versions aligned', () => {
    expect(packageJson.version).toBe('1.1.2');
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[''].version).toBe(packageJson.version);
  });

  it('builds the installer matrix against the current release version', () => {
    const matrix = fs.readFileSync(path.resolve(__dirname, '../../ops/windows-sandbox/nsis-upgrade-matrix.ps1'), 'utf8');
    expect(matrix).toContain("$finalVersion = '1.1.2'");
    expect(matrix).toContain("'G: exit code 2 with no running app repairs through in-place replacement'");
    expect(matrix).toContain("'H: exit code 2 with a running app aborts without replacing files'");
    expect(matrix).toContain("RecoveryDecision=abort-process-remains-or-check-failed");
  });

  it('does not expose the legacy auto-publish workflow or allow implicit builder publication', () => {
    for (const name of ['dist', 'dist:patch', 'dist:minor', 'dist:major']) {
      expect(packageJson.scripts).not.toHaveProperty(name);
    }
    expect(packageJson.scripts['dist:local']).toContain('--publish never');
    expect(fs.existsSync(path.resolve(__dirname, '../../scripts/release.cjs'))).toBe(false);
  });
});
