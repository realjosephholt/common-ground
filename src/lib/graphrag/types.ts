/** GraphRAG over the organising corpus.
 *
 *  This is not a chatbot bolted onto the side. It exists to answer two questions the
 *  rest of the app cannot answer from its relational tables:
 *
 *    "What has been tried against this target, and what happened?"   -> localSearch
 *    "What causes actually exist across everything people have said?" -> globalSearch
 *
 *  The second is the learned taxonomy. Clustering statement embeddings groups things
 *  that SOUND alike; an entity graph groups things that SHARE ACTORS. "Rezone the 5th
 *  St lot" and "the planning commission keeps deferring us" are not similar sentences
 *  and belong to the same cause, which only the graph can see.
 */

export type EntityType =
  | "person"
  | "official"
  | "org"
  | "place"
  | "policy"
  | "tactic"
  | "resource"
  | "other";

/** A chunk of source text. Everything in the graph traces back to one of these, so any
 *  claim the system makes can be shown to a sceptical human with its receipts. */
export interface TextUnit {
  id: string;
  text: string;
  source: { kind: "statement" | "campaign" | "action" | "outcome" | "note"; id: string };
  /** epoch ms — outcomes are only useful with their date attached */
  at?: number;
}

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  description: string;
  textUnitIds: string[];
  /** number of mentions; used for ranking and for merge arbitration */
  mentions: number;
}

export interface Relationship {
  id: string;
  sourceId: string;
  targetId: string;
  description: string;
  weight: number;
  textUnitIds: string[];
}

export interface KnowledgeGraph {
  entities: Map<string, Entity>;
  relationships: Relationship[];
  textUnits: Map<string, TextUnit>;
}

export interface Community {
  id: string;
  level: number;
  entityIds: string[];
  parentId: string | null;
  /** sum of internal edge weights — how tightly this community actually hangs together */
  internalWeight: number;
}

export interface CommunityReport {
  communityId: string;
  level: number;
  title: string;
  summary: string;
  findings: string[];
  /** ranking signal for global search */
  rank: number;
  entityIds: string[];
  textUnitIds: string[];
}

/** Pluggable so a self-hosted instance works with zero API keys, and an instance that
 *  wants an LLM can have one, without either being the only option. */
export interface ExtractionResult {
  entities: Entity[];
  relationships: Relationship[];
}

export interface Extractor {
  name: string;
  extract(units: readonly TextUnit[]): Promise<ExtractionResult> | ExtractionResult;
}

/** Synchronous variant, so callers of a built-in extractor need not await a value
 *  that was never a promise. */
export interface SyncExtractor extends Extractor {
  extract(units: readonly TextUnit[]): ExtractionResult;
}

export interface Summarizer {
  name: string;
  summarize(
    community: Community,
    graph: KnowledgeGraph,
  ): Promise<CommunityReport> | CommunityReport;
}

/** Search returns CONTEXT, not prose. Answer generation is the caller's business —
 *  keeping that seam means retrieval stays testable without a model in the loop. */
export interface ContextBundle {
  query: string;
  mode: "local" | "global";
  entities: Entity[];
  relationships: Relationship[];
  textUnits: TextUnit[];
  reports: CommunityReport[];
  /** human-readable, ready to drop into a prompt or render in the UI */
  rendered: string;
}
