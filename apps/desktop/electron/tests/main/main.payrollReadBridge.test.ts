import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('payroll valuation on the existing workbook read bridge', () => {
  it('reads the explicit company and projection period inside db-read and attaches the optional result', () => {
    const source = readFileSync(new URL('../../main.cjs', import.meta.url), 'utf8');
    const start = source.indexOf("ipcMain.handle('db-read'");
    const end = source.indexOf("ipcMain.handle('adjustment-sources'", start);
    const handler = source.slice(start, end);

    expect(handler).toContain("require('./database/workbookPayrollRead.cjs')");
    expect(handler).toContain('readWorkbookPayrollProjection(ready.db, ready.companyId)');
    expect(handler).toContain('data\n');
  });
});
