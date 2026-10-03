import { afterEach, expect, it } from 'vitest';
import path from 'node:path';
import { loadConfigFromFile } from 'vite';

const originalVersion = process.env.VITE_APP_VERSION;

afterEach(() => {
  if (originalVersion === undefined) delete process.env.VITE_APP_VERSION;
  else process.env.VITE_APP_VERSION = originalVersion;
});

it('uses a local VITE_APP_VERSION override and otherwise follows the package version', async () => {
  const configPath = path.resolve(__dirname, '../../vite.config.mts');
  process.env.VITE_APP_VERSION = '1.7.18';
  const overridden = await loadConfigFromFile({ command: 'build', mode: 'production' }, configPath);
  expect(overridden?.config.define?.['import.meta.env.VITE_APP_VERSION']).toBe('"1.7.18"');

  delete process.env.VITE_APP_VERSION;
  const canonical = await loadConfigFromFile({ command: 'build', mode: 'production' }, configPath);
  expect(canonical?.config.define?.['import.meta.env.VITE_APP_VERSION']).toBe('"1.1.1"');
});
