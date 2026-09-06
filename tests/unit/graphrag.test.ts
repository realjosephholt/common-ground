import { describe, expect, it } from "vitest";
import { detectCommunities, modularity } from "../../src/lib/graphrag/communities.js";
import { buildCorpus } from "../../src/lib/graphrag/domain.js";
import { indexCorpus, ruleBasedExtractor } from "../../src/lib/graphrag/extract.js";
import { adjacency, buildGraph, normaliseName, resolveAliases } from "../../src/lib/graphrag/graph.js";
import { buildIndex } from "../../src/lib/graphrag/index.js";
import { globalSearch, localSearch } from "../../src/lib/graphrag/search.js";
import { tacticEvidence } from "../../src/lib/graphrag/taxonomy.js";
import type { TextUnit } from "../../src/lib/graphrag/types.js";

const unit = (id: string, text: string, kind: TextUnit["source"]["kind"] = "statement"): TextUnit => ({
  id,
  text,
  source: { kind, id },
});

describe("entity normalisation and merging", () => {
  it("collapses surface variants of the same name", () => {
    expect(normaliseName("The City Council")).toBe("city council");
    expect(normaliseName("city  council!")).toBe("city council");
  });

  it("merges surface variants that normalise identically", () => {
    const graph = buildGraph(
      [
        { id: "x", name: "The City Council", type: "official", description: "short", textUnitIds: ["t1"], mentions: 1 },
        { id: "y", name: "city  council!", type: "official", description: "a longer description", textUnitIds: ["t2"], mentions: 2 },
      ],
      [],
      [unit("t1", "a"), unit("t2", "b")],
    );
    expect(graph.entities.size).toBe(1);
    const e = [...graph.entities.values()][0]!;
    expect(e.mentions).toBe(3);
    expect(e.textUnitIds.sort()).toEqual(["t1", "t2"]);
  });

  it("does NOT merge differently-named entities by default", () => {
    // "city council" and "Austin City Council" are probably the same body, but the
    // extractor cannot know that, and across regions they would not be. Silent merging
    // is the more dangerous default, so it must be asked for.
    const graph = buildGraph(
      [
        { id: "x", name: "city council", type: "official", description: "", textUnitIds: ["t1"], mentions: 1 },
        { id: "y", name: "Austin City Council", type: "official", description: "", textUnitIds: ["t2"], mentions: 1 },
      ],
      [],
      [unit("t1", "a"), unit("t2", "b")],
    );
    expect(graph.entities.size).toBe(2);
  });

  it("resolves an unambiguous alias when asked", () => {
    const graph = resolveAliases(
      buildGraph(
        [
          { id: "x", name: "city council", type: "official", description: "", textUnitIds: ["t1"], mentions: 1 },
          { id: "y", name: "Austin City Council", type: "official", description: "", textUnitIds: ["t2"], mentions: 1 },
        ],
        [],
        [unit("t1", "a"), unit("t2", "b")],
      ),
    );
    expect(graph.entities.size).toBe(1);
    expect([...graph.entities.values()][0]!.name).toBe("Austin City Council");
  });

  it("refuses an ambiguous alias", () => {
    // Two plausible expansions means the short form refers to neither in particular.
    const graph = resolveAliases(
      buildGraph(
        [
          { id: "x", name: "city council", type: "official", description: "", textUnitIds: ["t1"], mentions: 1 },
          { id: "y", name: "Austin City Council", type: "official", description: "", textUnitIds: ["t2"], mentions: 1 },
          { id: "z", name: "Dallas City Council", type: "official", description: "", textUnitIds: ["t3"], mentions: 1 },
        ],
        [],
        [unit("t1", "a"), unit("t2", "b"), unit("t3", "c")],
      ),
    );
    expect(graph.entities.size).toBe(3);
  });

  it("collapses duplicate edges into one weighted edge", () => {
    const ents = ["a", "b"].map((n) => ({
      id: `official:${n}`, name: n, type: "official" as const, description: "", textUnitIds: [], mentions: 1,
    }));
    const rel = { id: "r", sourceId: "official:a", targetId: "official:b", description: "", weight: 1, textUnitIds: ["t1"] };
    const graph = buildGraph(ents, [rel, { ...rel, textUnitIds: ["t2"] }], []);
    expect(graph.relationships).toHaveLength(1);
    expect(graph.relationships[0]!.weight).toBe(2);
  });
});

