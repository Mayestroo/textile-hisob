import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Electron Packaging Rules & Allowlist', () => {
  const root = path.resolve(__dirname, '../..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const buildFiles = packageJson.build.files as (string | Record<string, unknown>)[];

  it('contains explicit inclusions for production assets only', () => {
    expect(buildFiles).toContain('dist/**/*');
    expect(buildFiles).toContain('apps/desktop/electron/**/*');
    expect(buildFiles).toContain('packages/**/*');
    expect(buildFiles).toContain('apps/desktop/build/icon.ico');
    expect(buildFiles).toContain('package.json');
  });

  it('strictly excludes non-production directories, tests, harnesses, and scripts', () => {
    expect(buildFiles).toContain('!apps/desktop/electron/**/*.test.*');
    expect(buildFiles).toContain('!apps/desktop/electron/tests/**');
    expect(buildFiles).toContain('!packages/**/*.test.*');
    expect(buildFiles).toContain('!packages/**/*.py');
    expect(buildFiles).toContain('!**/*.py');
    expect(buildFiles).toContain('!**/*.md');
    expect(buildFiles).toContain('!apps/desktop/build/installer.nsh');
    expect(buildFiles).toContain('!node_modules/**');
  });

  it('does not package server, ops, test tooling, or documentation roots', () => {
    for (const rule of buildFiles) {
      if (typeof rule === 'string') {
        expect(rule).not.toMatch(/^apps\/server/);
        expect(rule).not.toMatch(/^ops/);
        expect(rule).not.toMatch(/^scripts/);
        expect(rule).not.toMatch(/^docs/);
      }
    }
  });

  it('unpacks native better-sqlite3 from asar archive', () => {
    expect(packageJson.build.asarUnpack).toContain('**/node_modules/better-sqlite3/**/*');
  });

  it('contains only production runtime files and zero tests, docs, or server code in built app.asar', () => {
    const asarPath = path.join(root, 'dist-build/win-unpacked/resources/app.asar');
    if (!fs.existsSync(asarPath)) {
      return; // Skip if packaging has not run yet in this environment
    }
    const { execSync } = require('node:child_process');
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const output = execSync(`${npx} asar list "${asarPath}"`, { encoding: 'utf8' });
    const lines = output.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);

    // Verify absence of forbidden content
    expect(lines.some((l: string) => l.includes('.test.'))).toBe(false);
    expect(lines.some((l: string) => l.includes('/tests/') || l.includes('\\tests\\'))).toBe(false);
    expect(lines.some((l: string) => l.includes('apps/server') || l.includes('apps\\server'))).toBe(false);
    expect(lines.some((l: string) => l.startsWith('\\ops') || l.startsWith('/ops'))).toBe(false);
    expect(lines.some((l: string) => l.startsWith('\\docs') || l.startsWith('/docs'))).toBe(false);
    expect(lines.some((l: string) => l.startsWith('\\scripts') || l.startsWith('/scripts'))).toBe(false);
    expect(lines.some((l: string) => l.endsWith('.py'))).toBe(false);
    expect(lines.some((l: string) => l.endsWith('.map'))).toBe(false);
    expect(lines.some((l: string) => l.includes('.env'))).toBe(false);
    expect(lines.some((l: string) => l.endsWith('.sqlite') || l.endsWith('.db'))).toBe(false);
    expect(lines.some((l: string) => l.includes('webapp'))).toBe(false);

    // Verify presence of required runtime files
    expect(lines.some((l: string) => l.endsWith('electron\\main.cjs') || l.endsWith('electron/main.cjs'))).toBe(true);
    expect(lines.some((l: string) => l.endsWith('dist\\index.html') || l.endsWith('dist/index.html'))).toBe(true);
    expect(lines.some((l: string) => l.endsWith('licensePublicKey.cjs'))).toBe(true);
    expect(lines.some((l: string) => l.includes('better-sqlite3'))).toBe(true);
  });
});
