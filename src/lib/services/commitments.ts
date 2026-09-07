/**
 * Commitment: what a Participant will actually contribute.
 *
 * Deliberately distinct from a Vote, because agreement is free and commitment is the
 * scarce thing that decides whether an action can happen at all. Twenty people who will
 * turn up can run a rally; two hundred who merely approve cannot.
 *
 * A Commitment confers membership of nothing (ADR-0005). It is a signal against a
 * Statement, and this module exposes counts and levels but no roster — because the
 * moment something downstream can read a list of committed people as enrolment,
 * pledging "I would show up" starts meaning "put my name on a list", which is a very
 * different thing to ask of someone organising against a Target.
 */

import { and, eq } from "drizzle-orm";

import { commitments } from "../db/schema.js";
import { COMMITMENT_WEIGHTS } from "../discovery/commitment.js";
import type { CommitmentLevel, CommitmentRecord } from "../discovery/types.js";
import { assertStatementAcceptsContributions } from "./statements.js";
import { requireActor, type ServiceContext } from "./context.js";

export type CommitmentView = typeof commitments.$inferSelect;

/** Registering the same level twice is a no-op rather than an error: a double tap on a
 *  button is not a thing to make someone read an error message about. */
export async function commitTo(
  ctx: ServiceContext,
  input: { statementId: string; level: CommitmentLevel },
): Promise<CommitmentView> {
  const actor = requireActor(ctx);
  await assertStatementAcceptsContributions(ctx, input.statementId);

  const now = ctx.now();
  const [created] = await ctx.db
    .insert(commitments)
    .values({ participantId: actor.id, statementId: input.statementId, level: input.level, createdAt: now })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [existing] = await ctx.db
    .select()
    .from(commitments)
    .where(
      and(
        eq(commitments.participantId, actor.id),
        eq(commitments.statementId, input.statementId),
        eq(commitments.level, input.level),
      ),
    )
    .limit(1);
  return existing!;
}

export async function withdrawCommitment(
  ctx: ServiceContext,
  input: { statementId: string; level: CommitmentLevel },
): Promise<void> {
  const actor = requireActor(ctx);
  await ctx.db
    .delete(commitments)
    .where(
      and(
        eq(commitments.participantId, actor.id),
        eq(commitments.statementId, input.statementId),
        eq(commitments.level, input.level),
      ),
    );
}

export async function listMyCommitments(
  ctx: ServiceContext,
  input: { statementId: string },
): Promise<CommitmentView[]> {
  const actor = requireActor(ctx);
  return ctx.db
    .select()
    .from(commitments)
    .where(and(eq(commitments.participantId, actor.id), eq(commitments.statementId, input.statementId)));
}

/**
 * The raw records for a Statement, in the shape the engine consumes.
 *
 * Handed over unreduced on purpose: `commitmentScore` already keeps only each person's
 * strongest pledge, and having the rule live in exactly one place is what stops the
 * service and the engine drifting into two different answers.
 */
export async function countedCommitments(
  ctx: ServiceContext,
  input: { statementId: string },
): Promise<CommitmentRecord[]> {
  const rows = await ctx.db
    .select({ participantId: commitments.participantId, level: commitments.level })
    .from(commitments)
    .where(eq(commitments.statementId, input.statementId));

  return rows.map((row) => ({ userId: row.participantId, statementId: input.statementId, level: row.level }));
}

export interface StrongestCommitment {
  participantId: string;
  level: CommitmentLevel;
}

/** What each person's pledge is worth, one entry per person. For display: organisers
 *  need to know they have four people who will organise, not that four rows exist. */
export async function strongestCommitmentPerParticipant(
  ctx: ServiceContext,
  input: { statementId: string },
): Promise<StrongestCommitment[]> {
  const strongest = new Map<string, CommitmentLevel>();
  for (const record of await countedCommitments(ctx, input)) {
    const held = strongest.get(record.userId);
    if (!held || COMMITMENT_WEIGHTS[record.level] > COMMITMENT_WEIGHTS[held]) {
      strongest.set(record.userId, record.level);
    }
  }
  return [...strongest].map(([participantId, level]) => ({ participantId, level }));
}
