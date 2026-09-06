import { mulberry32, type Rng } from "../../src/lib/discovery/rng.js";
import type { CommitmentLevel, CommitmentRecord, VoteRecord, VoteValue } from "../../src/lib/discovery/types.js";

/**
 * Synthetic populations with KNOWN latent structure.
 *
 * A cold-start social product cannot be A/B tested — there are no users yet, and by
 * the time there are, a wrong scoring function has already misdirected real people's
 * time. Planted structure is the only way to check the engine recovers what it claims
 * to recover, so this harness is a load-bearing part of the project rather than a
 * nicety.
 */

export type StatementKind = "bridging" | "polarizing" | "divisive" | "unpopular";

export interface PlantedStatement {
  id: string;
  text: string;
  kind: StatementKind;
  /** true agreement probability within each latent group */
  pByGroup: number[];
}

export interface PlantedPopulation {
  /** ground-truth group index per user id */
  trueGroupOf: Map<string, number>;
  userIds: string[];
  statements: PlantedStatement[];
  votes: VoteRecord[];
  commitments: CommitmentRecord[];
  userLocations: Map<string, string>;
}

export interface PopulationOptions {
  groups?: number;
  usersPerGroup?: number;
  /** fraction of statements each user is shown */
  coverage?: number;
  /** how often a user votes against their group's stance */
  noise?: number;
  divisiveStatements?: number;
  /** statements every group feels the same way about */
  noiseStatements?: number;
  seed?: number;
}

/** Sample a vote given the probability of agreeing. */
function sampleVote(pAgree: number, rng: Rng): VoteValue {
  const r = rng();
  if (r < pAgree) return 1;
  // Remaining mass splits into disagree (mostly) and pass.
  return r < pAgree + (1 - pAgree) * 0.85 ? -1 : 0;
}

export function generatePopulation(opts: PopulationOptions = {}): PlantedPopulation {
  const G = opts.groups ?? 2;
  const perGroup = opts.usersPerGroup ?? 60;
  const coverage = opts.coverage ?? 0.8;
  const noise = opts.noise ?? 0.05;
  const divisiveCount = opts.divisiveStatements ?? 16;
  const noiseCount = opts.noiseStatements ?? 4;
  const rng = mulberry32(opts.seed ?? 7);

  const statements: PlantedStatement[] = [];

  // The calibrated pair the whole test rests on: a bridging statement and a
  // polarizing statement with IDENTICAL population-wide agreement. Any scorer that
  // ranks by raw agreement is forced to call these equal; a bridging scorer must not.
  const bridgingP = 0.75;
  statements.push({
    id: "s-bridge",
    text: "We should publish the council's inspection backlog by March so residents can see which buildings are overdue.",
    kind: "bridging",
    pByGroup: new Array<number>(G).fill(bridgingP),
  });

  // group 0 loves it, everyone else is lukewarm — same mean, opposite character.
  const polarP = new Array<number>(G).fill(0);
  polarP[0] = 0.99;
  const rest = (bridgingP * G - 0.99) / (G - 1);
  for (let g = 1; g < G; g++) polarP[g] = rest;
  statements.push({
    id: "s-polar",
    text: "We should defund the department entirely by next quarter and reallocate every dollar.",
    kind: "polarizing",
    pByGroup: polarP,
  });

  statements.push({
    id: "s-unpopular",
    text: "We should raise fees on everyone by 40% before June.",
    kind: "unpopular",
    pByGroup: new Array<number>(G).fill(0.12),
  });

  // Filler that creates the correlation structure PCA needs in order to find groups
  // at all. Each of these must genuinely DIVIDE: at least one group favours it and at
  // least one opposes. (An earlier version drew each group's stance independently,
  // which with two groups left half the "divisive" statements agreed on by everyone —
  // they were noise wearing a divisive label, and group recovery capped out around
  // ARI 0.6 as a result. Worth recording because the failure looked like a clustering
  // bug and was not.)
  for (let i = 0; i < divisiveCount; i++) {
    let highMask: boolean[];
    do {
      highMask = Array.from({ length: G }, () => rng() < 0.5);
    } while (highMask.every((h) => h) || highMask.every((h) => !h));
    const pByGroup = highMask.map((h) => (h ? 0.75 + rng() * 0.2 : 0.05 + rng() * 0.2));
    statements.push({
      id: `s-div-${i}`,
      text: `We should adopt measure ${i} at the next board meeting.`,
      kind: "divisive",
      pByGroup,
    });
  }

  // A handful of statements nobody splits on, so the fixture is not unrealistically
  // clean — real conversations contain plenty of these and the engine must tolerate them.
  for (let i = 0; i < noiseCount; i++) {
    const p = 0.35 + rng() * 0.3;
    statements.push({
      id: `s-noise-${i}`,
      text: `We should look into option ${i} at some point.`,
      kind: "divisive",
      pByGroup: new Array<number>(G).fill(p),
    });
  }

  const userIds: string[] = [];
  const trueGroupOf = new Map<string, number>();
  const votes: VoteRecord[] = [];

  for (let g = 0; g < G; g++) {
    for (let u = 0; u < perGroup; u++) {
      const uid = `u-${g}-${u}`;
      userIds.push(uid);
      trueGroupOf.set(uid, g);
      for (const s of statements) {
        if (rng() > coverage) continue;
        const base = s.pByGroup[g]!;
        const p = rng() < noise ? 1 - base : base;
        votes.push({ userId: uid, statementId: s.id, value: sampleVote(p, rng) });
      }
    }
  }

  return {
    trueGroupOf,
    userIds,
    statements,
    votes,
    commitments: [],
    userLocations: new Map(),
  };
}

const LEVELS: CommitmentLevel[] = ["support", "fund", "show_up", "skill", "organize"];

/**
 * Attach commitments and coarse locations to a population.
 * `concentration` in [0,1]: 1 puts every committed person in one cell, 0 scatters them.
 */
export function addCommitments(
  pop: PlantedPopulation,
  statementId: string,
  opts: { count: number; concentration?: number; seed?: number; levels?: CommitmentLevel[] },
): PlantedPopulation {
  const rng = mulberry32(opts.seed ?? 99);
  const concentration = opts.concentration ?? 1;
  const levels = opts.levels ?? LEVELS;

  // Two well-separated cells: central Austin and central Chicago.
  const HOME = "9v6kp";
  const AWAY = ["dp3wj", "dr5r7", "9q5cs", "c23nb", "dnh0h"];

  const chosen = pop.userIds.slice(0, opts.count);
  for (const uid of chosen) {
    const level = levels[Math.floor(rng() * levels.length)]!;
    pop.commitments.push({ userId: uid, statementId, level });
    const cell = rng() < concentration ? HOME : AWAY[Math.floor(rng() * AWAY.length)]!;
    pop.userLocations.set(uid, cell);
  }
  return pop;
}