describe("rule-based extraction", () => {
  it("finds domain entities a generic extractor would miss", () => {
    const res = ruleBasedExtractor.extract([
      unit("t1", "We should get the city council to pass the rezoning ordinance. A rally would help."),
    ]);
    const names = res.entities.map((e) => e.name);
    expect(names).toContain("city council");
    expect(names).toContain("ordinance");
    expect(names).toContain("rally");
  });

  it("does not mistake a sentence-initial capital for a name", () => {
    const res = ruleBasedExtractor.extract([unit("t1", "We should act. They will not.")]);
    expect(res.entities.map((e) => e.name)).not.toContain("We");
    expect(res.entities.map((e) => e.name)).not.toContain("They");
  });

  it("links entities that appear in the same text", () => {
    const res = ruleBasedExtractor.extract([unit("t1", "The city council must fund childcare.")]);
    expect(res.relationships.length).toBeGreaterThan(0);
  });
});

describe("community detection", () => {
  /** Two dense clusters joined by a single bridge edge — the textbook case. */
  const plantedTwoCliques = () => {
    const names = ["a1", "a2", "a3", "a4", "b1", "b2", "b3", "b4"];
    const entities = names.map((n) => ({
      id: `org:${n}`, name: n, type: "org" as const, description: "", textUnitIds: [`t-${n}`], mentions: 1,
    }));
    const rels = [];
    const groupA = names.slice(0, 4);
    const groupB = names.slice(4);
    for (const g of [groupA, groupB]) {
      for (let i = 0; i < g.length; i++)
        for (let j = i + 1; j < g.length; j++)
          rels.push({ id: `${g[i]}-${g[j]}`, sourceId: `org:${g[i]}`, targetId: `org:${g[j]}`, description: "", weight: 5, textUnitIds: ["t"] });
    }
    rels.push({ id: "bridge", sourceId: "org:a1", targetId: "org:b1", description: "", weight: 1, textUnitIds: ["t"] });
    return buildGraph(entities, rels, names.map((n) => unit(`t-${n}`, n)));
  };

  it("recovers two planted cliques", () => {
    const graph = plantedTwoCliques();
    const { communities } = detectCommunities(graph, { seed: 1 });
    const level0 = communities.filter((c) => c.level === 0);
    expect(level0).toHaveLength(2);
    for (const c of level0) {
      const prefixes = new Set(c.entityIds.map((id) => id.slice(4, 5)));
      expect(prefixes.size).toBe(1); // no community mixes the two cliques
    }
  });

  it("produces positive modularity", () => {
    const graph = plantedTwoCliques();
    const { modularityByLevel } = detectCommunities(graph, { seed: 1 });
    expect(modularityByLevel[0]!).toBeGreaterThan(0.3);
  });

  it("leaves every community internally connected", () => {
    const graph = plantedTwoCliques();
    const { communities } = detectCommunities(graph, { seed: 1 });
    const adj = adjacency(graph);
    for (const c of communities) {
      const members = new Set(c.entityIds);
      const seen = new Set<string>([c.entityIds[0]!]);
      const stack = [c.entityIds[0]!];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const nb of adj.get(cur)?.keys() ?? []) {
          if (members.has(nb) && !seen.has(nb)) {
            seen.add(nb);
            stack.push(nb);
          }
        }
      }
      expect(seen.size).toBe(c.entityIds.length);
    }
  });

  it("handles an empty graph without throwing", () => {
    const graph = buildGraph([], [], []);
    expect(detectCommunities(graph).communities).toEqual([]);
  });
});

