import type { Entity, KnowledgeGraph, Relationship, TextUnit } from "./types";

export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function entityKey(name: string, type: string): string {
  return `${type}:${normaliseName(name)}`;
}

/**
 * Merge extraction output into a graph, deduplicating entities by normalised name.
 *
 * Deduplication is the difference between a useful graph and a useless one: without
 * it "City Council", "the city council" and "City Council of Austin" are three nodes,
 * every community fragments, and local search misses two thirds of what it should find.
 */
export function buildGraph(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  textUnits: readonly TextUnit[],
): KnowledgeGraph {
  const merged = new Map<string, Entity>();

  for (const e of entities) {
    const key = entityKey(e.name, e.type);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...e, id: key, textUnitIds: [...new Set(e.textUnitIds)] });
      continue;
    }
    existing.mentions += e.mentions;
    existing.textUnitIds = [...new Set([...existing.textUnitIds, ...e.textUnitIds])];
    // Keep the longest surface form as the display name — "Austin City Council" reads
    // better than "council" and is the one a human will recognise.
    if (e.name.length > existing.name.length) existing.name = e.name;
    if (e.description.length > existing.description.length) existing.description = e.description;
  }

  const relByKey = new Map<string, Relationship>();
  for (const r of relationships) {
    const a = r.sourceId;
    const b = r.targetId;
    if (a === b) continue;
    if (!merged.has(a) || !merged.has(b)) continue;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${lo}--${hi}`;
    const existing = relByKey.get(key);
    if (!existing) {
      relByKey.set(key, { ...r, id: key, sourceId: lo, targetId: hi, textUnitIds: [...new Set(r.textUnitIds)] });
    } else {
      existing.weight += r.weight;
      existing.textUnitIds = [...new Set([...existing.textUnitIds, ...r.textUnitIds])];
    }
  }

  return {
    entities: merged,
    relationships: [...relByKey.values()],
    textUnits: new Map(textUnits.map((t) => [t.id, t])),
  };
}

/**
 * Optional alias resolution: fold a short entity name into a longer one of the same
 * type when the short form is contained in EXACTLY ONE longer name.
 *
 * "city council" and "Austin City Council" are almost certainly the same body, and
 * leaving them split fragments every community that touches either. But the merge is
 * only safe when unambiguous — if a corpus contains both "Austin City Council" and
 * "Dallas City Council", then a bare "city council" genuinely refers to neither in
 * particular, and collapsing it into whichever happened to sort first would invent a
 * connection that does not exist. In that case we leave it alone.
 *
 * Off by default: it is a heuristic about the world, and a caller indexing a
 * multi-region corpus should be able to decline it.
 */
export function resolveAliases(graph: KnowledgeGraph): KnowledgeGraph {
  const byType = new Map<string, Entity[]>();
  for (const e of graph.entities.values()) {
    let arr = byType.get(e.type);
    if (!arr) byType.set(e.type, (arr = []));
    arr.push(e);
  }

  const remap = new Map<string, string>();
  for (const [, group] of byType) {
    for (const short of group) {
      const shortName = normaliseName(short.name);
      const candidates = group.filter((other) => {
        if (other.id === short.id) return false;
        const longName = normaliseName(other.name);
        if (longName.length <= shortName.length) return false;
        return longName === shortName || longName.endsWith(` ${shortName}`) || longName.startsWith(`${shortName} `);
      });
      if (candidates.length === 1) remap.set(short.id, candidates[0]!.id);
    }
  }
  if (remap.size === 0) return graph;

  // A -> B -> C should land everything on C.
  const resolve = (id: string): string => {
    const seen = new Set<string>();
    let cur = id;
    while (remap.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = remap.get(cur)!;
    }
    return cur;
  };

  const entities: Entity[] = [];
  for (const e of graph.entities.values()) {
    const target = resolve(e.id);
    if (target === e.id) entities.push({ ...e });
    else entities.push({ ...e, id: target, name: graph.entities.get(target)!.name });
  }
  const relationships = graph.relationships.map((r) => ({
    ...r,
    sourceId: resolve(r.sourceId),
    targetId: resolve(r.targetId),
  }));

  return buildGraph(entities, relationships, [...graph.textUnits.values()]);
}

export function degreeMap(graph: KnowledgeGraph): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of graph.entities.keys()) out.set(id, 0);
  for (const r of graph.relationships) {
    out.set(r.sourceId, (out.get(r.sourceId) ?? 0) + r.weight);
    out.set(r.targetId, (out.get(r.targetId) ?? 0) + r.weight);
  }
  return out;
}

export function adjacency(graph: KnowledgeGraph): Map<string, Map<string, number>> {
  const adj = new Map<string, Map<string, number>>();
  for (const id of graph.entities.keys()) adj.set(id, new Map());
  for (const r of graph.relationships) {
    adj.get(r.sourceId)?.set(r.targetId, r.weight);
    adj.get(r.targetId)?.set(r.sourceId, r.weight);
  }
  return adj;
}
