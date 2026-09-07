/**
 * Guidance for someone writing a Statement.
 *
 * A Statement is an action with an intended outcome, never a complaint. That is not
 * style policing: Concreteness asks whether a Target, a specific ask and a deadline are
 * present, and because readiness is a geometric mean, a Concreteness of zero zeroes the
 * whole score. A Statement phrased as a grievance therefore cannot become actionable no
 * matter how many people agree with it.
 *
 * This guides and never gates. A model — or a regular expression — deciding on its own
 * that a proposal is "not concrete enough" is a censorship surface with a
 * plausible-deniability problem, which is the same reasoning that makes the heuristic
 * extractor the default in `discovery/concreteness.ts`. So the composer says what is
 * missing, the author decides, and the score is what actually judges it.
 */

import { heuristicConcreteness } from "../discovery/concreteness.js";

export type GuidanceCode =
  | "reads_as_complaint"
  | "no_target"
  | "no_specific_ask"
  | "no_deadline"
  | "very_short";

export interface Guidance {
  code: GuidanceCode;
  message: string;
}

/** Shortest text that could plausibly carry an ask. */
const MIN_USEFUL_LENGTH = 20;

/** Phrasings that describe a state of affairs rather than propose a change. Kept
 *  deliberately narrow: a false positive here is an unhelpful nag, and a nag on every
 *  Statement teaches people to ignore the guidance entirely. */
const COMPLAINT_PATTERNS: RegExp[] = [
  /\b(is|are|was|were)\s+(a\s+)?(terrible|awful|disgraceful|useless|a disgrace|appalling|ridiculous)\b/i,
  /\bnobody\s+(cares|listens|does anything)\b/i,
  /\b(i|we)\s+(hate|am sick of|are sick of|am tired of|are tired of|can't stand)\b/i,
  /\bwhy\s+(do|does|don't|doesn't|can't|won't)\b.*\?/i,
  /\bshould be ashamed\b/i,
  /\bfed up\b/i,
];

/** Words that mark an actual proposal, used to keep a complaint pattern from firing on
 *  a Statement that also proposes something. */
const PROPOSAL_MARKERS = /\b(ask|demand|call on|petition|propose|require|fund|pass|adopt|install|build|repeal)\b/i;

export function readsAsComplaint(text: string): boolean {
  if (PROPOSAL_MARKERS.test(text)) return false;
  return COMPLAINT_PATTERNS.some((pattern) => pattern.test(text));
}

export function composerGuidance(text: string): Guidance[] {
  const trimmed = text.trim();
  const guidance: Guidance[] = [];

  if (trimmed.length < MIN_USEFUL_LENGTH) {
    guidance.push({
      code: "very_short",
      message: "Too short to carry an ask. What should happen, and who could make it happen?",
    });
    return guidance;
  }

  if (readsAsComplaint(trimmed)) {
    guidance.push({
      code: "reads_as_complaint",
      message:
        "This reads as a complaint rather than a proposal. Nobody can agree to it, and it cannot score on " +
        "Concreteness. Try naming what you want done and who could do it.",
    });
  }

  const concreteness = heuristicConcreteness.extract(trimmed);
  if (!concreteness.hasTarget) {
    guidance.push({
      code: "no_target",
      message: "No decision-maker named. Who could actually grant this — a council, a board, a landlord?",
    });
  }
  if (!concreteness.hasSpecificAsk) {
    guidance.push({
      code: "no_specific_ask",
      message: "No specific change named. What exactly should be done differently?",
    });
  }
  if (!concreteness.hasDeadline) {
    guidance.push({
      code: "no_deadline",
      message: "No date or event to pin this to. By when, or before which meeting?",
    });
  }

  return guidance;
}
