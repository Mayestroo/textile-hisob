const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '../../..');
const activeSignerFiles = [
  'apps/desktop/electron/license/license.cjs',
  'apps/bots/admin/src/admin_bot.py'
];
const forbiddenPatterns = [
  /NOVDA_LICENSE_HMAC_SECRET/,
  /NOVDA_LICENSE_SECRET/,
  /BEGIN (?:RSA |EC |OPENSSH |ED25519 )?PRIVATE KEY/,
  /NOVDA_2026_MASTER_SECRET_SECURITY_SALT_KEY_HISOB_PROD/
];

function fail(message) {
  console.error(`SIGNER_ENVIRONMENT_FAIL ${message}`);
  process.exitCode = 1;
}

for (const relativePath of activeSignerFiles) {
  const filePath = path.join(root, relativePath);
  const source = fs.readFileSync(filePath, 'utf8');
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(source)) fail(`${relativePath} contains ${pattern}`);
  }
}

function checkRendererFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      checkRendererFiles(filePath);
    } else if (/\.(?:[cm]?[jt]sx?|html)$/.test(entry.name)) {
      const source = fs.readFileSync(filePath, 'utf8');
      if (/NOVDA_LICENSE_(?:ED25519_PRIVATE_KEY|HMAC_SECRET|SECRET)|BEGIN (?:RSA |EC |OPENSSH |ED25519 )?PRIVATE KEY/.test(source)) {
        fail(`${path.relative(root, filePath)} contains private signer configuration or key material`);
      }
    }
  }
}
checkRendererFiles(path.join(root, 'apps/desktop/renderer'));

const adminSource = fs.readFileSync(path.join(root, 'apps/bots/admin/src/admin_bot.py'), 'utf8');
if (/NOVDA_LICENSE_ED25519_PRIVATE_KEY|def load_signer\(|def create_activation\(/.test(adminSource)) {
  fail('admin bot must not contain the retired production signer');
}

const generatorSource = fs.readFileSync(path.join(root, 'scripts/tools/generate_license.py'), 'utf8');
if (/NOVDA_LICENSE_ED25519_PRIVATE_KEY|BEGIN (?:RSA |EC |OPENSSH |ED25519 )?PRIVATE KEY/.test(generatorSource)) {
  fail('generate_license.py must not load or use production signer material');
}

const workerSource = fs.readFileSync(path.join(root, 'apps/bots/worker/src/worker_bot.py'), 'utf8');
if (!workerSource.includes('WORKER_AUTH_HMAC_SECRET') || /NOVDA_LICENSE_(?:HMAC_)?SECRET/.test(workerSource)) {
  fail('apps/bots/worker/src/worker_bot.py does not isolate WORKER_AUTH_HMAC_SECRET');
}

const activeEnvironmentFiles = [
  'apps/bots/worker/.env.example',
  'apps/server/production.env.example',
  'ops/env/novda-server.env.example',
  'ops/docs/PRODUCTION.md'
];
for (const relativePath of activeEnvironmentFiles) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  if (/NOVDA_LICENSE_HMAC_SECRET|NOVDA_LICENSE_SECRET/.test(source)) {
    fail(`${relativePath} contains a retired license HMAC variable`);
  }
}

const workerEnvironmentFiles = [
  'apps/bots/worker/.env.example'
];
for (const relativePath of workerEnvironmentFiles) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  if (!source.includes('WORKER_AUTH_HMAC_SECRET')) {
    fail(`${relativePath} is missing WORKER_AUTH_HMAC_SECRET`);
  }
}

const pythonCommands = process.env.PYTHON
  ? [process.env.PYTHON]
  : process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
const pythonEnv = {
  ...process.env,
  ...(process.platform === 'win32' ? {
    USERPROFILE: process.env.USERPROFILE || os.homedir(),
    APPDATA: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  } : {}),
  NOVDA_LICENSE_ED25519_PRIVATE_KEY: '',
  NOVDA_LICENSE_ED25519_PRIVATE_KEY_FILE: ''
};
let signerCheck;
for (const command of pythonCommands) {
  signerCheck = spawnSync(
    command,
    ['-c', "import sys; sys.path.insert(0, 'apps/bots/admin/src'); import admin_bot; assert not hasattr(admin_bot, 'load_signer') and not hasattr(admin_bot, 'create_activation'); print('SIGNER_REMOVED')"],
    {
      cwd: root,
      env: pythonEnv,
      encoding: 'utf8'
    }
  );
  if (!signerCheck.error && signerCheck.status === 0 && `${signerCheck.stderr}\n${signerCheck.stdout}`.includes('SIGNER_REMOVED')) break;
}

if (!signerCheck || signerCheck.error) {
  fail('Python interpreter is unavailable for the fail-closed signer check');
} else if (signerCheck.status !== 0 || !`${signerCheck.stderr}\n${signerCheck.stdout}`.includes('SIGNER_REMOVED')) {
  fail(`admin-bot signer removal check failed: ${signerCheck.stderr || signerCheck.stdout}`);
}

for (const command of pythonCommands) {
  const retiredGenerator = spawnSync(
    command,
    [path.join(root, 'scripts/tools/generate_license.py'), 'A588-F0E4-DE9A-59A2', 'company-a', 'Company A', 'admin'],
    { cwd: root, encoding: 'utf8', env: pythonEnv }
  );
  if (!retiredGenerator.error) {
    if (retiredGenerator.status === 0 || !`${retiredGenerator.stderr}\n${retiredGenerator.stdout}`.includes('PRODUCTION_SIGNER_IS_ADMIN_BOT_ONLY')) {
      fail('standalone generator did not refuse production signing');
    }
    break;
  }
}

if (process.exitCode !== 1) {
  console.log('SIGNER_ENVIRONMENT_PASS');
}
