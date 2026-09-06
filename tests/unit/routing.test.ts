import { describe, expect, it } from "vitest";
import { scoreCandidates, selectNextStatements, type RoutingCandidate } from "../../src/lib/discovery/routing.js";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const c = (over: Partial<RoutingCandidate> & { statementId: string }): RoutingCandidate => ({
  votes: 10,
  perGroupAgreement: [0.5, 0.5],
  approved: true,
  createdAt: NOW - 30 * DAY,
  ...over,
});

describe("routing", () => {
  it("never routes an unapproved statement", () => {
    const res = scoreCandidates({
      seen: new Set(),
      userGroup: 0,
      now: NOW,
      candidates: [c({ statementId: "ok" }), c({ statementId: "blocked", approved: false })],
    });
    expect(res.map((r) => r.statementId)).toEqual(["ok"]);
  });

  it("never re-shows a statement the user already voted on", () => {
    const res = scoreCandidates({
      seen: new Set(["done"]),
      userGroup: 0,
      now: NOW,
      candidates: [c({ statementId: "done" }), c({ statementId: "fresh" })],
    });
    expect(res.map((r) => r.statementId)).toEqual(["fresh"]);
  });

  it("prefers under-voted statements, because attention is the scarce input", () => {
    const res = scoreCandidates({
      seen: new Set(),
      userGroup: 0,
      now: NOW,
      candidates: [c({ statementId: "saturated", votes: 5000 }), c({ statementId: "sparse", votes: 1 })],
    });
    expect(res[0]!.statementId).toBe("sparse");
  });

  it("prefers statements the user's OWN group has not driven", () => {
    // Same vote count and age; the only difference is who likes it. The one the other
    // group likes must win, or the bridging score can never observe cross-group support.
    const res = scoreCandidates({
      seen: new Set(),
      userGroup: 0,
      now: NOW,
      candidates: [
        c({ statementId: "own-group", perGroupAgreement: [0.95, 0.05] }),
        c({ statementId: "other-group", perGroupAgreement: [0.05, 0.95] }),
      ],
    });
    expect(res[0]!.statementId).toBe("other-group");
  });

  it("gives brand-new statements a chance against established ones", () => {
    const res = scoreCandidates({
      seen: new Set(),
      userGroup: 0,
      now: NOW,
      candidates: [
        c({ statementId: "old", createdAt: NOW - 200 * DAY }),
        c({ statementId: "new", createdAt: NOW }),
      ],
    });
    expect(res[0]!.statementId).toBe("new");
  });

  it("stays neutral when the user has no opinion group yet", () => {
    const res = scoreCandidates({
      seen: new Set(),
      userGroup: null,
      now: NOW,
      candidates: [c({ statementId: "a", perGroupAgreement: [0.9, 0.1] })],
    });
    expect(res[0]!.crossGroup).toBe(0.5);
  });

  it("does not hand every simultaneous voter the same statement", () => {
    const candidates = Array.from({ length: 12 }, (_, i) => c({ statementId: `s${i}`, votes: 10 + i }));
    const ctx = { seen: new Set<string>(), userGroup: 0, now: NOW, candidates };
    const picks = new Set([1, 2, 3, 4, 5].map((seed) => selectNextStatements(ctx, 1, { seed })[0]));
    expect(picks.size).toBeGreaterThan(1);
  });

  it("returns distinct statements within one batch", () => {
    const candidates = Array.from({ length: 8 }, (_, i) => c({ statementId: `s${i}` }));
    const picked = selectNextStatements({ seen: new Set(), userGroup: 0, now: NOW, candidates }, 5, { seed: 9 });
    expect(new Set(picked).size).toBe(5);
  });

  it("cannot return more than exist", () => {
    const picked = selectNextStatements(
      { seen: new Set(), userGroup: 0, now: NOW, candidates: [c({ statementId: "only" })] },
      10,
      { seed: 1 },
    );
    expect(picked).toEqual(["only"]);
  });
});
