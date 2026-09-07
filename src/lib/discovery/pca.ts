import { mulberry32 } from "./rng";

export type VoteMatrixLike = number[][];

export interface PcaResult {
  /** k components, each a unit vector of length d (statements) */
  components: number[][];
  /** n x k projection of each user into component space */
  projections: number[][];
  /** variance captured by each component */
  explainedVariance: number[];
}

/**
 * Top-k PCA by power iteration with deflation.
 *
 * We never materialise the d x d covariance matrix — at organising scale d (statements)
 * can exceed n (users), and the Gram matvec `Xᵀ(Xv)` is O(nd) per iteration either way.
 * Two components is enough: the point is a human-legible opinion map, not compression.
 */
export function pca(X: VoteMatrixLike, k: number, opts: { seed?: number; iterations?: number } = {}): PcaResult {
  const n = X.length;
  const d = n > 0 ? X[0]!.length : 0;
  const iterations = opts.iterations ?? 200;
  const rng = mulberry32(opts.seed ?? 42);

  const components: number[][] = [];
  const explainedVariance: number[] = [];
  if (n === 0 || d === 0) return { components, projections: [], explainedVariance };

  // Work on a mutable copy so we can deflate.
  const R: number[][] = X.map((row) => row.slice());
  const kk = Math.min(k, d, n);

  for (let comp = 0; comp < kk; comp++) {
    let v = Array.from({ length: d }, () => rng() * 2 - 1);
    normalise(v);

    for (let it = 0; it < iterations; it++) {
      // w = Rᵀ(R v)
      const Rv = new Array<number>(n).fill(0);
      for (let r = 0; r < n; r++) {
        const row = R[r]!;
        let s = 0;
        for (let c = 0; c < d; c++) s += row[c]! * v[c]!;
        Rv[r] = s;
      }
      const w = new Array<number>(d).fill(0);
      for (let r = 0; r < n; r++) {
        const row = R[r]!;
        const rv = Rv[r]!;
        if (rv === 0) continue;
        for (let c = 0; c < d; c++) w[c]! += row[c]! * rv;
      }
      const norm = Math.sqrt(w.reduce((a, x) => a + x * x, 0));
      if (norm < 1e-12) break; // no variance left in this direction
      for (let c = 0; c < d; c++) w[c]! /= norm;
      const delta = w.reduce((a, x, i) => a + Math.abs(x - v[i]!), 0);
      v = w;
      if (delta < 1e-10) break;
    }

    // Projection of every user onto this component, then deflate.
    const proj = new Array<number>(n).fill(0);
    for (let r = 0; r < n; r++) {
      const row = R[r]!;
      let s = 0;
      for (let c = 0; c < d; c++) s += row[c]! * v[c]!;
      proj[r] = s;
    }
    explainedVariance.push(proj.reduce((a, x) => a + x * x, 0) / Math.max(1, n - 1));
    for (let r = 0; r < n; r++) {
      const row = R[r]!;
      const p = proj[r]!;
      for (let c = 0; c < d; c++) row[c]! -= p * v[c]!;
    }
    components.push(v);
  }

  const projections: number[][] = Array.from({ length: n }, () => new Array<number>(components.length).fill(0));
  for (let r = 0; r < n; r++) {
    const row = X[r]!;
    for (let c = 0; c < components.length; c++) {
      const comp = components[c]!;
      let s = 0;
      for (let j = 0; j < d; j++) s += row[j]! * comp[j]!;
      projections[r]![c] = s;
    }
  }

  return { components, projections, explainedVariance };
}

function normalise(v: number[]): void {
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= norm;
}
