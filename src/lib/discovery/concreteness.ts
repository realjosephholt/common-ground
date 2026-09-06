/**
 * Concreteness: can a tactic actually be selected for this proposal?
 *
 * Three binary components — a named target who can say yes, a specific ask, and a
 * deadline. A proposal missing all three is not a cause, it is a mood, and because
 * readiness is a geometric mean a concreteness of 0 zeroes the whole score. That is
 * intentional and is the factor most likely to be argued about, so it is also the
 * factor most in need of a legible, editable audit trail.
 */

export interface ConcretenessSignals {
  /** A decision-maker exists who could grant the ask. */
  hasTarget: boolean;
  /** The ask names a specific change, not a value. */
  hasSpecificAsk: boolean;
  /** There is a date or event the ask is pinned to. */
  hasDeadline: boolean;
}

export interface ConcretenessResult extends ConcretenessSignals {
  /** 0..3 */
  raw: number;
  /** normalised to [0,1] */
  score: number;
  /** where each signal came from, so a human can correct it */
  evidence: Record<keyof ConcretenessSignals, string | null>;
  source: "heuristic" | "human" | "model";
}

/** Pluggable extractor; may be async (e.g. a model call). */
export interface ConcretenessExtractor {
  extract(text: string): Promise<ConcretenessResult> | ConcretenessResult;
}

/** The synchronous variant, so callers of the built-in default do not have to await
 *  a value that was never going to be a promise. */
export interface SyncConcretenessExtractor extends ConcretenessExtractor {
  extract(text: string): ConcretenessResult;
}

const DEADLINE_PATTERNS: RegExp[] = [
  /\b(by|before|no later than)\s+(the\s+)?\w+/i,
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/,
  /\b(next|this)\s+(week|month|quarter|year|session|meeting|election)\b/i,
  /\b(deadline|budget cycle|hearing|vote on)\b/i,
];

const TARGET_PATTERNS: RegExp[] = [
  /\b(city council|county|commission|commissioner|board|mayor|governor|senator|representative|assembly|legislature|school board|planning department|zoning board|dot|transit authority|landlord|university|regents|chancellor|ceo|management)\b/i,
  /\b(department|agency|ministry|authority) of \w+/i,
];

const SPECIFIC_ASK_PATTERNS: RegExp[] = [
  /\b(pass|adopt|repeal|amend|fund|defund|allocate|rezone|install|build|extend|restore|reduce|increase|cap|ban|require|publish|release|reinstate|cancel|suspend)\b/i,
  /\$\s?\d/,
  /\b\d+\s?(%|percent|units|beds|miles|km|seats|hours|stops)\b/i,
];

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return m[0];
  }
  return null;
}

/**
 * Dependency-free heuristic extractor.
 *
 * This is deliberately the DEFAULT rather than an LLM. Two reasons: a self-hosted
 * instance must work with no API key and no outbound network, and a model deciding
 * on its own that a proposal is "not concrete enough" is a censorship surface with a
 * plausible-deniability problem. A model may *suggest*; `source: "human"` always wins.
 */
export const heuristicConcreteness: SyncConcretenessExtractor = {
  extract(text: string): ConcretenessResult {
    const target = firstMatch(text, TARGET_PATTERNS);
    const ask = firstMatch(text, SPECIFIC_ASK_PATTERNS);
    const deadline = firstMatch(text, DEADLINE_PATTERNS);
    return finalise(
      { hasTarget: target !== null, hasSpecificAsk: ask !== null, hasDeadline: deadline !== null },
      { hasTarget: target, hasSpecificAsk: ask, hasDeadline: deadline },
      "heuristic",
    );
  },
};

export function finalise(
  signals: ConcretenessSignals,
  evidence: Record<keyof ConcretenessSignals, string | null>,
  source: ConcretenessResult["source"],
): ConcretenessResult {
  const raw = Number(signals.hasTarget) + Number(signals.hasSpecificAsk) + Number(signals.hasDeadline);
  return { ...signals, raw, score: raw / 3, evidence, source };
}

/** A human confirmation always overrides whatever was inferred. */
export function humanOverride(signals: ConcretenessSignals): ConcretenessResult {
  return finalise(signals, { hasTarget: null, hasSpecificAsk: null, hasDeadline: null }, "human");
}
