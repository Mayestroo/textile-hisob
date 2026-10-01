const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const expected = {
  'apps/desktop/renderer/store/slices/createPattaBatchSlice.ts': 'fe00381982f178f650d5a521d128a7639f334391c2592a9d09af18dd9cb2a059',
};

let failed = false;

for (const [relativePath, expectedHash] of Object.entries(expected)) {
  const filePath = path.resolve(__dirname, '../..', relativePath);
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const status = actualHash === expectedHash ? 'PASS' : 'FAIL';
  console.log(`${status} ${relativePath}: ${actualHash}`);
  if (actualHash !== expectedHash) failed = true;
}

if (failed) process.exitCode = 1;
