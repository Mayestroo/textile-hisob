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

describe('printed patta quantity must equal its issued quantity', () => {
  const party: any = { id: 'party-205', partyNumber: '205', modelId: 'model-a', modelName: 'Model A', isClosed: false,
    pattaCount: 1, cumulativePattaCount: 680, pattaStartNumber: 680, pattaEndNumber: 680, ishSoniPerPatta: 410, ishSoni: 410 };
  const validatePrinted = (qty: number, allocationQty = qty) => validateTicketForSubmission({
    date: '2026-11-23', party: '205', patta: '680', color: '', size: 'M', qty,
    entries: { 'Yeng tikish': [{ workerId: 1, qty: allocationQty }] }
  } as any, model, workers, [party], [], { strictParty: true, strictPatta: true });

  it('rejects 409 for a party issued at 410 per patta before it reaches the server', () => {
    expect(validatePrinted(409)).toMatchObject({ isValid: false, title: 'Ish soni xato!' });
  });

  it('accepts the issued quantity, with fewer pieces recorded as a smaller allocation', () => {
    expect(validatePrinted(410, 409)).toMatchObject({ isValid: true, partyOwner: { id: 'party-205' } });
  });
});
