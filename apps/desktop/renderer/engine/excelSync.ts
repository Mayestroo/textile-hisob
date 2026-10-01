import XLSX from 'xlsx-js-style';
import { Worker, ModelConfig } from '../types/workbook';
import { calculateModelTotals, calculateMasterPayroll } from './formulaEngine';

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

export function exportWorkbookToExcel(models: ModelConfig[], workers: Worker[], customFilename?: string) {
  const wb = XLSX.utils.book_new();
  const usedSheetNames = new Set<string>();

  // 1. MASTER PAYROLL SHEET (Umumiy) - ALWAYS FIRST SHEET!
  const payroll = calculateMasterPayroll(models, workers);
  const umumiyData: any[][] = [];

  // Headers
  const uRow1: any[] = ['№', 'Исм фамилия', 'Соф фойда', 'Стаж', 'Аванс', 'Жарима', 'ЖАМИ'];
  for (const m of models) {
    uRow1.push(m.name);
  }
  umumiyData.push(uRow1);

  for (const wSummary of payroll.workers) {
    const row: any[] = [
      wSummary.workerId,
      wSummary.workerName,
      wSummary.sofFoyda,
      wSummary.staj > 0 ? wSummary.staj : '',
      wSummary.avans > 0 ? wSummary.avans : '',
      wSummary.jarima > 0 ? wSummary.jarima : '',
      wSummary.umumiy
    ];

    for (const m of models) {
      const earn = wSummary.earningsByModel[m.id] || 0;
      row.push(earn > 0 ? earn : '');
    }

    umumiyData.push(row);
  }

  // Totals row for Umumiy
  const uTotalRow: any[] = [
    'ЖАМИ',
    '',
    payroll.totalSofFoyda,
    payroll.totalStaj,
    payroll.totalAvans,
    payroll.totalJarima,
    payroll.totalUmumiy
  ];

  for (const m of models) {
    uTotalRow.push(payroll.modelTotals[m.id] || 0);
  }
  umumiyData.push(uTotalRow);

  const wsUmumiy = XLSX.utils.aoa_to_sheet(umumiyData);
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

    for (const op of model.operations) {
      row1.push(op.name, '');
      row2.push(op.rate, 'Сони');
    }
    row1.push('ЖАМИ');
    row2.push('');

    hisobData.push(row1);
    hisobData.push(row2);

    const modelTotals = calculateModelTotals(model, workers);

    for (const worker of workers) {
      const row: any[] = [worker.id, worker.name];
      const workerQtyMap = (model.hisobQuantities && model.hisobQuantities[worker.id]) || {};

      for (const op of model.operations) {
        const qty = workerQtyMap[op.name] || 0;
        const amount = qty * op.rate;
        row.push(amount > 0 ? amount : '', qty > 0 ? qty : '');
      }

      const tot = modelTotals.workerTotals[worker.id]?.totalEarnings || 0;
      row.push(tot > 0 ? tot : 0);
      hisobData.push(row);
    }

    // Totals row
    const totalRow: any[] = ['ЖАМИ', ''];
    for (const op of model.operations) {
      const opTot = modelTotals.operations[op.name];
      totalRow.push(opTot?.totalAmount || 0, opTot?.totalQuantity || 0);
    }
    totalRow.push(modelTotals.grandTotalAmount);
    hisobData.push(totalRow);

    const wsHisob = XLSX.utils.aoa_to_sheet(hisobData);
    XLSX.utils.book_append_sheet(wb, wsHisob, makeSheetName(model.hisobSheetName, usedSheetNames));
  }

  // Trigger browser download
  const dateStr = new Date().toISOString().slice(0, 10);
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

  const dateStr = new Date().toISOString().slice(0, 10);
  const finalFilename = customFilename || `Ishchilar_Royxati_${dateStr}.xlsx`;
  XLSX.writeFile(wb, finalFilename);
}
