import { mulberry32, shuffled } from "../discovery/rng.js";
import { adjacency } from "./graph.js";
import type { Community, KnowledgeGraph } from "./types.js";

interface CompactGraph {
  n: number;
  /** adj[i] = Map<neighbour, weight> */
  adj: Map<number, number>[];
  /** self-loop weight accumulated by aggregation */
  selfLoops: number[];
  /** total weighted degree per node, including self-loops counted twice */
  degrees: number[];
  totalWeight: number;
}

function compact(adj: Map<string, Map<string, number>>, order: string[]): CompactGraph {
  const index = new Map(order.map((id, i) => [id, i]));
  const out: Map<number, number>[] = order.map(() => new Map());
  let total = 0;
  for (const [src, nbrs] of adj) {
    const i = index.get(src);
    if (i === undefined) continue;
    for (const [dst, w] of nbrs) {
      const j = index.get(dst);
      if (j === undefined || j === i) continue;
      out[i]!.set(j, w);
      if (i < j) total += w;
    }
  }
  const selfLoops = order.map(() => 0);
  const degrees = out.map((m, i) => {
    let d = selfLoops[i]! * 2;
    for (const w of m.values()) d += w;
    return d;
  });
  return { n: order.length, adj: out, selfLoops, degrees, totalWeight: total };
}

/**
 * One Louvain pass: greedily move nodes into the neighbouring community that most
 * increases modularity, until nothing moves.
 *
 * Gain of moving node i into community C (dropping constants that are equal across
 * candidates):   k_i,in  -  (Σ_tot(C) · k_i) / (2m)
 */
function localMoving(g: CompactGraph, resolution: number, seed: number): number[] {
  const community = Array.from({ length: g.n }, (_, i) => i);
  const sigmaTot = g.degrees.slice();
  const m2 = 2 * (g.totalWeight || 1);
  const rng = mulberry32(seed);
  const order = shuffled(Array.from({ length: g.n }, (_, i) => i), rng);

  let improved = true;
  let rounds = 0;
  while (improved && rounds++ < 50) {
    improved = false;
    for (const i of order) {
      const own = community[i]!;
      const ki = g.degrees[i]!;

      // Weight from i into each neighbouring community.
      const into = new Map<number, number>();
      for (const [j, w] of g.adj[i]!) into.set(community[j]!, (into.get(community[j]!) ?? 0) + w);

      // Remove i from its community before evaluating.
      sigmaTot[own] = sigmaTot[own]! - ki;

      let bestC = own;
      let bestGain = (into.get(own) ?? 0) - (resolution * sigmaTot[own]! * ki) / m2;

      for (const [c, wIn] of into) {
        if (c === own) continue;
        const gain = wIn - (resolution * sigmaTot[c]! * ki) / m2;
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          bestC = c;
        }
      }

      sigmaTot[bestC] = sigmaTot[bestC]! + ki;
      if (bestC !== own) {
        community[i] = bestC;
        improved = true;
      }
    }
  }
  return community;
}

/** Relabel communities to 0..k-1. */
function densify(assignment: readonly number[]): { labels: number[]; count: number } {
  const map = new Map<number, number>();
  const labels = assignment.map((c) => {
    let l = map.get(c);
    if (l === undefined) {
      l = map.size;
      map.set(c, l);
    }
    return l;
  });
  return { labels, count: map.size };
}

/**
 * Split any community that is internally disconnected into its connected components.
 *
 * Plain Louvain can leave a community whose members are not actually reachable from
 * each other — the well-known defect that motivated the Leiden algorithm. Full Leiden
 * is a lot of machinery; this repair pass buys the guarantee that matters here (every
 * community is a connected subgraph) for a fraction of the code. It matters because a
 * disconnected "cause" would be summarised as one thing and shown to organisers as one
 * thing while being two unrelated conversations.
 */
function repairConnectivity(g: CompactGraph, labels: readonly number[]): number[] {
  const members = new Map<number, number[]>();
  labels.forEach((c, i) => {
    let arr = members.get(c);
    if (!arr) members.set(c, (arr = []));
    arr.push(i);
  });

  const out = labels.slice();
  let next = Math.max(-1, ...labels) + 1;

  for (const [, nodes] of members) {
    const inCommunity = new Set(nodes);
    const seen = new Set<number>();
    let first = true;
    for (const start of nodes) {
      if (seen.has(start)) continue;
      const stack = [start];
      const component: number[] = [];
      seen.add(start);
      while (stack.length) {
        const cur = stack.pop()!;
        component.push(cur);
        for (const j of g.adj[cur]!.keys()) {
          if (inCommunity.has(j) && !seen.has(j)) {
            seen.add(j);
            stack.push(j);
          }
        }
      }
      // The first component keeps the original label; later ones are genuinely separate.
      if (!first) for (const node of component) out[node] = next++;
      first = false;
    }
  }
  return densify(out).labels;
}

