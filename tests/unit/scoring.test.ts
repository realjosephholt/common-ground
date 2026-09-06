import { describe, expect, it } from "vitest";
import { agreementRate, bridgeScore, tallyByGroup } from "../../src/lib/discovery/bridging.js";
import { commitmentScore } from "../../src/lib/discovery/commitment.js";
import { heuristicConcreteness, humanOverride } from "../../src/lib/discovery/concreteness.js";
import { densityScore } from "../../src/lib/discovery/density.js";
import { decodeGeohash, encodeGeohash, haversineKm } from "../../src/lib/discovery/geohash.js";
import { limitingFactor, readiness, tierFor } from "../../src/lib/discovery/readiness.js";

describe("agreementRate (Beta(1,1) smoothing)", () => {
  it("returns the neutral prior when a group has not seen the statement", () => {
    expect(agreementRate({ agree: 0, disagree: 0, pass: 0 })).toBe(0.5);
  });

  it("stops a tiny unanimous sample outranking a large strong one", () => {
    const tiny = agreementRate({ agree: 2, disagree: 0, pass: 0 });
    const large = agreementRate({ agree: 90, disagree: 10, pass: 0 });
    expect(tiny).toBeLessThan(large);
  });

  it("counts a pass against agreement by default", () => {
    const withPass = agreementRate({ agree: 5, disagree: 0, pass: 5 });
    const without = agreementRate({ agree: 5, disagree: 0, pass: 0 });
    expect(withPass).toBeLessThan(without);
    expect(agreementRate({ agree: 5, disagree: 0, pass: 5 }, { passWeight: 0 })).toBeCloseTo(without, 10);
  });
});

describe("bridgeScore", () => {
  it("takes the minimum, so a large bloc cannot drown a dissenting group", () => {
    const lopsided = [
      { agree: 100, disagree: 0, pass: 0 },
      { agree: 2, disagree: 40, pass: 0 },
    ];
    const even = [
      { agree: 50, disagree: 20, pass: 0 },
      { agree: 50, disagree: 20, pass: 0 },
    ];
    expect(bridgeScore(lopsided)).toBeLessThan(bridgeScore(even));
  });

  it("is capped at the prior while any group remains unexposed", () => {
    expect(bridgeScore([{ agree: 500, disagree: 0, pass: 0 }, { agree: 0, disagree: 0, pass: 0 }])).toBe(0.5);
  });

  it("returns 0 with no groups", () => {
    expect(bridgeScore([])).toBe(0);
  });

  it("tallies votes into the right groups and ignores ungrouped voters", () => {
    const groupOf = new Map([["a", 0], ["b", 1]]);
    const t = tallyByGroup(
      [
        { userId: "a", value: 1 },
        { userId: "b", value: -1 },
        { userId: "ghost", value: 1 },
      ],
      groupOf,
      2,
    );
    expect(t[0]).toEqual({ agree: 1, disagree: 0, pass: 0 });
    expect(t[1]).toEqual({ agree: 0, disagree: 1, pass: 0 });
  });
});

describe("commitmentScore", () => {
  it("counts only a person's strongest pledge", () => {
    const both = commitmentScore(
      [
        { userId: "a", statementId: "s", level: "support" },
        { userId: "a", statementId: "s", level: "organize" },
      ],
      10,
    );
    const only = commitmentScore([{ userId: "a", statementId: "s", level: "organize" }], 10);
    expect(both.raw).toBe(only.raw);
    expect(both.people).toBe(1);
  });

  it("saturates rather than growing without bound", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ userId: `u${i}`, statementId: "s", level: "organize" as const }));
    const res = commitmentScore(many, 1000);
    expect(res.score).toBeLessThan(1);
    expect(res.score).toBeGreaterThan(0.98);
  });

  it("is zero with no pledges", () => {
    expect(commitmentScore([], 100).score).toBe(0);
  });

  it("does not penalise a proposal for reaching more people", () => {
    const c = Array.from({ length: 10 }, (_, i) => ({ userId: `u${i}`, statementId: "s", level: "show_up" as const }));
    expect(commitmentScore(c, 50).score).toBe(commitmentScore(c, 5000).score);
    expect(commitmentScore(c, 5000).conversion).toBeLessThan(commitmentScore(c, 50).conversion);
  });
});

