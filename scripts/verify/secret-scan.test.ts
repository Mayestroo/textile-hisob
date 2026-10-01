import { describe, expect, it } from 'vitest';

const { containsPrivateKeyBlock } = require('./secret-scan.cjs');

describe('private-key secret detection', () => {
  it('flags a complete PEM block but ignores a quoted header marker', () => {
    const header = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const footer = ['-----END', 'PRIVATE KEY-----'].join(' ');

    expect(containsPrivateKeyBlock(header)).toBe(false);
    expect(containsPrivateKeyBlock(`${header}\nQUJDRA==\n${footer}`)).toBe(true);

    const edHeader = ['-----BEGIN', 'ED25519 PRIVATE KEY-----'].join(' ');
    const edFooter = ['-----END', 'ED25519 PRIVATE KEY-----'].join(' ');
    expect(containsPrivateKeyBlock(`${edHeader}\nQUJDRA==\n${edFooter}`)).toBe(true);
  });
});
