import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdjustmentSourceDialog, AdjustmentSourceSelection, HISTORICAL_TOTAL_WARNING, SourceRequestGuard, guardedAdjustmentSources, isAdjustmentEditContextCurrent, parseEditableNumericDraft, readEnteredAdjustmentSources } from './HisobView';
import { captureSessionIdentity, invalidateSessionIdentity, resetSessionGuardForTests } from '../../store/sessionGuard';

describe('Hisob editable numeric input drafts', () => {
  it('keeps valid final numbers and treats an empty field as zero on commit', () => {
    expect(parseEditableNumericDraft('30')).toBe(30);
    expect(parseEditableNumericDraft(' 40.5 ')).toBe(40.5);
    expect(parseEditableNumericDraft('')).toBe(0);
  });

  it('rejects invalid or negative values without submitting them', () => {
    expect(parseEditableNumericDraft('not a number')).toBeNull();
    expect(parseEditableNumericDraft('-1')).toBeNull();
  });
});

describe('source request lifecycle', () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  it('rejects a late source response after period change or same-company reactivation', async () => {
    resetSessionGuardForTests();
    const session = captureSessionIdentity('company-a')!;
    const context = { companyId: 'company-a', periodId: 'P', session, modelId: 'm', workerId: 7, opName: 'Sew' };
    const latest = { companyId: 'company-a', periodId: 'P', modelId: 'm', workerIds: [7], operationNames: ['Sew'] };
    const guard = new SourceRequestGuard();
    const first = deferred<any>();
    const shown = vi.fn();
    const run = guardedAdjustmentSources(guard, guard.begin(),
      () => isAdjustmentEditContextCurrent(context, latest), () => first.promise, shown, vi.fn(), vi.fn());
    latest.periodId = 'Q';
    first.resolve([{ originalEntryId: 'P-entry' }]);
    await run;
    expect(shown).not.toHaveBeenCalled();

    latest.periodId = 'P';
    const second = deferred<any>();
    const next = guardedAdjustmentSources(guard, guard.begin(),
      () => isAdjustmentEditContextCurrent(context, latest), () => second.promise, shown, vi.fn(), vi.fn());
    invalidateSessionIdentity('company-a');
    second.resolve([{ originalEntryId: 'old-session-entry' }]);
    await next;
    expect(shown).not.toHaveBeenCalled();
    expect(isAdjustmentEditContextCurrent(context, latest)).toBe(false);
  });
  it('ignores older success, cancelled success and error/finally, and changed edit context', async () => {
    const guard = new SourceRequestGuard();
    const shown = vi.fn(), error = vi.fn(), done = vi.fn();
    let context = 'model-a/worker-1/Cut';
    const start = (request: ReturnType<typeof deferred<any>>, expected = context) => {
      const generation = guard.begin();
      return guardedAdjustmentSources(guard, generation, () => context === expected, () => request.promise, shown, error, done);
    };
    const older = deferred<any>(), newer = deferred<any>();
    const first = start(older), second = start(newer);
    newer.resolve([{ originalEntryId: 'new' }]);
    await second;
    expect(shown).toHaveBeenCalledExactlyOnceWith([{ originalEntryId: 'new' }]);
    older.resolve([{ originalEntryId: 'old' }]);
    await first;
    expect(shown).toHaveBeenCalledTimes(1);
    const cancelled = deferred<any>(), cancelledRun = start(cancelled);
    guard.invalidate(); // Cancel button
    cancelled.reject(new Error('late failure'));
    await cancelledRun;
    expect(error).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
    const switched = deferred<any>(), switchedRun = start(switched);
    context = 'model-b/worker-2/Sew';
    switched.resolve([{ originalEntryId: 'wrong-context' }]);
    await switchedRun;
    expect(shown).toHaveBeenCalledTimes(1);
    const unmounted = deferred<any>(), unmountedRun = start(unmounted);
    guard.dispose();
    unmounted.reject(new Error('unmounted'));
    await unmountedRun;
    expect(error).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('delivers a current rejection and completes loading', async () => {
    const guard = new SourceRequestGuard(), failed = deferred<any>();
    const error = vi.fn(), done = vi.fn();
    const run = guardedAdjustmentSources(guard, guard.begin(), () => true, () => failed.promise, vi.fn(), error, done);
    failed.reject(new Error('offline'));
    await run;
    expect(error).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });
  it.each(['model', 'worker', 'operation'])('does not show a response after %s changes', async (field) => {
    const guard = new SourceRequestGuard(), request = deferred<any>(), shown = vi.fn(), done = vi.fn();
    const before = { model: 'a', worker: 1, operation: 'Cut' };
    const latest = { ...before };
    const run = guardedAdjustmentSources(guard, guard.begin(),
      () => latest.model === before.model && latest.worker === before.worker && latest.operation === before.operation,
      () => request.promise, shown, vi.fn(), done);
    if (field === 'model') latest.model = 'b';
    if (field === 'worker') latest.worker = 2;
    if (field === 'operation') latest.operation = 'Sew';
    request.resolve([{ originalEntryId: 'stale' }]);
    await run;
    expect(shown).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });
});

describe('source confirmation disclosure', () => {
  it('shows original-work attribution alongside a provisional current-total warning before allowing confirmation', () => {
    const source = { originalTicketId: 'ticket', originalEntryId: 'entry', originalPeriodId: 'sep',
      periodName: 'Sentabr', periodStartDate: '2026-09-01', originalRateSnapshot: 0, partyNumber: '1', pattaNumber: 2 };
    const props = { selection: { workerId: 1, opName: 'Cut', qty: 2, sources: [source] }, selectedEntry: '',
      selectionSaving: false, selectionError: '', currentQty: 0, onSelect: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn() };
    const html = renderToStaticMarkup(createElement(AdjustmentSourceDialog, props));
    expect(html).toContain('Sentabr');
    expect(html).toContain('0 so‘m');
    expect(html).toContain(HISTORICAL_TOTAL_WARNING);
    expect(html).toMatch(/Tuzatishni saqlash<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Tuzatishni saqlash/);
    const chosen = renderToStaticMarkup(createElement(AdjustmentSourceDialog, { ...props, selectedEntry: 'entry' }));
    expect(chosen).toContain(HISTORICAL_TOTAL_WARNING);
    expect(chosen).not.toMatch(/<button[^>]*disabled=""[^>]*>Tuzatishni saqlash/);
  });
});

describe('original entry selector shown in quantity adjustment', () => {
  it('requests entered sources scoped to the selected company, model, worker and operation', async () => {
    const sources = [{ originalTicketId: 'ticket-sep', originalEntryId: 'entry-zero', originalPeriodId: 'sep',
      periodName: 'September', periodStartDate: '2026-09-01', originalRateSnapshot: 0, partyNumber: '1', pattaNumber: 2 }];
    const AdjustmentSources = vi.fn().mockResolvedValue({ success: true, data: sources });
    vi.stubGlobal('window', { electronAPI: { AdjustmentSources } });
    expect(await readEnteredAdjustmentSources('company-a', 'model-a', 1, 'Cut')).toEqual(sources);
    expect(AdjustmentSources).toHaveBeenCalledWith('company-a', 'model-a', 1, 'Cut');
    AdjustmentSources.mockResolvedValue({ success: false });
    await expect(readEnteredAdjustmentSources('company-a', 'model-a', 1, 'Cut')).rejects.toThrow();
    vi.unstubAllGlobals();
  });
  it('shows distinct closed original periods and saved zero versus unknown, without preselecting', () => {
    const sources = [
      { originalTicketId: 'ticket-sep', originalEntryId: 'entry-zero', originalPeriodId: 'sep',
        periodName: 'September', periodStartDate: '2026-09-01', originalRateSnapshot: 0, partyNumber: '1', pattaNumber: 2 },
      { originalTicketId: 'ticket-oct', originalEntryId: 'entry-unknown', originalPeriodId: 'oct',
        periodName: 'October', periodStartDate: '2026-10-01', originalRateSnapshot: null, partyNumber: '1', pattaNumber: 3 }
    ];
    const html = renderToStaticMarkup(createElement(AdjustmentSourceSelection, { sources, selectedEntry: '', onSelect: () => {} }));
    expect(html).toContain('value="entry-zero"');
    expect(html).toContain('September');
    expect(html).toContain('0 so‘m');
    expect(html).toContain('value="entry-unknown"');
    expect(html).toContain('October');
    expect(html).toContain('noma’lum');
    expect(html).toContain('value="" selected=""');
    const onSelect = vi.fn();
    const picker = AdjustmentSourceSelection({ sources, selectedEntry: '', onSelect }) as any;
    picker.props.onChange({ target: { value: 'entry-zero' } });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('entry-zero');
    expect(renderToStaticMarkup(createElement(AdjustmentSourceSelection, { sources: [], selectedEntry: '', onSelect: () => {} })))
      .toContain('Tuzatish yuborilmadi');
  });
});
