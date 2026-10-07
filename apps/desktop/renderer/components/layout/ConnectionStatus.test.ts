import { describe, expect, it } from 'vitest';
import { allowsManualSync, BACKGROUND_CHANGE_POLL_INTERVAL_MS, isEditableInputTarget, resolveManualSyncCompany, shouldRunBackgroundSync, summarizeFailedOutboxOperations, summarizeReconnectFailure } from './ConnectionStatus';

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

  it('identifies editable elements so background reconnect can stay idle while typing', () => {
    expect(isEditableInputTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableInputTarget({ tagName: 'textarea' })).toBe(true);
    expect(isEditableInputTarget({ isContentEditable: true })).toBe(true);
    expect(isEditableInputTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableInputTarget(null)).toBe(false);
  });

  it('polls a visible licensed company even while an input is active', () => {
    expect(shouldRunBackgroundSync(true, true, true)).toBe(true);
    expect(shouldRunBackgroundSync(true, true, false)).toBe(false);
    expect(shouldRunBackgroundSync(false, true, true)).toBe(false);
    expect(shouldRunBackgroundSync(true, false, true)).toBe(false);
  });

  it('uses a two-second foreground change-feed poll interval', () => {
    expect(BACKGROUND_CHANGE_POLL_INTERVAL_MS).toBe(2_000);
  });

  it('summarizes failed outbox commands without exposing their payloads', () => {
    expect(summarizeFailedOutboxOperations([
      { command_type: 'CompletePattaBatch', status: 'DEAD_LETTER', last_error: 'PATTA_NUMBER_OUT_OF_RANGE', payload_json: 'secret' }
    ])).toEqual(['CompletePattaBatch: PATTA_NUMBER_OUT_OF_RANGE']);
    expect(summarizeFailedOutboxOperations(null)).toEqual([]);
  });

  it('surfaces a transient push error even when the reconnect pull succeeded', () => {
    expect(summarizeReconnectFailure({
      success: true,
      result: { pushed: { attempted: 1, synced: 0, transientErrors: 1, error: 'Network request failed: fetch failed' } }
    }, 1)).toContain('Network request failed: fetch failed');
  });

  it('explains when pending commands are blocked by an unsynced dependency', () => {
    expect(summarizeReconnectFailure({
      success: true,
      result: { pushed: { attempted: 0, synced: 0, transientErrors: 0, blockedCount: 3 } }
    }, 3)).toContain('3 ta buyruq oldingi sinxronlanmagan buyruqqa bog‘liq');
  });

  it('reports pending rows that the dispatcher did not attempt', () => {
    expect(summarizeReconnectFailure({
      success: true,
      result: { pushed: { attempted: 0, synced: 0, transientErrors: 0 } }
    }, 2)).toContain('2 ta buyruq lokal navbatda bor');
  });
});
