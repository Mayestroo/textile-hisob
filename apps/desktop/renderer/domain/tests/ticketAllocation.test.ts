import { describe, expect, it } from 'vitest';
import { validateTicketForSubmission } from '../ticketValidation';

const model: any = { id: 'model-a', name: 'Model A', operations: [{ id: 'op-sew', name: 'Yeng tikish', rate: 5 }] };
const workers: any[] = [{ id: 1, name: 'Ali' }, { id: 2, name: 'Vali' }];
const printed: any[] = [];

function validate(allocations: Array<{ workerId: number | string; qty: number | string }>) {
  return validateTicketForSubmission({
    date: '2026-11-11', party: '15', patta: '8', color: '', size: '', qty: 100,
    strictParty: false, strictPatta: false, entries: { 'Yeng tikish': allocations }
  }, model, workers, printed, [], { strictParty: false, strictPatta: false });
}

describe('first-time per-worker patta allocations', () => {
  it('accepts a partial initial allocation and retains its worker quantity', () => {
    expect(validate([{ workerId: 1, qty: 40 }])).toMatchObject({
      isValid: true,
      filledEntries: [{ opName: 'Yeng tikish', workerId: 1, qty: 40 }]
    });
  });

  it('accepts a complete 40/60 split and rejects over-allocation or duplicate workers', () => {
    expect(validate([{ workerId: 1, qty: 40 }, { workerId: 2, qty: 60 }]).isValid).toBe(true);
    expect(validate([{ workerId: 1, qty: 40 }, { workerId: 2, qty: 61 }])).toMatchObject({ isValid: false, title: 'Miqdor oshib ketdi' });
    expect(validate([{ workerId: 1, qty: 40 }, { workerId: 1, qty: 60 }])).toMatchObject({ isValid: false, title: 'Takroriy taqsimot' });
  });
});
