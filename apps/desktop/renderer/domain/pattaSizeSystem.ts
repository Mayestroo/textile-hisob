import { DEFAULT_BATCH_SIZES } from '../constants/batchConstants';

export type PattaSizeSystem = 'letters' | 'numbers';

export const DEFAULT_NUMERIC_BATCH_SIZES = [
  '40', '42', '44', '46', '48', '50', '52', '54', '56', '58', '60'
];

export const DEPRECATED_NUMERIC_BATCH_SIZES = ['36', '38'];

export const LETTER_SIZE_RANKS: Record<string, number> = {
  '6XS': 1, 'XXXXXXS': 1,
  '5XS': 2, 'XXXXXS': 2,
  '4XS': 3, 'XXXXS': 3,
  '3XS': 4, 'XXXS': 4,
  '2XS': 5, 'XXS': 5,
  'XS': 6,
  'S': 7,
  'S/M': 7.5,
  'M': 8,
  'M/L': 8.5,
  'L': 9,
  'L/XL': 9.5,
  'XL': 10,
  '2XL': 11, 'XXL': 11,
  '3XL': 12, 'XXXL': 12,
  '4XL': 13, 'XXXXL': 13,
  '5XL': 14, 'XXXXXL': 14,
  '6XL': 15, 'XXXXXXL': 15,
  '7XL': 16,
  '8XL': 17,
  '9XL': 18,
  '10XL': 19,
};

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

export function getLetterSizeRank(size: string): number | undefined {
  const norm = String(size || '').trim().toUpperCase();
  if (LETTER_SIZE_RANKS[norm] !== undefined) return LETTER_SIZE_RANKS[norm];
  const mXl = norm.match(/^(\d+)XL$/);
  if (mXl) return 9 + parseInt(mXl[1], 10);
  const mXs = norm.match(/^(\d+)XS$/);
  if (mXs) return 7 - parseInt(mXs[1], 10);
  return undefined;
}

export function comparePattaSizes(a: string, b: string): number {
  const normA = String(a || '').trim().toUpperCase();
  const normB = String(b || '').trim().toUpperCase();
  if (normA === normB) return 0;

  const isNumA = isNumericPattaSize(normA);
  const isNumB = isNumericPattaSize(normB);

  // Both are numeric
  if (isNumA && isNumB) {
    const numA = parseFloat(normA.split('-')[0].trim());
    const numB = parseFloat(normB.split('-')[0].trim());
    if (!isNaN(numA) && !isNaN(numB) && numA !== numB) {
      return numA - numB;
    }
    return normA.localeCompare(normB);
  }

  // Both are letter sizes
  const rankA = getLetterSizeRank(normA);
  const rankB = getLetterSizeRank(normB);
  if (rankA !== undefined && rankB !== undefined) {
    return rankA - rankB;
  }
  if (rankA !== undefined && rankB === undefined && !isNumB) return -1;
  if (rankB !== undefined && rankA === undefined && !isNumA) return 1;

  // One numeric, one letter: numeric sizes first, then letters
  if (isNumA && !isNumB) return -1;
  if (!isNumA && isNumB) return 1;

  // Fallback alphanumeric
  return normA.localeCompare(normB, undefined, { numeric: true });
}

export function sortPattaSizes(sizes: string[]): string[] {
  return [...sizes].sort(comparePattaSizes);
}

export function getPattaSizesForSystem(sizes: string[] | undefined, system: PattaSizeSystem) {
  const knownSizes = Array.from(new Set((sizes || [])
    .map((size) => String(size || '').trim())
    .filter((size) => size && !isDeprecatedPattaSize(size))));
  const matching = knownSizes.filter((size) => isNumericPattaSize(size) === (system === 'numbers'));
  if (system === 'numbers') return Array.from(new Set([...DEFAULT_NUMERIC_BATCH_SIZES, ...matching]));
  return matching.length > 0 ? matching : [...DEFAULT_BATCH_SIZES];
}
