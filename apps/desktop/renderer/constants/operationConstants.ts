export interface StandardOperationTemplate {
  name: string;
  rate: number;
}

export const STANDARD_OPERATIONS: StandardOperationTemplate[] = [
  { name: 'Елка қўшиш', rate: 150 },
  { name: 'Рибана ўрнатиш', rate: 200 },
  { name: 'Бека', rate: 200 },
  { name: 'Орка бостирув', rate: 250 },
  { name: 'Енг ўрнатиш', rate: 280 },
  { name: 'Ён тикиш', rate: 300 },
  { name: 'Этак рашма', rate: 150 },
  { name: 'Енг рашма', rate: 170 },
  { name: 'Чистка', rate: 180 },
  { name: 'Дазмол', rate: 250 },
  { name: 'Контроль', rate: 180 },
  { name: 'Тахлов', rate: 100 },
];
