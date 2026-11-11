import type { Operation } from '../../types/workbook';

export type OperationRateDraft = Omit<Operation, 'rate'> & { rate: number | null };

export function cloneRateDraft(operations: Operation[]): OperationRateDraft[] {
  return operations.map((operation, index) => ({ ...operation,
    rate: operation.rate == null ? null : Number(operation.rate),
    col: operation.col ?? 3 + index * 2, id: operation.id || `op_${index + 1}` }));
}

export function parseRateDraft(value: string): number | null {
  return value.trim() === '' ? null : Number(value.replace(/\s+/g, ''));
}

export function finalizeRateDraft(operations: OperationRateDraft[]): Operation[] | null {
  if (operations.some(operation => operation.rate == null || !Number.isFinite(operation.rate) || operation.rate < 0)) return null;
  return operations.map(operation => ({ ...operation, rate: operation.rate! }));
}
