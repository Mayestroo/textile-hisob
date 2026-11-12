import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');

function serverModules(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return serverModules(file);
    return entry.isFile() && entry.name.endsWith('.cjs') ? [file] : [];
  });
}

describe('production API Dockerfile', () => {
  it('copies all shared modules required by server runtime', () => {
    const dockerfile = fs.readFileSync(path.join(root, 'ops/deploy/Dockerfile'), 'utf8');
    const dependencies = new Set<string>();

    for (const file of serverModules(path.join(root, 'apps/server'))) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/require\(['"]([^'"]*packages\/[^'"]+\.cjs)['"]\)/g)) {
        dependencies.add(path.relative(root, path.resolve(path.dirname(file), match[1])).replace(/\\/g, '/'));
      }
    }

    expect(dependencies.size).toBeGreaterThan(0);
    for (const dependency of dependencies) {
      expect(fs.existsSync(path.join(root, dependency)), dependency).toBe(true);
      expect(dockerfile, dependency).toContain(`COPY ${dependency} ./${dependency}`);
    }
  });
});
