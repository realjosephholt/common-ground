export * from "./types.js";
export { buildGraph, degreeMap, adjacency, normaliseName, entityKey, resolveAliases } from "./graph.js";
export { ruleBasedExtractor, indexCorpus } from "./extract.js";
export { detectCommunities, modularity } from "./communities.js";
export { structuralSummarizer, summarizeAll } from "./summarize.js";
export { localSearch, globalSearch } from "./search.js";
export { buildTaxonomy, tacticEvidence } from "./taxonomy.js";
export * from "./domain.js";

import { indexCorpus, ruleBasedExtractor } from "./extract.js";
import { detectCommunities } from "./communities.js";
import { structuralSummarizer, summarizeAll } from "./summarize.js";
import { buildTaxonomy, type IssueCluster } from "./taxonomy.js";
import type { Community, CommunityReport, Extractor, KnowledgeGraph, Summarizer, TextUnit } from "./types.js";

export interface IndexResult {
  graph: KnowledgeGraph;
  communities: Community[];
  reports: CommunityReport[];
  taxonomy: IssueCluster[];
  modularityByLevel: number[];
}

/** End-to-end indexing: corpus in, queryable graph + taxonomy out. */
export async function buildIndex(
  units: readonly TextUnit[],
  opts: {
    extractor?: Extractor;
    summarizer?: Summarizer;
    seed?: number;
    resolution?: number;
    taxonomyLevel?: number;
    humanLabels?: ReadonlyMap<string, string>;
    /** fold short entity names into longer ones when unambiguous */
    resolveAliases?: boolean;
  } = {},
): Promise<IndexResult> {
  const graph = await indexCorpus(units, opts.extractor ?? ruleBasedExtractor, {
    resolveAliases: opts.resolveAliases ?? false,
  });
  const { communities, modularityByLevel } = detectCommunities(graph, {
    seed: opts.seed,
    resolution: opts.resolution,
  });
  const reports = await summarizeAll(communities, graph, opts.summarizer ?? structuralSummarizer);
  const taxonomy = buildTaxonomy(graph, communities, reports, {
    level: opts.taxonomyLevel ?? 0,
    humanLabels: opts.humanLabels,
  });
  return { graph, communities, reports, taxonomy, modularityByLevel };
}
