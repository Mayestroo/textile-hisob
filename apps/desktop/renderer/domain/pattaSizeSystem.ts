import { DEFAULT_BATCH_SIZES } from '../constants/batchConstants';

export type PattaSizeSystem = 'letters' | 'numbers';

export const DEFAULT_NUMERIC_BATCH_SIZES = [
  '40', '42', '44', '46', '48', '50', '52', '54', '56', '58', '60'
];

export const DEPRECATED_NUMERIC_BATCH_SIZES = ['36', '38'];

export function isNumericPattaSize(size: string) {
  return /^\d+(?:\s*-\s*\d+)?$/.test(String(size || '').trim());
}

export function isDefaultPattaSize(size: string) {
  const normalized = String(size || '').trim().toUpperCase();
  return DEFAULT_BATCH_SIZES.includes(normalized) || DEFAULT_NUMERIC_BATCH_SIZES.includes(normalized);
}

export function isDeprecatedPattaSize(size: string) {
  return DEPRECATED_NUMERIC_BATCH_SIZES.includes(String(size || '').trim());
}

export function getPattaSizesForSystem(sizes: string[] | undefined, system: PattaSizeSystem) {
  const knownSizes = Array.from(new Set((sizes || [])
    .map((size) => String(size || '').trim())
    .filter((size) => size && !isDeprecatedPattaSize(size))));
  const matching = knownSizes.filter((size) => isNumericPattaSize(size) === (system === 'numbers'));
  if (system === 'numbers') return Array.from(new Set([...DEFAULT_NUMERIC_BATCH_SIZES, ...matching]));
  return matching.length > 0 ? matching : [...DEFAULT_BATCH_SIZES];
}
