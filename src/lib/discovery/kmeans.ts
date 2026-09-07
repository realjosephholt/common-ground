import { mulberry32, type Rng } from "./rng";

export interface ClusterResult {
  k: number;
  assignments: number[];
  centroids: number[][];
  inertia: number;
}

export interface ChooseKResult extends ClusterResult {
  silhouette: number;
  /** silhouette score for every k that was tried, for transparency in the UI */
  scores: { k: number; silhouette: number }[];
}

function distSq(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return s;
}

/** k-means++ seeding — plain random init routinely collapses two of the opinion
 *  groups together, which silently understates polarisation. */
function seedCentroids(points: readonly number[][], k: number, rng: Rng): number[][] {
  const centroids: number[][] = [];
  const first = Math.floor(rng() * points.length);
  centroids.push(points[first]!.slice());

  while (centroids.length < k) {
    const d2 = points.map((p) => Math.min(...centroids.map((c) => distSq(p, c))));
    const total = d2.reduce((a, x) => a + x, 0);
    if (total <= 0) {
      centroids.push(points[Math.floor(rng() * points.length)]!.slice());
      continue;
    }
    let target = rng() * total;
    let idx = 0;
    for (let i = 0; i < d2.length; i++) {
      target -= d2[i]!;
      if (target <= 0) {
        idx = i;
        break;
      }
    }
    centroids.push(points[idx]!.slice());
  }
  return centroids;
}

export function kmeans(
  points: readonly number[][],
  k: number,
  opts: { seed?: number; maxIter?: number; restarts?: number } = {},
): ClusterResult {
  const maxIter = opts.maxIter ?? 100;
  const restarts = opts.restarts ?? 5;
  const n = points.length;
  const dim = n > 0 ? points[0]!.length : 0;

  if (n === 0) return { k: 0, assignments: [], centroids: [], inertia: 0 };
  if (k >= n) {
    return { k: n, assignments: points.map((_, i) => i), centroids: points.map((p) => p.slice()), inertia: 0 };
  }

  let best: ClusterResult | null = null;

  for (let attempt = 0; attempt < restarts; attempt++) {
    const rng = mulberry32((opts.seed ?? 42) + attempt * 7919);
    let centroids = seedCentroids(points, k, rng);
    const assignments = new Array<number>(n).fill(0);

    for (let it = 0; it < maxIter; it++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        let bestC = 0;
        let bestD = Infinity;
        for (let c = 0; c < centroids.length; c++) {
          const d = distSq(points[i]!, centroids[c]!);
          if (d < bestD) {
            bestD = d;
            bestC = c;
          }
        }
        if (assignments[i] !== bestC) {
          assignments[i] = bestC;
          moved = true;
        }
      }

      const sums: number[][] = Array.from({ length: k }, () => new Array<number>(dim).fill(0));
      const counts = new Array<number>(k).fill(0);
      for (let i = 0; i < n; i++) {
        const a = assignments[i]!;
        counts[a]!++;
        const p = points[i]!;
        const s = sums[a]!;
        for (let j = 0; j < dim; j++) s[j]! += p[j]!;
      }
      centroids = centroids.map((old, c) => {
        const cnt = counts[c]!;
        // An emptied centroid is re-seeded to the point furthest from its centroid,
        // rather than dropped — dropping silently changes k mid-run.
        if (cnt === 0) return points[Math.floor(rng() * n)]!.slice();
        return sums[c]!.map((x) => x / cnt);
      });

      if (!moved && it > 0) break;
    }

    let inertia = 0;
    for (let i = 0; i < n; i++) inertia += distSq(points[i]!, centroids[assignments[i]!]!);
    if (best === null || inertia < best.inertia) {
      best = { k, assignments: assignments.slice(), centroids, inertia };
    }
  }

  return best!;
}

/** Mean silhouette coefficient in [-1, 1]. Higher means better-separated groups. */
export function silhouette(points: readonly number[][], assignments: readonly number[], k: number): number {
  const n = points.length;
  if (n <= k || k < 2) return -1;

  const members: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) members[assignments[i]!]!.push(i);
  if (members.some((m) => m.length === 0)) return -1;

  let total = 0;
  for (let i = 0; i < n; i++) {
    const own = assignments[i]!;
    const ownMembers = members[own]!;
    let a = 0;
    if (ownMembers.length > 1) {
      for (const j of ownMembers) if (j !== i) a += Math.sqrt(distSq(points[i]!, points[j]!));
      a /= ownMembers.length - 1;
    }
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === own) continue;
      const other = members[c]!;
      let sum = 0;
      for (const j of other) sum += Math.sqrt(distSq(points[i]!, points[j]!));
      b = Math.min(b, sum / other.length);
    }
    const denom = Math.max(a, b);
    total += denom === 0 ? 0 : (b - a) / denom;
  }
  return total / n;
}

/**
 * Pick k by silhouette over a small range.
 *
 * We deliberately cap k low (default 2..5). More clusters would fit the data better
 * but the output is read by humans deciding whether a proposal bridges a divide —
 * eight opinion groups is not a divide anyone can reason about, and it makes the
 * `min` in the bridging score hostage to a tiny splinter cluster.
 */
export function chooseK(
  points: readonly number[][],
  opts: { minK?: number; maxK?: number; seed?: number } = {},
): ChooseKResult {
  const minK = opts.minK ?? 2;
  const maxK = Math.min(opts.maxK ?? 5, Math.max(1, points.length - 1));
  const scores: { k: number; silhouette: number }[] = [];

  let best: ChooseKResult | null = null;
  for (let k = minK; k <= maxK; k++) {
    const res = kmeans(points, k, { seed: opts.seed });
    const s = silhouette(points, res.assignments, res.k);
    scores.push({ k, silhouette: s });
    if (best === null || s > best.silhouette) best = { ...res, silhouette: s, scores };
  }

  if (best === null) {
    return { k: 1, assignments: points.map(() => 0), centroids: [], inertia: 0, silhouette: -1, scores };
  }
  best.scores = scores;
  return best;
}
