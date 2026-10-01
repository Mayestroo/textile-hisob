export const SYSTEM_SHEETS = {
  UMUMIY: 'Umumiy',
  PATTA: 'Patta',
  PATTA_HISOB: 'Patta-hisob',
  KONVEYER: 'Konveyer',
} as const;

export const SYSTEM_SHEET_NAMES = [
  SYSTEM_SHEETS.UMUMIY,
  SYSTEM_SHEETS.PATTA,
  SYSTEM_SHEETS.PATTA_HISOB,
  SYSTEM_SHEETS.KONVEYER,
] as const;

export const DEFAULT_ACTIVE_SHEET = SYSTEM_SHEETS.UMUMIY;

export const STORAGE_KEY = 'BUXORO_FUTBOLKA_WORKBOOK_V1';
export const ACTIVE_SHEET_STORAGE_KEY = 'novda_active_sheet';
