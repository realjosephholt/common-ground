/**
 * Statements: one concrete proposal inside a Conversation.
 *
 * A Statement is the specific ask people vote on. The composer's guidance travels back
 * with the written Statement rather than blocking it, because deciding on an author's
 * behalf that their proposal is not concrete enough is a censorship surface, and the
 * readiness score already judges it honestly and in public.
 */

import { and, asc, eq, inArray } from "drizzle-orm";

import { uuidv7 } from "../db/ids";
import { conversations, statements, STATEMENT_MAX_LENGTH, type ModerationStatus } from "../db/schema";
import { composerGuidance, type Guidance } from "../statements/composer";
import { assertMayParticipate } from "./conversations";
import { requireActor, ServiceError, type ServiceContext } from "./context";

export type StatementView = typeof statements.$inferSelect;

export interface WriteStatementResult {
  statement: StatementView;
  /** What the composer would have said. Returned rather than enforced. */
  guidance: Guidance[];
}

export async function writeStatement(
  ctx: ServiceContext,
  input: { conversationId: string; text: string },
): Promise<WriteStatementResult> {
  const actor = requireActor(ctx);
  const conversation = await assertMayParticipate(ctx, input.conversationId);

  if (conversation.status !== "open") {
    throw new ServiceError("conflict", `This Conversation is ${conversation.status} and takes no new Statements.`);
  }

  const text = input.text.trim();
  if (!text) throw new ServiceError("invalid", "A Statement needs some text.");
  if (text.length > STATEMENT_MAX_LENGTH) {
    throw new ServiceError("invalid", `A Statement is at most ${STATEMENT_MAX_LENGTH} characters.`);
  }

  const now = ctx.now();
  const [created] = await ctx.db
    .insert(statements)
    .values({
      id: uuidv7(now.getTime()),
      conversationId: input.conversationId,
      authorId: actor.id,
      text,
      // Approved on arrival: this is post-moderation, not pre-moderation. Holding every
      // Statement for review would make the operator the gatekeeper of what can be
      // proposed, which is the same surface the Conversation gate exists to avoid.
      // Reports and the Moderation Log are what act on it afterwards.
      moderationStatus: "approved",
      createdAt: now,
    })
    .returning();

  return { statement: created!, guidance: composerGuidance(text) };
}

export async function getStatement(ctx: ServiceContext, statementId: string): Promise<StatementView> {
  const [row] = await ctx.db.select().from(statements).where(eq(statements.id, statementId)).limit(1);
  if (!row) throw new ServiceError("not_found", "No such Statement.");
  return row;
}

export interface ListStatementsInput {
  conversationId: string;
  /** Defaults to what a voter should see. */
  moderationStatuses?: ModerationStatus[];
}

export async function listStatements(ctx: ServiceContext, input: ListStatementsInput): Promise<StatementView[]> {
  const statuses = input.moderationStatuses ?? (["approved"] as ModerationStatus[]);
  return ctx.db
    .select()
    .from(statements)
    .where(and(eq(statements.conversationId, input.conversationId), inArray(statements.moderationStatus, statuses)))
    .orderBy(asc(statements.createdAt));
}

export interface ContributableStatement {
  statementId: string;
  conversationId: string;
}

/**
 * Check that a Statement will accept a contribution — a Vote, a Commitment — from the
 * acting Participant.
 *
 * Three conditions travel together: the Statement exists, the caller clears its
 * Conversation's entry gate, and the Conversation is still open. Votes and Commitments
 * both need all three, and having asked the question in two places is how the two
 * answers drift.
 */
export async function assertStatementAcceptsContributions(
  ctx: ServiceContext,
  statementId: string,
): Promise<ContributableStatement> {
  const [target] = await ctx.db
    .select({
      conversationId: statements.conversationId,
      moderationStatus: statements.moderationStatus,
      status: conversations.status,
    })
    .from(statements)
    .innerJoin(conversations, eq(conversations.id, statements.conversationId))
    .where(eq(statements.id, statementId))
    .limit(1);
  if (!target) throw new ServiceError("not_found", "No such Statement.");

  await assertMayParticipate(ctx, target.conversationId);

  if (target.status !== "open") {
    throw new ServiceError("conflict", `This Conversation is ${target.status} and takes no further contributions.`);
  }
  if (target.moderationStatus !== "approved") {
    throw new ServiceError("conflict", "This Statement has been removed.");
  }

  return { statementId, conversationId: target.conversationId };
}
