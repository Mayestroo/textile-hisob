import XLSX from 'xlsx-js-style';
import { PayrollValuation, Worker, ModelConfig } from '../types/workbook';
import { calculateModelTotals } from './formulaEngine';
import { formatDateIso } from '../utils/formatters';
import { payrollDisplay } from './payrollDisplay';

function makeSheetName(name: string, usedNames: Set<string>): string {
  const baseName = (name || 'Sheet').replace(/[\\/:?*\[\]]/g, '_').slice(0, 31) || 'Sheet';
  let sheetName = baseName;
  let suffix = 1;
  while (usedNames.has(sheetName.toLowerCase())) {
    const suffixText = ` (${suffix++})`;
    sheetName = `${baseName.slice(0, 31 - suffixText.length)}${suffixText}`;
  }
  usedNames.add(sheetName.toLowerCase());
  return sheetName;
}

export function createPayrollWorkbook(models: ModelConfig[], workers: Worker[], valuation?: PayrollValuation) {
  const wb = XLSX.utils.book_new();
  const usedSheetNames = new Set<string>();

  // 1. MASTER PAYROLL SHEET (Umumiy) - ALWAYS FIRST SHEET!
  const display = valuation
    ? payrollDisplay(models, workers, valuation, valuation.companyId, valuation.period?.periodId || '')
    : payrollDisplay(models, workers, {
      companyId: '', period: null, workers: [], accountingStatus: 'UNAVAILABLE',
      accountingReasons: ['PAYROLL_VALUATION_UNAVAILABLE'], syncStatus: 'UNKNOWN'
    }, undefined, '');
  const payroll = display.masterReport;
  const incompleteLabel = display.label || (display.incomplete ? 'Taxminiy hisob: tasdiqlanmagan' : '');
  const umumiyData: any[][] = [];

  if (incompleteLabel) umumiyData.push([incompleteLabel]);

  // Headers
  const uRow1: any[] = ['№', 'Исм фамилия', 'Соф фойда', 'Стаж', 'Аванс', 'Jarima', 'Jami ish haqi (ish + Oklad)', 'Oklad', 'Magazin'];
  for (const m of models) {
    uRow1.push(m.name);
  }
  umumiyData.push(uRow1);

  for (const wSummary of payroll.workers) {
    const workerReady = display.workerMoneyReady.has(wSummary.workerId);
    const row: any[] = [
      wSummary.workerId,
      wSummary.workerName,
      workerReady ? wSummary.sofFoyda : 'Noma’lum',
      workerReady ? (wSummary.staj > 0 ? wSummary.staj : '') : 'Noma’lum',
      workerReady ? (wSummary.avans > 0 ? wSummary.avans : '') : 'Noma’lum',
      workerReady ? (wSummary.jarima > 0 ? wSummary.jarima : '') : 'Noma’lum',
      workerReady ? wSummary.umumiy : 'Noma’lum',
      workerReady ? wSummary.oklad : 'Noma’lum',
      workerReady ? wSummary.magazin : 'Noma’lum'
    ];

    for (const m of models) {
      const earn = wSummary.earningsByModel[m.id] || 0;
      const unknownModelAmount = m.operations.some((op) => display.unknown.has(display.key(m.id, wSummary.workerId, op.name)));
      row.push(workerReady && !unknownModelAmount ? (earn > 0 ? earn : '') : 'Noma’lum');
    }

    umumiyData.push(row);
  }

  // Totals row for Umumiy
  const uTotalRow: any[] = [
    'ЖАМИ',
    '',
    display.reportReady ? payroll.totalSofFoyda : 'Noma’lum',
    display.reportReady ? payroll.totalStaj : 'Noma’lum',
    display.reportReady ? payroll.totalAvans : 'Noma’lum',
    display.reportReady ? payroll.totalJarima : 'Noma’lum',
    display.reportReady ? payroll.totalUmumiy : 'Noma’lum',
    display.reportReady ? payroll.totalOklad : 'Noma’lum',
    display.reportReady ? payroll.totalMagazin : 'Noma’lum'
  ];

  for (const m of models) {
    const unknownModelAmount = workers.some((worker) => m.operations.some((op) =>
      display.unknown.has(display.key(m.id, worker.id, op.name))));
    uTotalRow.push(display.reportReady && !unknownModelAmount ? (payroll.modelTotals[m.id] || 0) : 'Noma’lum');
  }
  umumiyData.push(uTotalRow);

  const wsUmumiy = XLSX.utils.aoa_to_sheet(umumiyData);
  if (incompleteLabel) wsUmumiy['A1'].c = [{ t: incompleteLabel }];
  if (display.incomplete) {
    const statusRow = incompleteLabel ? 1 : 0;
    for (let column = 0; column < (umumiyData[statusRow]?.length || 1); column++) {
      const cell = wsUmumiy[XLSX.utils.encode_cell({ r: statusRow, c: column })];
      if (cell) cell.c = [{ t: incompleteLabel || 'Taxminiy hisob' }];
    }
  }
  XLSX.utils.book_append_sheet(wb, wsUmumiy, makeSheetName('Umumiy', usedSheetNames));

  // 2. Export Patta and Hisob sheets
  for (const model of models) {
    // A. Patta Sheet
    const pattaData: any[][] = [];
    pattaData.push(['№', model.title, '', '', '', '', '', '', '', '']);
    pattaData.push(['', 'Сана- ', '', '', model.party, '', '', `Ранг ${model.color}`, 'Размер', 'сони ']);
    pattaData.push(['', '', '', '', '', '', '', '', model.size, '']);
    pattaData.push(['', '', '', '', 'Номер', 'Исм фамилия', '', '', 'Брак иш', '']);

    model.pattaOpsOrder.forEach((opName, idx) => {
      pattaData.push([idx + 1, opName, '', '', '', '', '', '', '', '']);
    });

    const wsPatta = XLSX.utils.aoa_to_sheet(pattaData);
    XLSX.utils.book_append_sheet(wb, wsPatta, makeSheetName(model.name, usedSheetNames));

    // B. Hisob Sheet
    const hisobData: any[][] = [];
    const row1: any[] = ['№', 'F.I.O'];
    const row2: any[] = ['', ''];

    const effectiveRates = display.operationRates[model.id] || {};
    for (const op of model.operations) {
      row1.push(op.name, '');
      const rate = effectiveRates[op.name];
      row2.push(rate === null || rate === undefined ? 'Noma’lum' : rate, 'Сони');
    }
    row1.push('ЖАМИ');
    row2.push('');

    hisobData.push(row1);
    hisobData.push(row2);

    const modelTotals = display.modelTotals[model.id] || calculateModelTotals(model, workers);

    for (const worker of workers) {
      const row: any[] = [worker.id, worker.name];
      const workerQtyMap = (model.hisobQuantities && model.hisobQuantities[worker.id]) || {};

      for (const op of model.operations) {
        const valuedQty = display.cellQuantities[display.key(model.id, worker.id, op.name)];
        const qty = valuedQty === null || valuedQty === undefined
          ? (display.ready ? 0 : (workerQtyMap[op.name] || 0))
          : valuedQty;
        const amount = display.cellAmounts[display.key(model.id, worker.id, op.name)];
        row.push(amount === null || amount === undefined ? (qty > 0 ? 'Noma’lum' : '') : (amount > 0 ? amount : ''), qty > 0 ? qty : '');
      }

      const tot = modelTotals.workerTotals[worker.id]?.totalEarnings || 0;
      row.push(display.ready ? (tot > 0 ? tot : 0) : 'Noma’lum');
      hisobData.push(row);
    }

    // Totals row
    const totalRow: any[] = ['ЖАМИ', ''];
    for (const op of model.operations) {
      const opTot = modelTotals.operations[op.name];
      const amount = opTot?.totalAmount || 0;
      const hasUnknown = workers.some((worker) => display.unknown.has(display.key(model.id, worker.id, op.name)));
      totalRow.push(!display.ready || hasUnknown ? 'Noma’lum' : amount, opTot?.totalQuantity || 0);
    }
    totalRow.push(display.ready ? modelTotals.grandTotalAmount : 'Noma’lum');
    hisobData.push(totalRow);

    const wsHisob = XLSX.utils.aoa_to_sheet(hisobData);
    if (incompleteLabel) {
      wsHisob['A1'].c = [{ t: incompleteLabel }];
      wsHisob['A2'].c = [{ t: incompleteLabel }];
    }
    for (const [opIndex, op] of model.operations.entries()) {
      const rate = effectiveRates[op.name];
      if (rate === null || rate === undefined) {
        const ref = XLSX.utils.encode_cell({ r: 1, c: 2 + opIndex * 2 });
        if (wsHisob[ref]) wsHisob[ref].c = [{ t: 'Noma’lum tarif; summa yakuniy emas' }];
      }
    }
    XLSX.utils.book_append_sheet(wb, wsHisob, makeSheetName(model.hisobSheetName, usedSheetNames));
  }

  return wb;
}

