/**
 * Deciding which Statement to show a voter next.
 *
 * The decision itself lives in `discovery/routing.ts` and is pure; this is the thin
 * layer that assembles candidates out of the database and hands them over. Keeping the
 * split means the routing policy stays drivable by the simulation harness, which is
 * where its failure modes — echo chambers, wasted attention — are actually visible.
 */

import { sql } from "drizzle-orm";

import { queryRows } from "../db/client.js";
import { selectNextStatements, type RoutingCandidate, type RoutingOptions } from "../discovery/routing.js";
import { assertMayParticipate } from "./conversations.js";
import { requireActor, type ServiceContext } from "./context.js";

interface CandidateRow {
  statement_id: string;
  votes: number;
  moderation_status: string;
  created_at: Date;
  seen: boolean;
}

export interface NextStatementsInput {
  conversationId: string;
  limit?: number;
  options?: RoutingOptions;
}

export async function nextStatementsToVote(ctx: ServiceContext, input: NextStatementsInput): Promise<string[]> {
  const actor = requireActor(ctx);
  await assertMayParticipate(ctx, input.conversationId);

  const rows = await queryRows<CandidateRow>(
    ctx.db,
    sql`select s.id as statement_id,
               s.moderation_status,
               s.created_at,
               (select count(*)::int from votes v where v.statement_id = s.id) as votes,
               exists (select 1 from votes v where v.statement_id = s.id and v.participant_id = ${actor.id}) as seen
        from statements s
        where s.conversation_id = ${input.conversationId}`,
  );

  const candidates: RoutingCandidate[] = rows.map((row) => ({
    statementId: row.statement_id,
    votes: Number(row.votes),
    // Persisted scoring output arrives with the milestone that wires the engine to the
    // database; until then routing runs on information gain and freshness alone.
    perGroupAgreement: [],
    // A removed Statement stops being routed immediately. `scoreCandidates` drops
    // anything unapproved, so the gate is the engine's rather than a filter here that
    // the simulation harness would never exercise.
    approved: row.moderation_status === "approved",
    createdAt: new Date(row.created_at).getTime(),
  }));

  const seen = new Set(rows.filter((row) => row.seen).map((row) => row.statement_id));

  return selectNextStatements(
    { seen, userGroup: null, candidates, now: ctx.now().getTime() },
    input.limit ?? 10,
    input.options ?? {},
  );
}

/** Exported so a caller that already has candidates (the simulation harness, a
 *  dashboard preview) can reuse the same shape. */
export type { RoutingCandidate };
