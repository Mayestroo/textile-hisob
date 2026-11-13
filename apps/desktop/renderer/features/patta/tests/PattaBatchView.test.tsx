/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
});
