import { describe, expect, it } from 'vitest';

const { resolveDatabaseUrl, validatePostgresDsn } = require('./connectionConfig.cjs');

describe(' PostgreSQL connection configuration', () => {
  it('requires DATABASE_URL in production and ignores NOVDA_PG_URL there', () => {
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'production' })).toThrowError(
      expect.objectContaining({ code: 'DATABASE_URL_REQUIRED' })
    );
    expect(() => resolveDatabaseUrl({
      NODE_ENV: 'production',
      NOVDA_PG_URL: 'postgresql://test@localhost/test'
    })).toThrowError(expect.objectContaining({ code: 'DATABASE_URL_REQUIRED' }));
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: '   ' })).toThrowError(
      expect.objectContaining({ code: 'DATABASE_URL_REQUIRED' })
    );
  });

  it('accepts a valid explicit production DSN without changing it', () => {
    const dsn = 'postgresql://app:pw@db:5432/novda?sslmode=require';

    expect(resolveDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: dsn })).toBe(dsn);
  });

  it.each([
    'not-a-dsn',
    'mysql://app:pw@db:3306/novda',
    'postgresql:///novda',
    'postgresql://app:pw@db/',
    'postgresql://app user:pw@db/novda',
    'postgresql://app:pw word@db/novda',
    'postgresql://app:p%20w@db/novda',
    'postgresql://app:pw@db/novda\n?sslmode=require'
  ])('rejects invalid production DSN %j', (dsn) => {
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: dsn })).toThrowError(
      expect.objectContaining({ code: 'INVALID_DATABASE_URL' })
    );
  });

  it('allows an explicit NOVDA_PG_URL in non-production and falls back only to explicit DATABASE_URL', () => {
    expect(resolveDatabaseUrl({ NODE_ENV: 'test', NOVDA_PG_URL: 'postgresql://test@localhost/test' }))
      .toBe('postgresql://test@localhost/test');
    expect(resolveDatabaseUrl({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test@db/test' }))
      .toBe('postgresql://test@db/test');
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'test' })).toThrowError(
      expect.objectContaining({ code: 'DATABASE_URL_REQUIRED' })
    );
  });

  it('returns a parsed URL and never exposes credential-bearing input in validation errors', () => {
    const parsed = validatePostgresDsn('postgresql://user:secret@db/novda', 'DATABASE_URL');

    expect(parsed).toBeInstanceOf(URL);
    expect(parsed.hostname).toBe('db');

    let error: (Error & { code?: string }) | undefined;
    try {
      validatePostgresDsn('postgresql://user:secret word@db/novda', 'DATABASE_URL');
    } catch (caught) {
      error = caught as Error & { code?: string };
    }

    expect(error).toBeDefined();
    expect(error?.code).toBe('INVALID_DATABASE_URL');
    expect(error?.message).not.toContain('secret');
  });
});
