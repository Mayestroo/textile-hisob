const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const expected = {
  'apps/desktop/renderer/store/slices/createPattaBatchSlice.ts': 'c4d66bb4f5fcc1b47443010e4c94d919fced2af5428ae396142f7290577ff05d',
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
