import { describe, expect, it } from 'vitest';
import { isModelNarxsiz } from '../modelRateStatus';
import type { ModelConfig } from '../../types/workbook';
describe('unchanged navigation price categorization outside component dependency cycle', () => {
  it.each([
    [[], true], [[{ rate: null }], true], [[{ rate: 0 }], true], [[{ rate: -1 }], true],
    [[{ rate: 5 }], false], [[{ rate: 5 }, { rate: null }], true]
  ])('classifies %j as unpriced=%s', (operations, expected) => {
    expect(isModelNarxsiz({ operations } as ModelConfig)).toBe(expected);
  });
});
