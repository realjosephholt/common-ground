/**
 * Voting, and the automatic archival of Conversations nobody voted in.
 *
 * A Vote is agree, disagree or pass. Pass is not a non-answer: it lets someone register
 * reservation without being forced into a binary, and it is counted distinctly from an
 * unseen Statement, because "saw it and abstained" and "never saw it" are different
 * facts that the scoring treats differently.
 */

import { and, eq, sql } from "drizzle-orm";

import { queryRows } from "../db/client.js";
import { conversations, votes } from "../db/schema.js";
import type { VoteValue } from "../discovery/types.js";
import { LEGAL_TRANSITIONS } from "./conversations.js";
import { assertStatementAcceptsContributions } from "./statements.js";
import { requireActor, type ServiceContext } from "./context.js";
import { getInstanceSettings } from "./instance.js";

export type VoteView = typeof votes.$inferSelect;

export interface VoteTally {
  agree: number;
  disagree: number;
  pass: number;
}

/**
 * Cast or change a Vote.
 *
 * Changing your mind is an upsert onto the composite primary key, so a second Vote
 * replaces the first rather than accumulating. That rule is the database's rather than
 * this function's: it holds for anything that ever writes to the table.
 */
export async function castVote(
  ctx: ServiceContext,
  input: { statementId: string; value: VoteValue },
): Promise<VoteView> {
  const actor = requireActor(ctx);

  await assertStatementAcceptsContributions(ctx, input.statementId);

  const now = ctx.now();
  const [cast] = await ctx.db
    .insert(votes)
    .values({ participantId: actor.id, statementId: input.statementId, value: input.value, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [votes.participantId, votes.statementId],
      set: { value: input.value, updatedAt: now },
    })
    .returning();
  return cast!;
}

export async function getMyVote(ctx: ServiceContext, input: { statementId: string }): Promise<VoteView | null> {
  const actor = requireActor(ctx);
  const [row] = await ctx.db
    .select()
    .from(votes)
    .where(and(eq(votes.participantId, actor.id), eq(votes.statementId, input.statementId)))
    .limit(1);
  return row ?? null;
}

export async function tallyVotes(ctx: ServiceContext, input: { statementId: string }): Promise<VoteTally> {
  const [row] = await queryRows<{ agree: number; disagree: number; pass: number }>(
    ctx.db,
    sql`select
          count(*) filter (where value = 1)::int  as agree,
          count(*) filter (where value = -1)::int as disagree,
          count(*) filter (where value = 0)::int  as pass
        from votes where statement_id = ${input.statementId}`,
  );
  return {
    agree: Number(row?.agree ?? 0),
    disagree: Number(row?.disagree ?? 0),
    pass: Number(row?.pass ?? 0),
  };
}

export type ArchivedConversation = typeof conversations.$inferSelect;

/**
 * Archive Conversations that attracted no Votes at all within the window.
 *
 * A system action rather than a Participant's: it takes no actor and checks none,
 * because it runs on a schedule. Abandoned Conversations leaving discovery on their own
 * is the point — the alternative is a moderation chore, and a moderation chore that
 * involves deciding which Conversations are dead is a discretion nobody should have to
 * exercise.
 *
 * It goes straight from `open` to `archived` without passing through `closed`, because
 * closing is a statement about a deliberation that happened and nothing happened here.
 */
export async function archiveSilentConversations(ctx: ServiceContext): Promise<ArchivedConversation[]> {
  const settings = await getInstanceSettings(ctx);
  const now = ctx.now();
  const cutoff = new Date(now.getTime() - settings.archiveSilentConversationsAfterDays * 86_400_000);

  // Asserted rather than assumed: the lifecycle table in `conversations.ts` stays the
  // single statement of which moves are legal, so a change there cannot leave this
  // sweep quietly making an illegal one.
  if (!LEGAL_TRANSITIONS.open.includes("archived")) {
    throw new Error("open -> archived is no longer a legal transition; the silent-Conversation sweep needs revisiting.");
  }

  return ctx.db
    .update(conversations)
    .set({ status: "archived", archivedAt: now })
    .where(
      and(
        eq(conversations.status, "open"),
        sql`${conversations.createdAt} < ${cutoff}`,
        sql`not exists (
          select 1 from votes v
          join statements s on s.id = v.statement_id
          where s.conversation_id = ${conversations.id}
        )`,
      ),
    )
    .returning();
}
