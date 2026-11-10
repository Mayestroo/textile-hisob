const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const expected = {
  'apps/desktop/renderer/store/slices/createPattaBatchSlice.ts': '6329d63def7dec41ff028c0f0ef51bc59eb8282aea64ff31683a12bf472d7315',
};

let failed = false;

for (const [relativePath, expectedHash] of Object.entries(expected)) {
  const filePath = path.resolve(__dirname, '../../..', relativePath);
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const status = actualHash === expectedHash ? 'PASS' : 'FAIL';
  console.log(`${status} ${relativePath}: ${actualHash}`);
  if (actualHash !== expectedHash) failed = true;
}

if (failed) process.exitCode = 1;
