#!/usr/bin/env node
'use strict';

/**
 * Creates or updates a server operator (admin / accountant) who can sign in on
 * a desktop to review and cancel held allocations ("Ko'rib chiqish").
 *
 * Run on the VPS, next to the server's DATABASE_URL:
 *   OPERATOR_PASSWORD='...' node scripts/maintenance/provision-operator.cjs \
 *     --company comp_novda --id admin --name "Admin" --role admin
 *
 * The password is read from OPERATOR_PASSWORD (or stdin when unset) so it does
 * not end up in shell history or the process list. Minimum length: 8.
 */

const { Pool } = require('pg');
const { provisionOperator } = require('../../apps/server/auth/operatorAuth.cjs');
const { resolveDatabaseUrl } = require('../../apps/server/infrastructure/connectionConfig.cjs');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    args[key.slice(2)] = value;
    index += 1;
  }
  return args;
}

async function readPassword() {
  if (process.env.OPERATOR_PASSWORD) return process.env.OPERATOR_PASSWORD;
  if (process.stdin.isTTY) process.stderr.write('Operator password (input is visible; prefer OPERATOR_PASSWORD): ');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const missing = ['company', 'id', 'name', 'role'].filter((key) => !args[key]);
  if (missing.length) {
    throw new Error(`Required: --company --id --name --role (admin|accountant). Missing: ${missing.join(', ')}`);
  }
  const password = await readPassword();
  if (typeof password !== 'string' || password.length < 8) throw new Error('Password must be at least 8 characters');

  const pool = new Pool({ connectionString: resolveDatabaseUrl(process.env) });
  try {
    const result = await provisionOperator(pool, {
      operatorId: args.id, companyId: args.company, displayName: args.name, role: args.role, password
    });
    process.stdout.write(`Operator ready: ${result.operatorId} (${result.role}) for ${result.companyId}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`provision-operator failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs };
