'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const excluded = new Set(['.git', 'node_modules', 'dist', 'dist-build', 'dist-installer']);
const allowed = new Set(['.env.example', 'telegram_admin_config.example.json']);
const privateKeyPattern = /-----BEGIN (?:RSA |EC |OPENSSH |ED25519 )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]+\s+-----END (?:RSA |EC |OPENSSH |ED25519 )?PRIVATE KEY-----/g;
const patterns = [
  { name: 'telegram token', re: /\b\d{7,12}:AA[A-Za-z0-9_-]{30,}\b/g },
  { name: 'private key', re: privateKeyPattern },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g }
];

function walk(dir, findings, scanRoot) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, findings, scanRoot);
    else if (entry.isFile() && !allowed.has(entry.name) && fs.statSync(full).size < 1024 * 1024) {
      const text = fs.readFileSync(full, 'utf8');
      for (const pattern of patterns) {
        // These regexes are global so each file must begin matching at offset zero.
        pattern.re.lastIndex = 0;
        if (pattern.re.test(text)) findings.push(`${path.relative(scanRoot, full)}: ${pattern.name}`);
      }
    }
  }
}

function scan(scanRoot = root) {
  const findings = [];
  walk(scanRoot, findings, scanRoot);
  return findings;
}

function containsPrivateKeyBlock(text) {
  privateKeyPattern.lastIndex = 0;
  return privateKeyPattern.test(text);
}

if (require.main === module) {
  const findings = scan();
  if (findings.length) {
    console.error(`SECRET_SCAN_FAILED\n${findings.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('SECRET_SCAN_PASS');
  }
}

module.exports = { scan, containsPrivateKeyBlock };
