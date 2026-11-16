/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { KonveyerView } from '../KonveyerView';
import { ModellarJamiView } from '../ModellarJamiView';
import { useWorkbookStore } from '../../../store/workbookStore';
import { useAuthStore } from '../../../store/authStore';
import { formatMoney } from '../../../utils/formatters';
declare const require: (id: string) => any;

const { reducePayroll } = require('../../../../../../packages/domain/payrollReducer.cjs');

describe('KonveyerView payroll hydration', () => {
  const originalWorkbook = useWorkbookStore.getState();
  const originalAuth = useAuthStore.getState();

  beforeEach(() => {
    window.sessionStorage.clear();
    useAuthStore.setState({ companyId: 'conveyor-company' });
    useWorkbookStore.setState({
      models: [], workers: [], submittedTickets: [], selectedArchiveFilename: null,
      currentPeriod: { id: 'current-period', isClosed: false } as any,
      licenseStatus: { companyId: 'conveyor-company' } as any
    });
  });

  afterEach(() => {
    cleanup();
    useWorkbookStore.setState(originalWorkbook, true);
    useAuthStore.setState(originalAuth, true);
  });

  it.each([undefined, null, {}, { workers: null }])('renders instead of crashing with valuation %j', (valuation) => {
    useWorkbookStore.setState({ payrollValuation: valuation as any });
    render(<KonveyerView />);
    expect(screen.getByRole('heading', { name: 'Konveyerlar va modellar' })).toBeTruthy();
    expect(screen.getByText('Jami ish haqi')).toBeTruthy();
  });

  it('renders after valuation arrives following an initially missing value', () => {
    useWorkbookStore.setState({ payrollValuation: undefined as any });
    const view = render(<KonveyerView />);
    useWorkbookStore.setState({ payrollValuation: {
      companyId: 'conveyor-company', period: { periodId: 'current-period' }, workers: [],
      accountingStatus: 'COMPLETE', accountingReasons: [], syncStatus: 'CURRENT'
    } as any });
    view.rerender(<KonveyerView />);
    expect(screen.getByRole('heading', { name: 'Konveyerlar va modellar' })).toBeTruthy();
  });

  it.each([false, true])('does not label a priced model unpriced in the summary while payroll is loading=%s', (loading) => {
    const operations = [{ name: 'Sew', rate: 0 }];
    const payroll = reducePayroll({ id: 'current-period', name: 'Current', is_closed: false }, [], [], [], [],
      { currentModels: [{ id: 'm', operations }] });
    useWorkbookStore.setState({ models: [{ id: 'm', name: 'Summary Model', operations,
      pattaOpsOrder: ['Sew'], hisobQuantities: {} }] as any, workers: [],
      submittedTickets: [{ id: 't', modelId: 'm', partyNumber: '45', pattaNumber: 8, qty: 100,
        submittedAt: '2026-11-16T12:00:00Z' }],
      payrollValuation: loading ? undefined : { ...payroll, companyId: 'conveyor-company', tariffs: [{ id: 'm', operations }] }
    } as any);
    render(<ModellarJamiView />);
    const row = screen.getByText('Summary Model').closest('tr')!;
    expect(within(row).queryByRole('button', { name: 'Narx kiritilmagan' })).toBeNull();
    if (loading) expect(within(row).getByText('Narx ma’lumoti kutilmoqda')).toBeTruthy();
    else expect(within(row).getAllByText('0').length).toBeGreaterThan(0);
  });

  it.each([
    { quantities: [40, 60], rate: 5, expected: 500 },
    { quantities: [40], rate: 5, expected: 200 },
    { quantities: [40, 60], rate: 0, expected: 0 },
    { quantities: [undefined], rate: 5, expected: 500 }
  ])('matches payroll for allocations $quantities at rate $rate', ({ quantities, rate, expected }) => {
    const workers = quantities.map((_, index) => ({ id: index + 1, name: `Worker ${index + 1}` }));
    const operations = [{ name: 'Sew', rate }];
    const entries = quantities.map((qty, index) => ({ opName: 'Sew', workerId: index + 1, qty, rateSnapshot: 999 }));
    const payroll = reducePayroll({ id: 'current-period', name: 'Current', is_closed: false },
      workers.map((w) => ({ worker_id: w.id, worker_name: w.name })),
      entries.map((entry) => ({ worker_id: entry.workerId, model_id: 'm', model_name: 'Model',
        op_name: entry.opName, period_id: 'current-period', qty: entry.qty ?? 100, rate: entry.rateSnapshot })), [], [],
      { currentModels: [{ id: 'm', operations }] });
    useWorkbookStore.setState({ workers: workers as any, models: [{ id: 'm', name: 'Model',
      operations, pattaOpsOrder: ['Sew'], hisobQuantities: {} }] as any,
      submittedTickets: [{ id: 'split-ticket', modelId: 'm', periodId: 'current-period', partyNumber: '45',
        pattaNumber: 8, qty: 100, entries, status: 'CONFIRMED', submittedAt: '2026-11-16T12:00:00Z', konveyer: '1' }],
      payrollValuation: { ...payroll, companyId: 'conveyor-company', tariffs: [{ id: 'm', operations }] }
    });
    const view = render(<KonveyerView />);
    const payrollCard = screen.getByText('Jami ish haqi').closest('.konveyer-kpi-card')!;
    expect(within(payrollCard as HTMLElement).getByText(formatMoney(expected), { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: "Pattalar ro'yxati" }));
    const row = view.container.querySelector('.konveyer-details-main-row') as HTMLElement;
    expect(within(row).getByText(`${formatMoney(expected)} so'm`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Narxni kiritish' })).toBeNull();
  });

  it.each([
    { scenario: 'payroll is loading', rate: 5, unavailable: true, foreignPeriod: false, missingWorker: false, warning: false },
    { scenario: 'worker is unavailable', rate: 5, unavailable: false, foreignPeriod: false, missingWorker: true, warning: false },
    { scenario: 'ticket belongs to another period', rate: 5, unavailable: false, foreignPeriod: true, missingWorker: false, warning: false },
    { scenario: 'an unused operation has no rate', rate: 5, unavailable: false, foreignPeriod: false, missingWorker: false, warning: false },
    { scenario: 'a used operation has no rate', rate: null, unavailable: false, foreignPeriod: false, missingWorker: false, warning: true },
    { scenario: 'a used operation has an invalid rate', rate: NaN, unavailable: false, foreignPeriod: false, missingWorker: false, warning: true }
  ])('only reports actual missing used-operation prices when $scenario', ({ rate, unavailable, foreignPeriod, missingWorker, warning }) => {
    const operations = [{ name: 'Sew', rate }, { name: 'Unused', rate: null }];
    const worker = { id: 1, name: 'Worker' };
    const payroll = reducePayroll({ id: 'current-period', name: 'Current', is_closed: false },
      missingWorker ? [] : [{ worker_id: 1, worker_name: worker.name }], [], [], [],
      { currentModels: [{ id: 'm', operations }] });
    useWorkbookStore.setState({ models: [{ id: 'm', name: 'Priced Model', operations,
      pattaOpsOrder: ['Sew'], hisobQuantities: {} }] as any,
      workers: missingWorker ? [] : [worker] as any,
      submittedTickets: [{ id: 'ticket', modelId: 'm', periodId: foreignPeriod ? 'other-period' : 'current-period',
        partyNumber: '45', pattaNumber: 8, qty: 100, entries: [{ opName: 'Sew', workerId: 1, qty: 100 }],
        submittedAt: '2026-11-16T12:00:00Z', status: 'CONFIRMED' }],
      payrollValuation: unavailable ? undefined : { ...payroll, companyId: 'conveyor-company', tariffs: [{ id: 'm', operations }] }
    } as any);
    render(<KonveyerView />);
    fireEvent.click(screen.getByRole('button', { name: "Pattalar ro'yxati" }));
    expect(Boolean(screen.queryByRole('button', { name: 'Narxni kiritish' }))).toBe(warning);
  });
});
