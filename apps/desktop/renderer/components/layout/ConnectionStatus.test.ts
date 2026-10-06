import { describe, expect, it } from 'vitest';
import { allowsManualSync, resolveManualSyncCompany, summarizeFailedOutboxOperations } from './ConnectionStatus';

describe('manual sync company authority', () => {
  it('fails closed when auth and licensed companies disagree', () => {
    expect(resolveManualSyncCompany('company-a', 'company-b')).toBeUndefined();
  });

  it('uses the licensed active company when auth agrees', () => {
    expect(resolveManualSyncCompany('company-a', 'company-a')).toBe('company-a');
  });

  it('allows a licensed company when auth has not established a company yet', () => {
    expect(resolveManualSyncCompany(null, 'company-a')).toBe('company-a');
  });

  it('does not sync without an independently established licensed company', () => {
    expect(resolveManualSyncCompany(null, undefined)).toBeUndefined();
  });

  it('allows manual VPS reconnect only in a ready  runtime', () => {
    expect(allowsManualSync({ success: true, mode: 'sync' })).toBe(true);
    expect(allowsManualSync({ success: false, mode: 'sync', code: '_RUNTIME_NOT_READY' })).toBe(false);
    expect(allowsManualSync({ success: true, mode: 'legacy' })).toBe(false);
  });

  it('summarizes failed outbox commands without exposing their payloads', () => {
    expect(summarizeFailedOutboxOperations([
      { command_type: 'CompletePattaBatch', status: 'DEAD_LETTER', last_error: 'PATTA_NUMBER_OUT_OF_RANGE', payload_json: 'secret' }
    ])).toEqual(['CompletePattaBatch: PATTA_NUMBER_OUT_OF_RANGE']);
    expect(summarizeFailedOutboxOperations(null)).toEqual([]);
  });
});
