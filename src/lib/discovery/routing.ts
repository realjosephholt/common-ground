import { mulberry32 } from "./rng.js";

export interface RoutingCandidate {
  statementId: string;
  /** total votes cast on it so far */
  votes: number;
  /** per-opinion-group agreement rates from the last scoring run (may be empty) */
  perGroupAgreement: number[];
  /** moderation gate — anything not approved never routes */
  approved: boolean;
  createdAt: number;
}

export interface RoutingContext {
  /** statements this user has already voted on */
  seen: ReadonlySet<string>;
  /** the user's opinion group index, or null if they have not voted enough yet */
  userGroup: number | null;
  candidates: readonly RoutingCandidate[];
  now?: number;
}

export interface RoutingOptions {
  seed?: number;
  /** weight on reducing uncertainty about under-voted statements */
  infoGainWeight?: number;
  /** weight on showing the user proposals that OTHER groups like */
  crossGroupWeight?: number;
  /** weight on giving brand-new statements a chance to be seen at all */
  freshnessWeight?: number;
  /** softmax temperature; higher = more exploration */
  temperature?: number;
}

export interface ScoredCandidate {
  statementId: string;
  priority: number;
  infoGain: number;
  crossGroup: number;
  freshness: number;
}

/**
 * Decide which statement to show a voter next.
 *
 * This looks like a minor UI detail and is actually one of the two or three most
 * consequential functions in the codebase, because it determines which cells of the
 * vote matrix ever get filled in. Two failure modes it exists to prevent:
 *
 *  - Random selection wastes votes. Attention is the scarcest input; spending it on
 *    a statement that already has 400 votes buys almost no information.
 *  - Relevance-ranked selection (show people what they'll agree with) manufactures
 *    the exact echo chamber the bridging score is built to detect, and it does so
 *    invisibly — the score would report high consensus because dissenters were never
 *    shown the statement.
 *
 * So priority mixes three terms:
 *   infoGain    1/sqrt(votes+1)  — prefer under-voted statements
 *   crossGroup  agreement among groups the user is NOT in — deliberate exposure to
 *               what the other side likes, which is where bridges are found
 *   freshness   decaying bonus so new statements escape the cold start
 *
 * Selection is softmax-sampled rather than argmax so that a hundred users arriving at
 * once do not all vote on the same statement.
 */
export function scoreCandidates(ctx: RoutingContext, opts: RoutingOptions = {}): ScoredCandidate[] {
  const infoGainWeight = opts.infoGainWeight ?? 1;
  const crossGroupWeight = opts.crossGroupWeight ?? 1.2;
  const freshnessWeight = opts.freshnessWeight ?? 0.5;
  const now = ctx.now ?? Date.now();
  const DAY = 86_400_000;

  const out: ScoredCandidate[] = [];
  for (const c of ctx.candidates) {
    if (!c.approved) continue;
    if (ctx.seen.has(c.statementId)) continue;

    const infoGain = 1 / Math.sqrt(c.votes + 1);

    let crossGroup = 0;
    if (ctx.userGroup !== null && c.perGroupAgreement.length > 1) {
      const others = c.perGroupAgreement.filter((_, i) => i !== ctx.userGroup);
      if (others.length > 0) crossGroup = Math.max(...others);
    } else {
      // Unknown group: stay neutral rather than guessing.
      crossGroup = 0.5;
    }

    const ageDays = Math.max(0, (now - c.createdAt) / DAY);
    const freshness = Math.exp(-ageDays / 7);

    const priority =
      infoGainWeight * infoGain + crossGroupWeight * crossGroup + freshnessWeight * freshness;

    out.push({ statementId: c.statementId, priority, infoGain, crossGroup, freshness });
  }

  out.sort((a, b) => b.priority - a.priority);
  return out;
}

/** Softmax sample `limit` statements without replacement. */
export function selectNextStatements(ctx: RoutingContext, limit: number, opts: RoutingOptions = {}): string[] {
  const temperature = opts.temperature ?? 0.35;
  const rng = mulberry32(opts.seed ?? 1337);
  const pool = scoreCandidates(ctx, opts);
  const picked: string[] = [];

  const remaining = pool.slice();
  while (picked.length < limit && remaining.length > 0) {
    const weights = remaining.map((c) => Math.exp(c.priority / temperature));
    const total = weights.reduce((a, x) => a + x, 0);
    let target = rng() * total;
    let idx = remaining.length - 1;
    for (let i = 0; i < remaining.length; i++) {
      target -= weights[i]!;
      if (target <= 0) {
        idx = i;
        break;
      }
    }
    picked.push(remaining[idx]!.statementId);
    remaining.splice(idx, 1);
  }
  return picked;
}
