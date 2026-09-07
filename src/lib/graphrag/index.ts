export * from "./types";
export { buildGraph, degreeMap, adjacency, normaliseName, entityKey, resolveAliases } from "./graph";
export { ruleBasedExtractor, indexCorpus } from "./extract";
export { detectCommunities, modularity } from "./communities";
export { structuralSummarizer, summarizeAll } from "./summarize";
export { localSearch, globalSearch } from "./search";
export { buildTaxonomy, tacticEvidence } from "./taxonomy";
export * from "./domain";

import { indexCorpus, ruleBasedExtractor } from "./extract";
import { detectCommunities } from "./communities";
import { structuralSummarizer, summarizeAll } from "./summarize";
import { buildTaxonomy, type IssueCluster } from "./taxonomy";
import type { Community, CommunityReport, Extractor, KnowledgeGraph, Summarizer, TextUnit } from "./types";

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
