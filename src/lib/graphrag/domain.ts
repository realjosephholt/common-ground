import type { TextUnit } from "./types.js";

/** Turning app records into a corpus. This adapter is where GraphRAG stops being a
 *  generic library and starts being about organising: what we choose to feed it
 *  determines what the graph can ever know. */

export interface StatementRecord {
  id: string;
  text: string;
  createdAt: number;
}

export interface CampaignRecord {
  id: string;
  goal: string;
  theoryOfChange?: string;
  targetName?: string;
  targetRole?: string;
  createdAt: number;
}

export interface ActionRecord {
  id: string;
  campaignId: string;
  tactic: string;
  description?: string;
  scheduledAt: number;
}

export interface OutcomeRecord {
  id: string;
  campaignId: string;
  actionId?: string;
  tactic: string;
  targetName?: string;
  /** did the target concede, partially concede, refuse, or not respond */
  result: "won" | "partial" | "refused" | "no_response";
  attendanceActual?: number;
  attendanceExpected?: number;
  notes?: string;
  recordedAt: number;
}

export function statementUnit(s: StatementRecord): TextUnit {
  return { id: `statement:${s.id}`, text: s.text, source: { kind: "statement", id: s.id }, at: s.createdAt };
}

export function campaignUnits(c: CampaignRecord): TextUnit[] {
  const parts = [c.goal, c.theoryOfChange].filter(Boolean) as string[];
  const target = c.targetName ? ` The target is the ${c.targetRole ?? "decision-maker"} ${c.targetName}.` : "";
  return [
    {
      id: `campaign:${c.id}`,
      text: `${parts.join(" ")}${target}`.trim(),
      source: { kind: "campaign", id: c.id },
      at: c.createdAt,
    },
  ];
}

export function actionUnit(a: ActionRecord): TextUnit {
  return {
    id: `action:${a.id}`,
    text: `A ${a.tactic} was scheduled. ${a.description ?? ""}`.trim(),
    source: { kind: "action", id: a.id },
    at: a.scheduledAt,
  };
}

/**
 * Outcomes are written as prose deliberately.
 *
 * The result, the tactic and the target all need to land in the same text unit,
 * because co-occurrence in one unit is what creates the graph edge. That edge is the
 * entire mechanism behind "this tactic worked on that kind of target" — if these three
 * facts were split across units, the graph would never connect them and the feedback
 * loop would silently do nothing.
 */
export function outcomeUnit(o: OutcomeRecord): TextUnit {
  const verdict: Record<OutcomeRecord["result"], string> = {
    won: "won the demand",
    partial: "won part of the demand",
    refused: "was refused",
    no_response: "received no response",
  };
  const turnout =
    o.attendanceActual !== undefined && o.attendanceExpected !== undefined
      ? ` Turnout was ${o.attendanceActual} against ${o.attendanceExpected} expected.`
      : "";
  const target = o.targetName ? ` against ${o.targetName}` : "";
  return {
    id: `outcome:${o.id}`,
    text: `A ${o.tactic}${target} ${verdict[o.result]}.${turnout} ${o.notes ?? ""}`.trim(),
    source: { kind: "outcome", id: o.id },
    at: o.recordedAt,
  };
}

export function buildCorpus(input: {
  statements?: readonly StatementRecord[];
  campaigns?: readonly CampaignRecord[];
  actions?: readonly ActionRecord[];
  outcomes?: readonly OutcomeRecord[];
}): TextUnit[] {
  return [
    ...(input.statements ?? []).map(statementUnit),
    ...(input.campaigns ?? []).flatMap(campaignUnits),
    ...(input.actions ?? []).map(actionUnit),
    ...(input.outcomes ?? []).map(outcomeUnit),
  ];
}
