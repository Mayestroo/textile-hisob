'use strict';

const REQUIRED_CODE = 'DATABASE_URL_REQUIRED';
const INVALID_CODE = 'INVALID_DATABASE_URL';

function configError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validatePostgresDsn(value, source) {
  const label = source || 'DATABASE_URL';

  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
    throw configError(INVALID_CODE, `Invalid PostgreSQL DSN in ${label}`);
  }

  const dsn = value.trim();
  let parsed;
  try {
    parsed = new URL(dsn);
  } catch {
    throw configError(INVALID_CODE, `Invalid PostgreSQL DSN in ${label}`);
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw configError(INVALID_CODE, `Invalid PostgreSQL DSN in ${label}`);
  }

  if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw configError(INVALID_CODE, `Invalid PostgreSQL DSN in ${label}`);
  }

  let username;
  let password;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    throw configError(INVALID_CODE, `Invalid PostgreSQL DSN in ${label}`);
  }

  if (/\s/.test(username) || /\s/.test(password)) {
    throw configError(INVALID_CODE, `Invalid PostgreSQL DSN in ${label}`);
  }

  return parsed;
}

function resolveDatabaseUrl(env = process.env, options = {}) {
  const production = options.production === true || env.NODE_ENV === 'production';
  const source = production ? 'DATABASE_URL' : 'NOVDA_PG_URL/DATABASE_URL';
  const value = production ? env.DATABASE_URL : (env.NOVDA_PG_URL || env.DATABASE_URL);

  if (typeof value !== 'string' || !value.trim()) {
    throw configError(REQUIRED_CODE, 'Explicit PostgreSQL DSN is required');
  }

  validatePostgresDsn(value, source);
  return value.trim();
}

module.exports = {
  resolveDatabaseUrl,
  validatePostgresDsn
};
