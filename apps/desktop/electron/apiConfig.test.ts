import { describe, expect, it } from 'vitest';

const { DEFAULT__API_BASE_URL, resolveApiBaseUrl } = require('./apiConfig.cjs');

describe('production  API URL configuration', () => {
  it('pins the owned production subdomain as the default URL', () => {
    expect(DEFAULT__API_BASE_URL).toBe('https://sync.novdatextile.uz');
    expect(resolveApiBaseUrl({ env: {} })).toBe(DEFAULT__API_BASE_URL);
  });

  it('rejects HTTP production URLs while permitting local test transports', () => {
    expect(() => resolveApiBaseUrl({ baseUrl: 'http://sync.novdatextile.uz', env: { NODE_ENV: 'production' } }))
      .toThrowError(expect.objectContaining({ code: 'SYNC_SERVER_TLS_REQUIRED' }));
    expect(resolveApiBaseUrl({ baseUrl: 'http://127.0.0.1:3474', env: { NODE_ENV: 'test' } }))
      .toBe('http://127.0.0.1:3474');
  });
});
