'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function assertReleaseVersion(packageJson, packageLock) {
  const version = packageJson?.version;
  if (!version || packageLock?.version !== version || packageLock?.packages?.['']?.version !== version) {
    const error = new Error('RC_VERSION_REQUIRED: package.json and package-lock.json versions must match');
    error.code = 'RC_VERSION_REQUIRED';
    throw error;
  }
  return version;
}

function calculateArtifactIdentity(artifactPath) {
  const stat = fs.statSync(artifactPath);
  if (!stat.isFile() || stat.size <= 0) {
    const error = new Error(`RC_ARTIFACT_INVALID: ${artifactPath}`);
    error.code = 'RC_ARTIFACT_INVALID';
    throw error;
  }
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
  return { file: path.basename(artifactPath), sizeBytes: stat.size, sha256 };
}

function run(command, args, root, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32'
  });
  if (result.error || result.status !== 0) {
    const error = new Error(`RC_BUILD_COMMAND_FAILED: ${command} ${args.join(' ')}`);
    error.code = 'RC_BUILD_COMMAND_FAILED';
    error.cause = result.error;
    throw error;
  }
}

function buildReleaseCandidate(root = path.resolve(__dirname, '../..')) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const version = assertReleaseVersion(packageJson, packageLock);
  const artifactName = `Novda-hisob-kitob-Setup-${version}-win10-11-x64.exe`;

  const artifactPath = path.join(root, 'dist-build', artifactName);
  if (fs.existsSync(artifactPath)) {
    const error = new Error(`RC_ARTIFACT_ALREADY_EXISTS: refusing to overwrite ${artifactName}`);
    error.code = 'RC_ARTIFACT_ALREADY_EXISTS';
    throw error;
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  run(npm, ['run', 'build'], root, { ...process.env, VITE_APP_VERSION: packageJson.version });
  run(npx, ['electron-builder', '--win', 'nsis', '--publish', 'never'], root);

  if (!fs.existsSync(artifactPath)) {
    const error = new Error(`RC_ARTIFACT_MISSING: expected ${artifactName}`);
    error.code = 'RC_ARTIFACT_MISSING';
    throw error;
  }

  const identity = calculateArtifactIdentity(artifactPath);
  process.stdout.write(`LOCAL_RC_ARTIFACT ${JSON.stringify(identity)}\n`);
  return identity;
}

if (require.main === module) {
  try {
    buildReleaseCandidate();
  } catch (error) {
    const code = error?.code || 'RC_BUILD_FAILED';
    process.stderr.write(`${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { assertReleaseVersion, calculateArtifactIdentity, buildReleaseCandidate };
