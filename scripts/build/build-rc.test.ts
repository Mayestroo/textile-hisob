import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { assertReleaseVersion, calculateArtifactIdentity } = require('./build-rc.cjs');

describe('local RC build boundary', () => {
  let tempDirectory: string | undefined;

  afterEach(() => {
    if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  });

  it('accepts a matching package and lockfile version pair', () => {
    const packageJson = { version: '1.0.0' };
    const packageLock = { version: '1.0.0', packages: { '': { version: '1.0.0' } } };

    expect(() => assertReleaseVersion(packageJson, packageLock)).not.toThrow();
    expect(() => assertReleaseVersion({ version: '1.7.11' }, packageLock)).toThrowError(
      expect.objectContaining({ code: 'RC_VERSION_REQUIRED' })
    );
  });

  it('records a non-empty artifact byte size and SHA-256', () => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-rc-identity-'));
    const artifactPath = path.join(tempDirectory, 'candidate.exe');
    fs.writeFileSync(artifactPath, Buffer.from('local release candidate fixture'));

    const identity = calculateArtifactIdentity(artifactPath);

    expect(identity).toMatchObject({
      file: 'candidate.exe',
      sizeBytes: Buffer.byteLength('local release candidate fixture'),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });
});
