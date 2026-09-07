import { degreeMap } from "./graph";
import type { Community, CommunityReport, KnowledgeGraph, Summarizer } from "./types";

/**
 * Deterministic community summariser.
 *
 * Produces a structured report from graph structure alone — no model, no network.
 * The output is deliberately plain: it states which entities anchor the community and
 * which connections are strongest, and stops. An LLM summariser plugs in via the same
 * `Summarizer` interface and will read better, but a summary that quietly editorialises
 * about a political cause is a real hazard, so the honest structural version is what
 * ships by default.
 */
export const structuralSummarizer: Summarizer = {
  name: "structural",
  summarize(community: Community, graph: KnowledgeGraph): CommunityReport {
    const degrees = degreeMap(graph);
    const members = community.entityIds
      .map((id) => graph.entities.get(id))
      .filter((e): e is NonNullable<typeof e> => Boolean(e))
      .sort((a, b) => (degrees.get(b.id) ?? 0) - (degrees.get(a.id) ?? 0) || b.mentions - a.mentions);

    const top = members.slice(0, 3);
    const title = top.length > 0 ? top.map((e) => e.name).join(" · ") : `Community ${community.id}`;

    const memberIds = new Set(community.entityIds);
    const internal = graph.relationships
      .filter((r) => memberIds.has(r.sourceId) && memberIds.has(r.targetId))
      .sort((a, b) => b.weight - a.weight);

    const textUnitIds = [...new Set(members.flatMap((e) => e.textUnitIds))];

    const byType = new Map<string, string[]>();
    for (const e of members) {
      let arr = byType.get(e.type);
      if (!arr) byType.set(e.type, (arr = []));
      arr.push(e.name);
    }

    const findings: string[] = [];
    for (const [type, names] of byType) {
      findings.push(`${type}: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` (+${names.length - 6} more)` : ""}`);
    }
    for (const r of internal.slice(0, 5)) {
      const a = graph.entities.get(r.sourceId)?.name ?? r.sourceId;
      const b = graph.entities.get(r.targetId)?.name ?? r.targetId;
      findings.push(`${a} — ${b} (co-occurs ${r.weight}×)`);
    }

    const summary =
      members.length === 0
        ? "Empty community."
        : `${members.length} connected ${members.length === 1 ? "entity" : "entities"} spanning ${textUnitIds.length} source ${textUnitIds.length === 1 ? "text" : "texts"}, anchored on ${top.map((e) => e.name).join(", ")}.`;

    // Rank drives global-search ordering: big, tightly-connected, well-evidenced
    // communities are more likely to be a real cause than a two-node coincidence.
    const rank = community.internalWeight * Math.log2(1 + members.length) * Math.log2(1 + textUnitIds.length);

    return {
      communityId: community.id,
      level: community.level,
      title,
      summary,
      findings,
      rank,
      entityIds: members.map((e) => e.id),
      textUnitIds,
    };
  },
};

export async function summarizeAll(
  communities: readonly Community[],
  graph: KnowledgeGraph,
  summarizer: Summarizer = structuralSummarizer,
): Promise<CommunityReport[]> {
  const out: CommunityReport[] = [];
  for (const c of communities) out.push(await summarizer.summarize(c, graph));
  out.sort((a, b) => b.rank - a.rank);
  return out;
}