describe("geohash", () => {
  it("round-trips a coordinate to within its cell", () => {
    const hash = encodeGeohash(30.2672, -97.7431, 5);
    const back = decodeGeohash(hash);
    expect(haversineKm(back, { lat: 30.2672, lng: -97.7431 })).toBeLessThan(5);
  });

  it("measures a known distance about right (Austin -> Chicago)", () => {
    const d = haversineKm({ lat: 30.2672, lng: -97.7431 }, { lat: 41.8781, lng: -87.6298 });
    expect(d).toBeGreaterThan(1500);
    expect(d).toBeLessThan(1650);
  });
});

describe("densityScore", () => {
  const here = encodeGeohash(30.2672, -97.7431, 5);
  const nearby = encodeGeohash(30.31, -97.71, 5);
  const faraway = encodeGeohash(41.8781, -87.6298, 5);

  it("scores a co-located group at 1", () => {
    const r = densityScore([
      { userId: "a", geohash5: here, weight: 3 },
      { userId: "b", geohash5: nearby, weight: 3 },
    ]);
    expect(r.score).toBe(1);
    expect(r.clusterPeople).toBe(2);
  });

  it("penalises a scattered group", () => {
    const r = densityScore([
      { userId: "a", geohash5: here, weight: 3 },
      { userId: "b", geohash5: faraway, weight: 3 },
    ]);
    expect(r.score).toBeCloseTo(0.5, 5);
  });

  it("weights by pledge strength, not headcount", () => {
    const r = densityScore([
      { userId: "organiser", geohash5: here, weight: 6 },
      { userId: "x", geohash5: faraway, weight: 1 },
      { userId: "y", geohash5: faraway, weight: 1 },
    ]);
    expect(r.score).toBeGreaterThan(0.5);
  });

  it("is 0 with nobody committed", () => {
    expect(densityScore([]).score).toBe(0);
  });
});

describe("concreteness", () => {
  it("finds target, ask and deadline in a well-formed proposal", () => {
    const r = heuristicConcreteness.extract(
      "We should get the city council to pass the tenant right-to-counsel ordinance before June.",
    );
    expect(r.hasTarget).toBe(true);
    expect(r.hasSpecificAsk).toBe(true);
    expect(r.hasDeadline).toBe(true);
    expect(r.score).toBe(1);
  });

  it("scores a pure sentiment at zero", () => {
    const r = heuristicConcreteness.extract("Things around here are really unfair and someone ought to care.");
    expect(r.raw).toBe(0);
    expect(r.score).toBe(0);
  });

  it("lets a human override the heuristic", () => {
    const r = humanOverride({ hasTarget: true, hasSpecificAsk: true, hasDeadline: false });
    expect(r.source).toBe("human");
    expect(r.score).toBeCloseTo(2 / 3, 10);
  });
});

describe("readiness", () => {
  const full = { bridge: 0.8, commitment: 0.8, density: 0.8, concreteness: 0.8 };

  it("is the geometric mean", () => {
    expect(readiness(full)).toBeCloseTo(0.8, 10);
  });

  it("cannot be bought out of a zero", () => {
    expect(readiness({ bridge: 1, commitment: 1, density: 1, concreteness: 0 })).toBe(0);
  });

  it("is dragged down by its weakest factor far more than an average would be", () => {
    const weak = { bridge: 0.95, commitment: 0.95, density: 0.95, concreteness: 0.1 };
    const arithmetic = (0.95 * 3 + 0.1) / 4;
    expect(readiness(weak)).toBeLessThan(arithmetic);
  });

  it("names the limiting factor so the dashboard can say what to fix", () => {
    expect(limitingFactor({ bridge: 0.9, commitment: 0.2, density: 0.8, concreteness: 0.7 })).toBe("commitment");
  });

  it("assigns tiers at the documented thresholds", () => {
    expect(tierFor(0.6)).toBe("ready");
    expect(tierFor(0.3)).toBe("emerging");
    expect(tierFor(0.1)).toBe("latent");
  });
});
