/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { PattaBatchView } from '../PattaBatchView';
import { useWorkbookStore } from '../../../store/workbookStore';

// Mock getElectronApi so runtime checks don't crash in jsdom
vi.mock('../../../store/runtimeMode', () => ({
  getElectronApi: () => null,
  resolveElectronRuntimeMode: vi.fn().mockResolvedValue({ success: false, code: 'NO_ELECTRON', error: 'no electron' }),
}));

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val; },
    clear: () => { store = {}; },
    removeItem: (key: string) => { delete store[key]; },
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });

describe('PattaBatchView - Custom sizes in grid', () => {
  beforeEach(() => {
    localStorageMock.clear();
    // Pre-select "numbers" system so numeric custom sizes (92, 98, 104, 110) are shown
    localStorageMock.setItem('patta_size_system', 'numbers');

    useWorkbookStore.setState({
      models: [
        {
          id: 'dz-369',
          name: "DZ-369-KO'FTA",
          title: "DZ-369-KO'FTA",
          party: '1',
          color: 'Qora',
          size: '40',
          operations: [],
          pattaOpsOrder: [],
          hisobQuantities: {},
        },
      ],
      pattaBatchConfigs: {
        'dz-369': {
          partyNumber: '1',
          isCustomParty: false,
          totalIshSoni: '200',
          color: 'Qora',
          sizes: { '40': '10', '92': '5', '98': '10', '104': '8', '110': '7' },
          sizeNames: ['40', '42', '44', '46', '48', '50', '52', '54', '56', '58', '60', '92', '98', '104', '110'],
          scaleType: 'numbers',
          isConfigured: true,
        },
      },
      nextPartyNumber: 1,
      printedPartyHistory: [],
      submittedTickets: [],
      availableSizes: [],
    } as any);
  });

  afterEach(() => cleanup());

  it('renders model name in the grid', () => {
    render(<PattaBatchView />);
    expect(screen.getByText(/DZ-369/)).toBeTruthy();
  });

  it('renders standard numeric sizes (40, 60) in the grid', () => {
    render(<PattaBatchView />);
    // size inputs are rendered as placeholders or labels containing the size name
    screen.getAllByRole('spinbutton');
    // Check for text content anywhere in rendered output
    const html = document.body.innerHTML;
    expect(html).toContain('40');
    expect(html).toContain('60');
  });

  it('renders newly added custom sizes 92, 98, 104, 110 in the grid', () => {
    render(<PattaBatchView />);
    const html = document.body.innerHTML;
    expect(html).toContain('92');
    expect(html).toContain('98');
    expect(html).toContain('104');
    expect(html).toContain('110');
  });

  const partyHistory = (archived200 = false) => Array.from({ length: 201 }, (_, index) => ({
    id: `party-${index + 1}`,
    partyNumber: String(index + 1),
    modelId: 'dz-369',
    modelName: 'DZ-369',
    color: 'Qora',
    pattaCount: 1,
    cumulativePattaCount: index + 1,
    ishSoni: 1,
    cumulativeIshSoni: index + 1,
    printedAt: '',
    isClosed: index === 199,
    isArchived: index === 199 && archived200,
  }));

  it('reuses deleted party 200 even when party 201 exists and the saved counter is stale', () => {
    useWorkbookStore.setState({ printedPartyHistory: partyHistory(), nextPartyNumber: 202 });
    render(<PattaBatchView />);
    const partyInput = () => screen.getByTitle("Partiya raqami avtomatik hisoblanadi (o'zgartirilmaydi)") as HTMLInputElement;
    expect(partyInput().value).toBe('202');

    act(() => useWorkbookStore.setState({ printedPartyHistory: partyHistory(true) }));

    expect(partyInput().value).toBe('200');
  });

  it('reuses deleted party 200 when it was the last printed party', () => {
    useWorkbookStore.setState({ printedPartyHistory: partyHistory(true).slice(0, 200), nextPartyNumber: 201 });
    render(<PattaBatchView />);
    expect((screen.getByTitle("Partiya raqami avtomatik hisoblanadi (o'zgartirilmaydi)") as HTMLInputElement).value).toBe('200');
  });
});
