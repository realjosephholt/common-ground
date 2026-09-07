import type { GroupVoteTally } from "./types";

export interface BridgeOptions {
  /** How much a "pass" counts against agreement. 1 = a pass is as good as a
   *  disagree; 0 = passes are ignored entirely. Default 1: on a *proposal*, "I'd
   *  rather not say" is not support, and treating it as neutral lets vague
   *  feel-good statements float to the top. */
  passWeight?: number;
}

/**
 * Agreement rate for one statement within one opinion group, as the mean of a
 * Beta(1,1) posterior.
 *
 *     p = (agree + 1) / (agree + disagree + passWeight*pass + 2)
 *
 * The prior is doing real work here, in two places:
 *
 *  1. It stops 2-of-2 (raw 1.00) outranking 90-of-100 (raw 0.90) — the smoothed
 *     values are 0.75 and 0.89.
 *  2. A group that has *never seen* the statement scores exactly 0.5 rather than
 *     0 or 1. Combined with `bridgeScore` taking a minimum, this caps a statement's
 *     bridge score at 0.5 until every group has actually been exposed to it. That
 *     is the behaviour we want: unexposed is not the same as agreed, and it makes
 *     the routing layer's job (get cross-group exposure) legible in the score.
 */
export function agreementRate(t: GroupVoteTally, opts: BridgeOptions = {}): number {
  const passWeight = opts.passWeight ?? 1;
  const observed = t.agree + t.disagree + passWeight * t.pass;
  return (t.agree + 1) / (observed + 2);
}

/**
 * The bridging score: the MINIMUM agreement rate across all opinion groups.
 *
 * Minimum, not mean. This is the single most important decision in the engine.
 * A mean lets a large bloc drown a dissenting group, so "consensus" degenerates
 * into "whatever the biggest group wants" — precisely the dynamic this app exists
 * to escape. Taking the minimum means a proposal only scores when even the least
 * enthusiastic group is on board, which is also the honest predictor of whether
 * an action will hold together once it meets opposition.
 */
export function bridgeScore(tallies: readonly GroupVoteTally[], opts: BridgeOptions = {}): number {
  if (tallies.length === 0) return 0;
  let min = Infinity;
  for (const t of tallies) min = Math.min(min, agreementRate(t, opts));
  return min;
}

/** Per-group rates, kept alongside the score so the UI can always show the breakdown.
 *  Publishing the decomposition is a deliberate anti-manipulation measure: a scoring
 *  system people cannot inspect will be assumed to be rigged, and eventually will be. */
export function perGroupAgreement(tallies: readonly GroupVoteTally[], opts: BridgeOptions = {}): number[] {
  return tallies.map((t) => agreementRate(t, opts));
}

/** Tally votes for one statement, split by the opinion group each voter belongs to. */
export function tallyByGroup(
  votes: readonly { userId: string; value: -1 | 0 | 1 }[],
  groupOf: ReadonlyMap<string, number>,
  groupCount: number,
): GroupVoteTally[] {
  const out: GroupVoteTally[] = Array.from({ length: groupCount }, () => ({ agree: 0, disagree: 0, pass: 0 }));
  for (const v of votes) {
    const g = groupOf.get(v.userId);
    if (g === undefined || g < 0 || g >= groupCount) continue;
    const t = out[g]!;
    if (v.value === 1) t.agree++;
    else if (v.value === -1) t.disagree++;
    else t.pass++;
  }
  return out;
}
