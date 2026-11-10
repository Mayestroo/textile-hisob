import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { HisobView } from '../../../apps/desktop/renderer/features/models/HisobView';
import { useWorkbookStore } from '../../../apps/desktop/renderer/store/workbookStore';
import '../../../apps/desktop/renderer/index.css';
import type { ModelConfig, Worker } from '../../../apps/desktop/renderer/types/workbook';

const workers: Worker[] = Array.from({ length: 222 }, (_, i) => ({
  id: i === 199 ? 123456789012345 : i + 1,
  name: i === 199 ? 'Long offscreen worker name for canonical width verification 123456789' : `Worker ${i + 1}`
}));
const operations = Array.from({ length: 15 }, (_, i) => ({ id: `op-${i}`, name: `Operation ${i + 1}`, rate: 125000 }));
const model: ModelConfig = {
  id: 'synthetic-model', name: 'Synthetic', hisobSheetName: 'Synthetic-hisob', title: '', party: '',
  color: '', size: '', operations, pattaOpsOrder: [],
  hisobQuantities: { [workers[199].id]: { [operations[14].name]: 987654321 } }
};
useWorkbookStore.setState({ workers });
const root = createRoot(document.getElementById('root')!);
root.render(<HisobView model={model} />);
Object.assign(window, { renderFixture: {
  updateOffscreen: () => {
    const next = { ...model, hisobQuantities: { ...model.hisobQuantities,
      [workers[199].id]: { [operations[14].name]: 999999999999999 } } };
    flushSync(() => root.render(<HisobView model={next} />));
    return next;
  },
  fallbackCanvas: (next: ModelConfig) => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof original;
    try { flushSync(() => root.render(<HisobView model={{ ...next }} />)); }
    finally { HTMLCanvasElement.prototype.getContext = original; }
  }
} });
