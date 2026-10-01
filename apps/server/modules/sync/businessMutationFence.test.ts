import { describe, expect, it, vi } from 'vitest';

const { mutationFenceEnabled, createBusinessMutationFence } = require('./businessMutationFence.cjs');

describe('business mutation kill switch', () => {
  it.each(['true', '1'])('enables mutations only for explicit value %s', (value: string) => {
    expect(mutationFenceEnabled({ NOVDA_BUSINESS_MUTATIONS_ENABLED: value })).toBe(true);
  });

  it.each([undefined, '', 'false', '0', 'yes'])('defaults closed for value %s', (value: string | undefined) => {
    expect(mutationFenceEnabled({ NOVDA_BUSINESS_MUTATIONS_ENABLED: value })).toBe(false);
  });

  it('rejects disabled mutations before calling the downstream handler', async () => {
    const handler = createBusinessMutationFence({ enabled: false });
    const reply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnValue('blocked')
    };

    await expect(handler({}, reply)).resolves.toBe('blocked');
    expect(reply.code).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'BUSINESS_MUTATIONS_DISABLED',
        message: 'Business writes are temporarily disabled'
      }
    });
  });

  it('passes enabled mutations through', async () => {
    const reply = { code: vi.fn(), send: vi.fn() };
    await expect(createBusinessMutationFence({ enabled: true })({}, reply)).resolves.toBeUndefined();
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });
});
