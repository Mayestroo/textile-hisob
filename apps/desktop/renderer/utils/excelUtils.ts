/**
 * Converts a 0-indexed column number to an Excel column letter (0 -> A, 1 -> B, ..., 26 -> AA)
 */
export function getExcelColumnLetter(index: number): string {
  let letter = '';
  let temp = index;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}
