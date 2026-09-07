import { describe, expect, it } from "vitest";
import { scoreConversation } from "../../src/lib/discovery/pipeline";
import { readiness } from "../../src/lib/discovery/readiness";
import { adjustedRandIndex } from "./metrics";
import { addCommitments, generatePopulation } from "./populations";

function toStatements(pop: ReturnType<typeof generatePopulation>) {
  return pop.statements.map((s) => ({ id: s.id, text: s.text, approved: true }));
}

describe("opinion group recovery", () => {
  it("recovers planted groups at high ARI (2 groups)", () => {
    const pop = generatePopulation({ groups: 2, usersPerGroup: 80, seed: 11 });
    const res = scoreConversation({
      statements: toStatements(pop),
      votes: pop.votes,
      commitments: [],
      userLocations: new Map(),
    });

    const truth: number[] = [];
    const pred: number[] = [];
    res.groups.forEach((g) => {
      for (const uid of g.userIds) {
        truth.push(pop.trueGroupOf.get(uid)!);
        pred.push(g.index);
      }
    });

    expect(res.groups.length).toBe(2);
    expect(adjustedRandIndex(truth, pred)).toBeGreaterThan(0.9);
  });

  it("recovers planted groups at high ARI (3 groups)", () => {
    const pop = generatePopulation({ groups: 3, usersPerGroup: 70, divisiveStatements: 20, seed: 23 });
    const res = scoreConversation({
      statements: toStatements(pop),
      votes: pop.votes,
      commitments: [],
      userLocations: new Map(),
    });

    const truth: number[] = [];
    const pred: number[] = [];
    res.groups.forEach((g) => {
      for (const uid of g.userIds) {
        truth.push(pop.trueGroupOf.get(uid)!);
        pred.push(g.index);
      }
    });
    expect(adjustedRandIndex(truth, pred)).toBeGreaterThan(0.9);
  });
});

describe("bridging beats polarizing at equal raw agreement", () => {
  /**
   * The load-bearing test of the whole project.
   *
   * The fixture plants two statements with deliberately IDENTICAL population-wide
   * agreement: one that 75% of every group supports, and one that group 0 adores and
   * the rest are lukewarm on. Any scorer that ranks by popularity is mathematically
   * forced to call these equal. A bridging scorer must separate them.
   *
   * Asserted across seeds rather than on one run. With two groups and equal raw
   * agreement the largest gap that can even be planted is 0.25, so a single seed with
   * a tight threshold tests sampling luck, not the estimator. Requiring the ordering
   * to hold on EVERY seed is both stricter and more meaningful.
   */
  const SEEDS = [3, 5, 11, 17, 23, 31, 47, 59];

  const runSeed = (seed: number) => {
    const pop = generatePopulation({ groups: 2, usersPerGroup: 150, seed });
    const res = scoreConversation({
      statements: toStatements(pop),
      votes: pop.votes,
      commitments: [],
      userLocations: new Map(),
    });
    return {
      bridge: res.scores.find((s) => s.statementId === "s-bridge")!,
      polar: res.scores.find((s) => s.statementId === "s-polar")!,
    };
  };

  it("separates them on every seed, while raw agreement cannot", () => {
    const gaps: number[] = [];
    const rawGaps: number[] = [];

    for (const seed of SEEDS) {
      const { bridge, polar } = runSeed(seed);
      expect(bridge.factors.bridge).toBeGreaterThan(polar.factors.bridge);
      gaps.push(bridge.factors.bridge - polar.factors.bridge);
      rawGaps.push(Math.abs(bridge.diagnostics.rawAgreementRate - polar.diagnostics.rawAgreementRate));
    }

    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    // Raw agreement cannot tell them apart...
    expect(mean(rawGaps)).toBeLessThan(0.04);
    // ...the bridging score reliably can.
    expect(mean(gaps)).toBeGreaterThan(0.15);
  });

  it("ranks the bridging statement higher overall", () => {
    for (const seed of SEEDS) {
      const { bridge, polar } = runSeed(seed);
      expect(bridge.readiness).toBeGreaterThanOrEqual(polar.readiness);
    }
  });

  it("scores an unpopular statement below the bridging one", () => {
    const pop = generatePopulation({ groups: 2, usersPerGroup: 100, seed: 5 });
    const res = scoreConversation({
      statements: toStatements(pop),
      votes: pop.votes,
      commitments: [],
      userLocations: new Map(),
    });
    const bridge = res.scores.find((s) => s.statementId === "s-bridge")!;
    const unpopular = res.scores.find((s) => s.statementId === "s-unpopular")!;
    expect(unpopular.factors.bridge).toBeLessThan(bridge.factors.bridge);
  });
});

describe("readiness is non-substitutable", () => {
  it("zeroes when any single factor is zero", () => {
    const full = { bridge: 0.9, commitment: 0.9, density: 0.9, concreteness: 0.9 };
    expect(readiness(full)).toBeGreaterThan(0.85);
    for (const key of Object.keys(full) as (keyof typeof full)[]) {
      expect(readiness({ ...full, [key]: 0 })).toBe(0);
    }
  });

  it("broad agreement with no commitment never reaches 'ready'", () => {
    const pop = generatePopulation({ groups: 2, usersPerGroup: 80, seed: 31 });
    const res = scoreConversation({
      statements: toStatements(pop),
      votes: pop.votes,
      commitments: [], // nobody will actually do anything
      userLocations: new Map(),
    });
    for (const s of res.scores) expect(s.tier).not.toBe("ready");
  });

  it("concentrated commitment outscores scattered commitment", () => {
    const base = () => generatePopulation({ groups: 2, usersPerGroup: 80, seed: 41 });

    const concentrated = addCommitments(base(), "s-bridge", { count: 40, concentration: 1, seed: 3 });
    const scattered = addCommitments(base(), "s-bridge", { count: 40, concentration: 0, seed: 3 });

    const runFor = (pop: ReturnType<typeof generatePopulation>) =>
      scoreConversation({
        statements: toStatements(pop),
        votes: pop.votes,
        commitments: pop.commitments,
        userLocations: pop.userLocations,
      }).scores.find((s) => s.statementId === "s-bridge")!;

    const a = runFor(concentrated);
    const b = runFor(scattered);

    expect(a.factors.commitment).toBeCloseTo(b.factors.commitment, 5);
    expect(a.factors.density).toBeGreaterThan(b.factors.density);
    expect(a.readiness).toBeGreaterThan(b.readiness);
  });
});
