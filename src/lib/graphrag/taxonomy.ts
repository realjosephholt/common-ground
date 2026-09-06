import type { Community, CommunityReport, KnowledgeGraph } from "./types.js";

/**
 * The learned taxonomy: emergent issue clusters, derived from graph communities
 * rather than imposed up front.
 *
 * A curated issue tree is a permanent political bottleneck — whoever writes the
 * categories decides what is thinkable, and the categories are always out of date in
 * exactly the places where new organising is happening. Deriving them from the entity
 * graph means the taxonomy grows out of what people actually said, and it can be
 * renamed by humans without being reimposed by them.
 */
export interface IssueCluster {
  id: string;
  level: number;
  /** structural title; a human-set label always wins over this */
  suggestedLabel: string;
  label: string | null;
  entityIds: string[];
  statementIds: string[];
  campaignIds: string[];
  outcomeIds: string[];
  rank: number;
}

export function buildTaxonomy(
  graph: KnowledgeGraph,
  communities: readonly Community[],
  reports: readonly CommunityReport[],
  opts: { level?: number; humanLabels?: ReadonlyMap<string, string> } = {},
): IssueCluster[] {
  const level = opts.level ?? 0;
  const labels = opts.humanLabels ?? new Map<string, string>();
  const reportById = new Map(reports.map((r) => [r.communityId, r]));

  const out: IssueCluster[] = [];
  for (const c of communities) {
    if (c.level !== level) continue;
    const report = reportById.get(c.id);
    const unitIds = new Set(
      c.entityIds.flatMap((id) => graph.entities.get(id)?.textUnitIds ?? []),
    );

    const statementIds: string[] = [];
    const campaignIds: string[] = [];
    const outcomeIds: string[] = [];
    for (const uid of unitIds) {
      const unit = graph.textUnits.get(uid);
      if (!unit) continue;
      if (unit.source.kind === "statement") statementIds.push(unit.source.id);
      else if (unit.source.kind === "campaign") campaignIds.push(unit.source.id);
      else if (unit.source.kind === "outcome") outcomeIds.push(unit.source.id);
    }

    out.push({
      id: c.id,
      level: c.level,
      suggestedLabel: report?.title ?? c.id,
      label: labels.get(c.id) ?? null,
      entityIds: c.entityIds,
      statementIds,
      campaignIds,
      outcomeIds,
      rank: report?.rank ?? c.internalWeight,
    });
  }

  out.sort((a, b) => b.rank - a.rank);
  return out;
}

/**
 * Tactic effectiveness against a given kind of target, read straight off the graph.
 *
 * This is M5's feedback loop: when an organiser is choosing a tactic, the honest thing
 * to show them is what has actually happened when people tried it here before.
 */
export interface TacticEvidence {
  tactic: string;
  won: number;
  partial: number;
  refused: number;
  noResponse: number;
  total: number;
  /** (won + 0.5·partial) / total, or null when there is not enough history to say */
  successRate: number | null;
  outcomeIds: string[];
}

export function tacticEvidence(
  graph: KnowledgeGraph,
  opts: { targetName?: string; minSample?: number } = {},
): TacticEvidence[] {
  const minSample = opts.minSample ?? 3;
  const targetToken = opts.targetName?.toLowerCase();

  const byTactic = new Map<string, TacticEvidence>();

  for (const unit of graph.textUnits.values()) {
    if (unit.source.kind !== "outcome") continue;
    const lower = unit.text.toLowerCase();
    if (targetToken && !lower.includes(targetToken)) continue;

    for (const entity of graph.entities.values()) {
      if (entity.type !== "tactic") continue;
      if (!entity.textUnitIds.includes(unit.id)) continue;

      let rec = byTactic.get(entity.name);
      if (!rec) {
        rec = { tactic: entity.name, won: 0, partial: 0, refused: 0, noResponse: 0, total: 0, successRate: null, outcomeIds: [] };
        byTactic.set(entity.name, rec);
      }
      if (lower.includes("won part of the demand")) rec.partial++;
      else if (lower.includes("won the demand")) rec.won++;
      else if (lower.includes("was refused")) rec.refused++;
      else if (lower.includes("received no response")) rec.noResponse++;
      else continue;
      rec.total++;
      rec.outcomeIds.push(unit.source.id);
    }
  }

  const out = [...byTactic.values()];
  for (const rec of out) {
    // Refuse to report a rate off two data points. A confident-looking "100% success"
    // from a single win would push organisers toward whatever was tried first, which is
    // worse than telling them we do not know yet.
    rec.successRate = rec.total >= minSample ? (rec.won + 0.5 * rec.partial) / rec.total : null;
  }
  out.sort((a, b) => (b.successRate ?? -1) - (a.successRate ?? -1) || b.total - a.total);
  return out;
}
