/** Adjusted Rand Index — agreement between a predicted clustering and ground truth,
 *  corrected for chance. 1.0 is a perfect match, ~0 is random. */
export function adjustedRandIndex(truth: readonly number[], pred: readonly number[]): number {
  if (truth.length !== pred.length || truth.length === 0) return 0;

  const table = new Map<string, number>();
  const rowSums = new Map<number, number>();
  const colSums = new Map<number, number>();

  for (let i = 0; i < truth.length; i++) {
    const a = truth[i]!;
    const b = pred[i]!;
    const key = `${a}|${b}`;
    table.set(key, (table.get(key) ?? 0) + 1);
    rowSums.set(a, (rowSums.get(a) ?? 0) + 1);
    colSums.set(b, (colSums.get(b) ?? 0) + 1);
  }

  const c2 = (n: number) => (n * (n - 1)) / 2;
  const n = truth.length;

  let sumTable = 0;
  for (const v of table.values()) sumTable += c2(v);
  let sumRows = 0;
  for (const v of rowSums.values()) sumRows += c2(v);
  let sumCols = 0;
  for (const v of colSums.values()) sumCols += c2(v);

  const expected = (sumRows * sumCols) / c2(n);
  const max = (sumRows + sumCols) / 2;
  const denom = max - expected;
  return denom === 0 ? 1 : (sumTable - expected) / denom;
}
