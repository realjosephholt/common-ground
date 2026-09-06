import { adjacency, degreeMap, normaliseName } from "./graph.js";
import type { CommunityReport, ContextBundle, Entity, KnowledgeGraph, Relationship, TextUnit } from "./types.js";

function tokenise(s: string): string[] {
  return normaliseName(s).split(" ").filter((t) => t.length > 2);
}

function overlapScore(query: readonly string[], text: string): number {
  if (query.length === 0) return 0;
  const hay = normaliseName(text);
  let hits = 0;
  for (const t of query) if (hay.includes(t)) hits++;
  return hits / query.length;
}

export interface LocalSearchOptions {
  /** how far to walk out from the seed entities */
  hops?: number;
  maxEntities?: number;
  maxTextUnits?: number;
}

/**
 * Local search: start from entities the query names, walk the graph, return their
 * neighbourhood with the source texts attached.
 *
 * This is the query that closes the app's feedback loop. "What has been tried against
 * the planning commission?" reaches the commission node, walks to the tactics and
 * campaigns connected to it, and returns the outcome texts — which is precisely the
 * evidence that should be on screen when someone is choosing a tactic, and which no
 * amount of vector similarity over statements would assemble.
 */
export function localSearch(
  query: string,
  graph: KnowledgeGraph,
  reports: readonly CommunityReport[] = [],
  opts: LocalSearchOptions = {},
): ContextBundle {
  const hops = opts.hops ?? 2;
  const maxEntities = opts.maxEntities ?? 25;
  const maxTextUnits = opts.maxTextUnits ?? 20;
  const tokens = tokenise(query);
  const degrees = degreeMap(graph);

  const seeds = [...graph.entities.values()]
    .map((e) => ({ e, score: Math.max(overlapScore(tokens, e.name), overlapScore(tokens, e.description) * 0.5) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (degrees.get(b.e.id) ?? 0) - (degrees.get(a.e.id) ?? 0))
    .slice(0, 5)
    .map((x) => x.e);

  const adj = adjacency(graph);
  const distance = new Map<string, number>();
  for (const s of seeds) distance.set(s.id, 0);
  let frontier = seeds.map((s) => s.id);

  for (let h = 1; h <= hops; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id)?.keys() ?? []) {
        if (!distance.has(nb)) {
          distance.set(nb, h);
          next.push(nb);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const entities: Entity[] = [...distance.keys()]
    .map((id) => graph.entities.get(id))
    .filter((e): e is Entity => Boolean(e))
    .sort((a, b) => {
      const da = distance.get(a.id)!;
      const db = distance.get(b.id)!;
      // Closer to the query first, then better-connected.
      return da - db || (degrees.get(b.id) ?? 0) - (degrees.get(a.id) ?? 0);
    })
    .slice(0, maxEntities);

  const kept = new Set(entities.map((e) => e.id));
  const relationships: Relationship[] = graph.relationships
    .filter((r) => kept.has(r.sourceId) && kept.has(r.targetId))
    .sort((a, b) => b.weight - a.weight);

  const unitIds = new Set<string>();
  for (const e of entities) for (const id of e.textUnitIds) unitIds.add(id);
  const textUnits: TextUnit[] = [...unitIds]
    .map((id) => graph.textUnits.get(id))
    .filter((t): t is TextUnit => Boolean(t))
    .sort((a, b) => overlapScore(tokens, b.text) - overlapScore(tokens, a.text) || (b.at ?? 0) - (a.at ?? 0))
    .slice(0, maxTextUnits);

  const relevantReports = reports
    .filter((r) => r.entityIds.some((id) => kept.has(id)))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 3);

  return {
    query,
    mode: "local",
    entities,
    relationships,
    textUnits,
    reports: relevantReports,
    rendered: render("local", query, entities, relationships, textUnits, relevantReports),
  };
}

export interface GlobalSearchOptions {
  /** which hierarchy level to read; higher is coarser */
  level?: number;
  maxReports?: number;
  maxTextUnits?: number;
}

/**
 * Global search: map-reduce over community reports rather than over raw documents.
 *
 * "What are people actually organising around?" cannot be answered by retrieving the
 * top-k most similar statements — the answer is a property of the whole corpus, not of
 * any passage in it. Scoring pre-computed community summaries is what makes that
 * question answerable at all, and it is the same mechanism that produces the app's
 * learned taxonomy.
 */
export function globalSearch(
  query: string,
  graph: KnowledgeGraph,
  reports: readonly CommunityReport[],
  opts: GlobalSearchOptions = {},
): ContextBundle {
  const maxReports = opts.maxReports ?? 5;
  const maxTextUnits = opts.maxTextUnits ?? 15;
  const tokens = tokenise(query);

  const pool = opts.level === undefined ? reports : reports.filter((r) => r.level === opts.level);

  const maxRank = Math.max(1, ...pool.map((r) => r.rank));
  const scored = pool
    .map((r) => {
      const textual = Math.max(
        overlapScore(tokens, r.title),
        overlapScore(tokens, r.summary),
        overlapScore(tokens, r.findings.join(" ")),
      );
      // Blend query relevance with community importance so a broad query ("what is
      // happening?") still returns the substantial causes rather than nothing.
      return { r, score: textual * 0.7 + (r.rank / maxRank) * 0.3 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxReports)
    .map((x) => x.r);

  const entityIds = new Set(scored.flatMap((r) => r.entityIds));
  const entities = [...entityIds].map((id) => graph.entities.get(id)).filter((e): e is Entity => Boolean(e));
  const unitIds = new Set(scored.flatMap((r) => r.textUnitIds));
  const textUnits = [...unitIds]
    .map((id) => graph.textUnits.get(id))
    .filter((t): t is TextUnit => Boolean(t))
    .slice(0, maxTextUnits);

  return {
    query,
    mode: "global",
    entities,
    relationships: [],
    textUnits,
    reports: scored,
    rendered: render("global", query, entities, [], textUnits, scored),
  };
}

function render(
  mode: string,
  query: string,
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  textUnits: readonly TextUnit[],
  reports: readonly CommunityReport[],
): string {
  const lines: string[] = [`# ${mode} context for: ${query}`];
  if (reports.length) {
    lines.push("", "## Communities");
    for (const r of reports) lines.push(`- **${r.title}** — ${r.summary}`);
  }
  if (entities.length) {
    lines.push("", "## Entities");
    for (const e of entities.slice(0, 20)) lines.push(`- ${e.name} (${e.type}) — ${e.description}`);
  }
  if (relationships.length) {
    lines.push("", "## Relationships");
    for (const r of relationships.slice(0, 20)) lines.push(`- ${r.sourceId} — ${r.targetId} (${r.weight})`);
  }
  if (textUnits.length) {
    lines.push("", "## Sources");
    for (const t of textUnits) lines.push(`- [${t.source.kind}:${t.source.id}] ${t.text}`);
  }
  return lines.join("\n");
}