export function exportWorkbookToExcel(models: ModelConfig[], workers: Worker[], customFilename?: string, valuation?: PayrollValuation) {
  const wb = createPayrollWorkbook(models, workers, valuation);

  // Trigger browser download
  const dateStr = formatDateIso();
  const finalFilename = customFilename || `Buxoro_Futbolka_Hisob_${dateStr}.xlsx`;
  XLSX.writeFile(wb, finalFilename);
}

export function exportWorkersListToExcel(workers: Worker[], customFilename?: string) {
  const wb = XLSX.utils.book_new();

  // Sort workers by ID ascending
  const sortedWorkers = [...workers].sort((a, b) => a.id - b.id);

  // Default thin borders for cells
  const defaultBorder = {
    top: { style: 'thin', color: { rgb: '000000' } },
    bottom: { style: 'thin', color: { rgb: '000000' } },
    left: { style: 'thin', color: { rgb: '000000' } },
    right: { style: 'thin', color: { rgb: '000000' } }
  };

  const headerStyle = {
    font: { bold: true, sz: 11, name: 'Calibri' },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: defaultBorder,
    fill: { fgColor: { rgb: 'F2F2F2' } }
  };

  const idCellStyle = {
    font: { sz: 11, name: 'Calibri' },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: defaultBorder
  };

  const nameCellStyle = {
    font: { sz: 11, name: 'Calibri' },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: defaultBorder
  };

  const emptyCellStyle = {
    font: { sz: 11, name: 'Calibri' },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: defaultBorder
  };

  const ws: any = {};

  // Headers: 1-ustun: ID raqami, 2-ustun: F.I.O, 3,4,5,6,7-ustunlar: bo'sh
  const headers = ['ID raqami', 'F.I.O', '', '', '', '', ''];
  headers.forEach((h, colIdx) => {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c: colIdx });
    ws[cellRef] = {
      t: 's',
      v: h,
      s: headerStyle
    };
  });

  // Data rows
  sortedWorkers.forEach((w, idx) => {
    const r = idx + 1;

    // 1-ustun: ID raqami
    ws[XLSX.utils.encode_cell({ r, c: 0 })] = {
      t: 'n',
      v: w.id,
      s: idCellStyle
    };

    // 2-ustun: F.I.O
    ws[XLSX.utils.encode_cell({ r, c: 1 })] = {
      t: 's',
      v: w.name || '',
      s: nameCellStyle
    };

    // 3, 4, 5, 6, 7-ustunlar: bo'sh
    for (let c = 2; c < 7; c++) {
      ws[XLSX.utils.encode_cell({ r, c })] = {
        t: 's',
        v: '',
        s: emptyCellStyle
      };
    }
  });

  const totalRows = Math.max(sortedWorkers.length, 0);
  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: totalRows, c: 6 }
  });

  // Column widths: ID (12), F.I.O (35), 5 bo'sh ustun (16 each)
  ws['!cols'] = [
    { wch: 12 },
    { wch: 35 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 }
  ];

  // Row heights: Header 26pt, data rows 22pt
  const rows = [{ hpt: 26 }];
  for (let i = 0; i < totalRows; i++) {
    rows.push({ hpt: 22 });
  }
  ws['!rows'] = rows;

  XLSX.utils.book_append_sheet(wb, ws, 'Ishchilar');

  const dateStr = formatDateIso();
  const finalFilename = customFilename || `Ishchilar_Royxati_${dateStr}.xlsx`;
  XLSX.writeFile(wb, finalFilename);
}
