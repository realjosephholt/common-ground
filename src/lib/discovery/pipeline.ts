import { bridgeScore, perGroupAgreement, tallyByGroup } from "./bridging";
import { COMMITMENT_WEIGHTS, commitmentScore } from "./commitment";
import { heuristicConcreteness, type ConcretenessResult } from "./concreteness";
import { densityScore, type CommittedPerson } from "./density";
import { chooseK } from "./kmeans";
import { buildVoteMatrix, exposureCounts, toCenteredMatrix } from "./matrix";
import { pca } from "./pca";
import { DEFAULT_THRESHOLDS, readiness, tierFor, type ReadinessThresholds } from "./readiness";
import type { CommitmentRecord, StatementScore, VoteRecord } from "./types";

export interface StatementInput {
  id: string;
  text: string;
  approved: boolean;
  /** set once a human has confirmed or corrected the extracted signals */
  concretenessOverride?: ConcretenessResult;
}

export interface ConversationInput {
  statements: readonly StatementInput[];
  votes: readonly VoteRecord[];
  commitments: readonly CommitmentRecord[];
  /** coarse home cell per user; users without one are excluded from density */
  userLocations: ReadonlyMap<string, string>;
  seed?: number;
  thresholds?: ReadinessThresholds;
}

export interface OpinionGroup {
  index: number;
  userIds: string[];
  size: number;
}

export interface ConversationScoring {
  groups: OpinionGroup[];
  /** silhouette of the chosen k, and the score for every k tried */
  clusterQuality: { k: number; silhouette: number; scores: { k: number; silhouette: number }[] };
  /** 2-D coordinates per user, for the opinion map */
  userProjections: Map<string, [number, number]>;
  scores: StatementScore[];
}

/**
 * Run the full discovery pipeline for one conversation.
 *
 * Pure: takes records in, returns scores out, touches no database. That is what makes
 * the simulation harness possible, and the simulation harness is the only way to know
 * this maths is right before real users exist.
 */
export function scoreConversation(input: ConversationInput): ConversationScoring {
  const seed = input.seed ?? 42;
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;

  const approved = new Set(input.statements.filter((s) => s.approved).map((s) => s.id));
  const votes = input.votes.filter((v) => approved.has(v.statementId));

  const matrix = buildVoteMatrix(votes);
  const exposure = exposureCounts(matrix);

  // --- opinion groups -------------------------------------------------------
  let groups: OpinionGroup[] = [];
  const groupOf = new Map<string, number>();
  const userProjections = new Map<string, [number, number]>();
  let clusterQuality = { k: 1, silhouette: -1, scores: [] as { k: number; silhouette: number }[] };

  if (matrix.userIds.length >= 4) {
    const centered = toCenteredMatrix(matrix);
    const { projections } = pca(centered, 2, { seed });
    const points = projections.map((p) => [p[0] ?? 0, p[1] ?? 0]);
    matrix.userIds.forEach((uid, i) => userProjections.set(uid, [points[i]![0]!, points[i]![1]!]));

    const clustered = chooseK(points, { seed });
    clusterQuality = { k: clustered.k, silhouette: clustered.silhouette, scores: clustered.scores };

    const buckets: string[][] = Array.from({ length: clustered.k }, () => []);
    clustered.assignments.forEach((g, i) => {
      const uid = matrix.userIds[i]!;
      groupOf.set(uid, g);
      buckets[g]?.push(uid);
    });
    groups = buckets.map((userIds, index) => ({ index, userIds, size: userIds.length }));
  } else {
    // Too few participants to speak of "groups" at all. Treat everyone as one group;
    // the Beta prior keeps the resulting bridge scores appropriately unconfident.
    matrix.userIds.forEach((uid) => groupOf.set(uid, 0));
    groups = [{ index: 0, userIds: matrix.userIds.slice(), size: matrix.userIds.length }];
    clusterQuality = { k: 1, silhouette: -1, scores: [] };
  }

  const groupCount = Math.max(1, groups.length);

  // --- per-statement scoring -----------------------------------------------
  const votesByStatement = new Map<string, VoteRecord[]>();
  for (const v of votes) {
    let arr = votesByStatement.get(v.statementId);
    if (!arr) votesByStatement.set(v.statementId, (arr = []));
    arr.push(v);
  }
  const commitmentsByStatement = new Map<string, CommitmentRecord[]>();
  for (const c of input.commitments) {
    if (!approved.has(c.statementId)) continue;
    let arr = commitmentsByStatement.get(c.statementId);
    if (!arr) commitmentsByStatement.set(c.statementId, (arr = []));
    arr.push(c);
  }

  const scores: StatementScore[] = [];

  for (const st of input.statements) {
    if (!st.approved) continue;

    const sVotes = votesByStatement.get(st.id) ?? [];
    const sCommits = commitmentsByStatement.get(st.id) ?? [];
    const seenBy = exposure.get(st.id) ?? 0;

    const tallies = tallyByGroup(sVotes, groupOf, groupCount);
    const bridge = bridgeScore(tallies);
    const groupRates = perGroupAgreement(tallies);

    const commitment = commitmentScore(sCommits, seenBy);

    // Density is computed over pledged WEIGHT, not headcount: one local organiser
    // concentrates more capability than three distant supporters.
    const strongestPerUser = new Map<string, number>();
    for (const c of sCommits) {
      const w = COMMITMENT_WEIGHTS[c.level];
      if (w > (strongestPerUser.get(c.userId) ?? 0)) strongestPerUser.set(c.userId, w);
    }
    const committed: CommittedPerson[] = [];
    for (const [userId, weight] of strongestPerUser) {
      const geohash5 = input.userLocations.get(userId);
      if (geohash5) committed.push({ userId, geohash5, weight });
    }
    const density = densityScore(committed);

    const conc = st.concretenessOverride ?? heuristicConcreteness.extract(st.text);

    const factors = {
      bridge,
      commitment: commitment.score,
      density: density.score,
      concreteness: conc.score,
    };
    const r = readiness(factors);

    const agree = sVotes.filter((v) => v.value === 1).length;
    scores.push({
      statementId: st.id,
      factors,
      readiness: r,
      tier: tierFor(r, thresholds),
      perGroupAgreement: groupRates,
      diagnostics: {
        totalVotes: sVotes.length,
        rawAgreementRate: sVotes.length > 0 ? agree / sVotes.length : 0,
        exposure: seenBy,
        commitmentConversion: commitment.conversion,
        committedPeople: commitment.people,
      },
    });
  }

  scores.sort((a, b) => b.readiness - a.readiness);
  return { groups, clusterQuality, userProjections, scores };
}
