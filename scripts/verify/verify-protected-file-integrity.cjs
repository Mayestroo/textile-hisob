const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const expected = {
  'apps/desktop/renderer/store/slices/createPattaBatchSlice.ts': '8c966e35f2d6c2e8cf784260c4f18f8f15489a883179df600d876ab58a8cdb44',
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
