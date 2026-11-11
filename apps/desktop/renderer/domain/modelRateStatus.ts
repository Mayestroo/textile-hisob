import type { ModelConfig } from '../types/workbook';

// Navigation's existing "narxsiz" category, not payroll rate valuation.
// Explicit zero remains categorized as unpriced here; it is still a known zero
// in payroll. Do not import UI components to consume this presentation policy.
export const isModelNarxsiz = (model: ModelConfig): boolean => {
  if (!model.operations || model.operations.length === 0) return true;
  return model.operations.some((operation) => !operation.rate || operation.rate <= 0);
};
