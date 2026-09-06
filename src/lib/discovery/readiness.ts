import type { ReadinessFactors, ReadinessTier } from "./types.js";

export interface ReadinessThresholds {
  emerging: number;
  ready: number;
}

export const DEFAULT_THRESHOLDS: ReadinessThresholds = { emerging: 0.25, ready: 0.5 };

/**
 * Readiness = geometric mean of the four factors.
 *
 *     readiness = (bridge · commitment · density · concreteness)^(1/4)
 *
 * The geometric mean is the whole argument, not a detail of normalisation. It makes
 * the factors non-substitutable: a zero anywhere is a zero overall, and no amount of
 * one factor can buy its way past a missing one. Arithmetic mean would let 100%
 * agreement plus nobody willing to act score 0.5 and appear halfway to happening,
 * which is exactly the false signal every existing platform emits.
 *
 * Concretely, the four ways to score zero are all real-world failure modes:
 *   bridge = 0        → only one faction wants it; it will fracture on contact
 *   commitment = 0    → everyone approves, nobody will act
 *   density = 0       → supporters too scattered to be in one room
 *   concreteness = 0  → no target, no ask, no date; nothing to organise toward
 */
export function readiness(f: ReadinessFactors): number {
  const values = [f.bridge, f.commitment, f.density, f.concreteness];
  for (const v of values) {
    if (!Number.isFinite(v) || v <= 0) return 0;
  }
  const logSum = values.reduce((a, v) => a + Math.log(clamp01(v)), 0);
  return Math.exp(logSum / values.length);
}

export function tierFor(score: number, t: ReadinessThresholds = DEFAULT_THRESHOLDS): ReadinessTier {
  if (score >= t.ready) return "ready";
  if (score >= t.emerging) return "emerging";
  return "latent";
}

/**
 * Which factor is holding a proposal back — the single most useful thing the
 * dashboard can tell an organiser. "You have agreement and people; you have no
 * target" is actionable. A bare score of 0.31 is not.
 */
export function limitingFactor(f: ReadinessFactors): keyof ReadinessFactors {
  const entries = Object.entries(f) as [keyof ReadinessFactors, number][];
  let bestKey: keyof ReadinessFactors = "bridge";
  let bestVal = Infinity;
  for (const [k, v] of entries) {
    if (v < bestVal) {
      bestVal = v;
      bestKey = k;
    }
  }
  return bestKey;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
