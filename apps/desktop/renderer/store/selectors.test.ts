import { describe, expect, it } from 'vitest';
import { selectWorkerCount } from './selectors';

describe('global worker selector', () => {
  it('counts the complete company roster independently of the selected period', () => {
    const workers = Array.from({ length: 201 }, (_, index) => ({
      id: index + 1,
      name: `Worker ${index + 1}`
    }));

    expect(selectWorkerCount({ workers } as any)).toBe(201);
  });
});
