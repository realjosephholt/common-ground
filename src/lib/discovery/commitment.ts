import type { CommitmentLevel, CommitmentRecord } from "./types";

/** What each kind of pledge is worth. Ordered by scarcity, not by enthusiasm:
 *  people who will *organise* are the binding constraint on almost every action,
 *  and people who will merely "support" are effectively unlimited. */
export const COMMITMENT_WEIGHTS: Record<CommitmentLevel, number> = {
  support: 1,
  fund: 1,
  show_up: 3,
  skill: 4,
  organize: 6,
};

export const MAX_COMMITMENT_WEIGHT = 6;

export interface CommitmentResult {
  /** the score used in readiness, in [0,1) */
  score: number;
  /** sum of weights — the raw quantity organisers actually care about */
  raw: number;
  /** distinct people who pledged anything */
  people: number;
  /** raw / (exposure * MAX_WEIGHT): a diagnostic, NOT part of the score */
  conversion: number;
}

export interface CommitmentOptions {
  /** Half-saturation constant: the raw weight at which the score reaches 0.5.
   *  Default 30 ≈ ten people who will show up, or five who will organise. */
  halfSaturation?: number;
}

/**
 * Commitment depth as a saturating function of ABSOLUTE pledged weight:
 *
 *     score = raw / (raw + K)
 *
 * A note on a deliberate deviation from the original design sketch, which called
 * for normalising by exposure. Exposure-normalisation turns out to be wrong here.
 * Whether an action is feasible depends on absolute numbers — twenty people who
 * will show up can run a rally whether twenty or twenty thousand saw the proposal.
 * Dividing by exposure would punish a proposal precisely for reaching more people,
 * which is backwards. The concern that motivated exposure-normalisation (don't let
 * raw counts favour old, widely-seen statements) is handled better by the
 * diminishing-returns curve, which flattens out instead of rewarding volume forever.
 *
 * The exposure-relative rate is still computed and returned as `conversion`, and it
 * belongs on the dashboard — a proposal with high raw commitment but 2% conversion
 * is a different animal from one with 40% conversion, and organisers should see that.
 * It just should not move the score.
 */
export function commitmentScore(
  commitments: readonly CommitmentRecord[],
  exposure: number,
  opts: CommitmentOptions = {},
): CommitmentResult {
  const K = opts.halfSaturation ?? 30;

  // One pledge per person: keep only their strongest.
  const strongest = new Map<string, number>();
  for (const c of commitments) {
    const w = COMMITMENT_WEIGHTS[c.level];
    const prev = strongest.get(c.userId) ?? 0;
    if (w > prev) strongest.set(c.userId, w);
  }

  let raw = 0;
  for (const w of strongest.values()) raw += w;

  const score = raw <= 0 ? 0 : raw / (raw + K);
  const conversion = exposure > 0 ? raw / (exposure * MAX_COMMITMENT_WEIGHT) : 0;
  return { score, raw, people: strongest.size, conversion };
}
