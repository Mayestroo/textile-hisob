const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const expected = {
  'apps/desktop/renderer/store/slices/createPattaBatchSlice.ts': '68cb6c35b3ab817efcf848d02e4254794d33d2608f5662e370a4d3e7adc36e3e',
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
