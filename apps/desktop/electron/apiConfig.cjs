'use strict';

const DEFAULT__API_BASE_URL = 'https://sync.novdatextile.uz';

function resolveApiBaseUrl(options = {}) {
  const env = options.env || process.env;
  const rawUrl = options.baseUrl || env.NOVDA_SYNC_SERVER_URL || DEFAULT__API_BASE_URL;
  let parsed;
  try { parsed = new URL(rawUrl); } catch {
    const error = new Error('SYNC_SERVER_URL_INVALID');
    error.code = 'SYNC_SERVER_URL_INVALID';
    throw error;
  }
  const allowHttp = options.allowHttp === true || env.NODE_ENV === 'test' || env.NODE_ENV === 'development';
  if (!parsed.hostname || (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:'))) {
    const error = new Error('SYNC_SERVER_TLS_REQUIRED');
    error.code = 'SYNC_SERVER_TLS_REQUIRED';
    throw error;
  }
  const localMode = options.allowHttp === true || env.NODE_ENV === 'test' || env.NODE_ENV === 'development';
  if (!localMode && (parsed.origin !== new URL(DEFAULT__API_BASE_URL).origin || parsed.pathname.replace(/\/+$/, '') !== '')) {
    const error = new Error('SYNC_SERVER_HOST_NOT_APPROVED');
    error.code = 'SYNC_SERVER_HOST_NOT_APPROVED';
    throw error;
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

module.exports = { DEFAULT__API_BASE_URL, resolveApiBaseUrl };