function aggregate(g: CompactGraph, labels: readonly number[], count: number): CompactGraph {
  const adj: Map<number, number>[] = Array.from({ length: count }, () => new Map());
  const selfLoops = new Array<number>(count).fill(0);

  for (let i = 0; i < g.n; i++) {
    const ci = labels[i]!;
    selfLoops[ci] = selfLoops[ci]! + g.selfLoops[i]!;
    for (const [j, w] of g.adj[i]!) {
      const cj = labels[j]!;
      if (ci === cj) {
        if (i < j) selfLoops[ci] = selfLoops[ci]! + w;
      } else {
        adj[ci]!.set(cj, (adj[ci]!.get(cj) ?? 0) + w);
      }
    }
  }

  let total = 0;
  for (let i = 0; i < count; i++) {
    total += selfLoops[i]!;
    for (const [j, w] of adj[i]!) if (i < j) total += w;
  }
  const degrees = adj.map((m, i) => {
    let d = selfLoops[i]! * 2;
    for (const w of m.values()) d += w;
    return d;
  });
  return { n: count, adj, selfLoops, degrees, totalWeight: total };
}

export function modularity(g: CompactGraph, labels: readonly number[]): number {
  const m = g.totalWeight;
  if (m <= 0) return 0;
  const inW = new Map<number, number>();
  const totW = new Map<number, number>();
  for (let i = 0; i < g.n; i++) {
    const c = labels[i]!;
    totW.set(c, (totW.get(c) ?? 0) + g.degrees[i]!);
    inW.set(c, (inW.get(c) ?? 0) + g.selfLoops[i]!);
    for (const [j, w] of g.adj[i]!) if (labels[j] === c && i < j) inW.set(c, (inW.get(c) ?? 0) + w);
  }
  let q = 0;
  for (const [c, tot] of totW) q += (inW.get(c) ?? 0) / m - (tot / (2 * m)) ** 2;
  return q;
}

export interface DetectOptions {
  seed?: number;
  /** >1 yields more, smaller communities; <1 yields fewer, larger ones */
  resolution?: number;
  maxLevels?: number;
}

export interface DetectResult {
  communities: Community[];
  /** modularity of each level, coarsest last */
  modularityByLevel: number[];
}

/**
 * Hierarchical community detection over the entity graph.
 *
 * The hierarchy is the point, not a side effect: level 0 communities are specific
 * enough to be a campaign ("the 5th St rezoning"), higher levels are broad enough to
 * be a movement ("housing supply in the east side"). Global search reads the coarse
 * levels; local search reads the fine ones.
 */
export function detectCommunities(graph: KnowledgeGraph, opts: DetectOptions = {}): DetectResult {
  const seed = opts.seed ?? 42;
  const resolution = opts.resolution ?? 1;
  const maxLevels = opts.maxLevels ?? 4;

  const order = [...graph.entities.keys()].sort();
  if (order.length === 0) return { communities: [], modularityByLevel: [] };

  let g = compact(adjacency(graph), order);
  // membership[i] = index of the level-0 node -> its community at the current level
  let membership = Array.from({ length: order.length }, (_, i) => i);

  const communities: Community[] = [];
  const modularityByLevel: number[] = [];
  const childOf = new Map<string, string>(); // level-(L-1) community id -> level-L parent id

  let level = 0;
  let previousLevelIds: string[] | null = null;

  while (level < maxLevels) {
    const raw = localMoving(g, resolution, seed + level);
    const dense = densify(raw);
    const labels = repairConnectivity(g, dense.labels);
    const count = Math.max(...labels) + 1;

    if (count === g.n) break; // nothing merged; the hierarchy has converged
    modularityByLevel.push(modularity(g, labels));

    // Map every original entity to its community at this level.
    const nextMembership = membership.map((c) => labels[c]!);
    const buckets = new Map<number, string[]>();
    nextMembership.forEach((c, i) => {
      let arr = buckets.get(c);
      if (!arr) buckets.set(c, (arr = []));
      arr.push(order[i]!);
    });

    const levelIds: string[] = [];
    for (const [c, entityIds] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      const id = `c${level}-${c}`;
      levelIds.push(id);
      let internalWeight = 0;
      const set = new Set(entityIds);
      for (const r of graph.relationships) {
        if (set.has(r.sourceId) && set.has(r.targetId)) internalWeight += r.weight;
      }
      communities.push({ id, level, entityIds, parentId: null, internalWeight });
    }

    // Link the previous (finer) level's communities to their parent here.
    if (previousLevelIds) {
      for (const prev of communities.filter((x) => x.level === level - 1)) {
        const anchor = prev.entityIds[0];
        if (!anchor) continue;
        const idx = order.indexOf(anchor);
        const parent = `c${level}-${nextMembership[idx]!}`;
        prev.parentId = parent;
        childOf.set(prev.id, parent);
      }
    }
    previousLevelIds = levelIds;

    membership = nextMembership;
    g = aggregate(g, labels, count);
    level++;
    if (count === 1) break;
  }

  return { communities, modularityByLevel };
}
