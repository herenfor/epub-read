/** Font size as shown in Aa: at most two decimals, no trailing zeros (20.600000000000003 → "20.6"). Display only; the saved setting keeps its value. */
export function formatFontSizePx(value: number): string {
  return String(Math.round(value * 100) / 100);
}