describe("search", () => {
  const corpus = () =>
    buildCorpus({
      statements: [
        { id: "s1", text: "We should get the planning commission to approve the rezoning ordinance for the 5th Street lot.", createdAt: 1 },
        { id: "s2", text: "The planning commission keeps deferring our permit at every meeting.", createdAt: 2 },
        { id: "s3", text: "We should organise a bake sale for the animal shelter.", createdAt: 3 },
      ],
      outcomes: [
        { id: "o1", campaignId: "c1", tactic: "public comment", targetName: "planning commission", result: "won", recordedAt: 10 },
        { id: "o2", campaignId: "c1", tactic: "public comment", targetName: "planning commission", result: "partial", recordedAt: 11 },
        { id: "o3", campaignId: "c1", tactic: "public comment", targetName: "planning commission", result: "won", recordedAt: 12 },
        { id: "o4", campaignId: "c2", tactic: "petition", targetName: "planning commission", result: "refused", recordedAt: 13 },
      ],
    });

  it("local search reaches the target and returns its evidence", async () => {
    const idx = await buildIndex(corpus(), { seed: 3 });
    const res = localSearch("planning commission", idx.graph, idx.reports);
    expect(res.entities.map((e) => e.name)).toContain("planning commission");
    const sources = res.textUnits.map((t) => t.source.id);
    expect(sources).toContain("s1");
    expect(sources).toContain("o1");
    // The unrelated bake sale must not be dragged in.
    expect(sources).not.toContain("s3");
  });

  it("global search returns communities, not passages", async () => {
    const idx = await buildIndex(corpus(), { seed: 3 });
    const res = globalSearch("what is happening", idx.graph, idx.reports);
    expect(res.mode).toBe("global");
    expect(res.reports.length).toBeGreaterThan(0);
    expect(res.rendered).toContain("## Communities");
  });

  it("connects statements that share an actor but no vocabulary", async () => {
    // s1 and s2 have almost no words in common beyond the actor. Embedding similarity
    // would likely separate them; the entity graph must not.
    const idx = await buildIndex(corpus(), { seed: 3 });
    const res = localSearch("planning commission", idx.graph, idx.reports);
    const sources = res.textUnits.map((t) => t.source.id);
    expect(sources).toContain("s1");
    expect(sources).toContain("s2");
  });
});

describe("tactic evidence (the feedback loop)", () => {
  it("aggregates outcomes per tactic", async () => {
    const idx = await buildIndex(
      buildCorpus({
        outcomes: [
          { id: "o1", campaignId: "c", tactic: "public comment", targetName: "city council", result: "won", recordedAt: 1 },
          { id: "o2", campaignId: "c", tactic: "public comment", targetName: "city council", result: "won", recordedAt: 2 },
          { id: "o3", campaignId: "c", tactic: "public comment", targetName: "city council", result: "refused", recordedAt: 3 },
        ],
      }),
      { seed: 5 },
    );
    const ev = tacticEvidence(idx.graph).find((e) => e.tactic === "public comment")!;
    expect(ev.total).toBe(3);
    expect(ev.won).toBe(2);
    expect(ev.refused).toBe(1);
    expect(ev.successRate).toBeCloseTo(2 / 3, 5);
  });

  it("refuses to report a success rate from too small a sample", async () => {
    const idx = await buildIndex(
      buildCorpus({
        outcomes: [{ id: "o1", campaignId: "c", tactic: "rally", targetName: "mayor", result: "won", recordedAt: 1 }],
      }),
      { seed: 5 },
    );
    const ev = tacticEvidence(idx.graph).find((e) => e.tactic === "rally")!;
    expect(ev.total).toBe(1);
    expect(ev.successRate).toBeNull();
  });
});

describe("indexCorpus", () => {
  it("builds a graph whose entities all trace back to a source text", async () => {
    const units = buildCorpus({
      statements: [{ id: "s1", text: "We should ask the school board to fund childcare before September.", createdAt: 1 }],
    });
    const graph = await indexCorpus(units);
    for (const e of graph.entities.values()) {
      expect(e.textUnitIds.length).toBeGreaterThan(0);
      for (const id of e.textUnitIds) expect(graph.textUnits.has(id)).toBe(true);
    }
  });
});
