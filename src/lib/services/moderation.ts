/**
 * Reports, the Moderation Log, and Redaction — the safety surface, auditable by
 * construction.
 *
 * The log is public because the failure mode that matters is not a moderator making a
 * bad call, it is a Cause being suppressed quietly. A moderation record that only
 * moderators can read cannot tell anyone that happened. So every action lands in an
 * append-only log that anyone can read without an account, and this module exposes no
 * path that could amend it — the migration's trigger refuses UPDATE and DELETE outright,
 * because append-only has to be structural rather than promised.
 */

import { and, desc, eq, sql } from "drizzle-orm";

import { uuidv7 } from "../db/ids.js";
import {
  moderationLog,
  reports,
  statements,
  type ModerationAction,
  type ModerationSubjectType,
  type ReportStatus,
} from "../db/schema.js";
import { meetsVerificationLevel, requireActor, ServiceError, type ServiceContext } from "./context.js";

export type ReportView = typeof reports.$inferSelect;
export type ModerationLogEntry = typeof moderationLog.$inferSelect;

export const REPORT_REASON_MAX_LENGTH = 1000;

/**
 * A Moderator is a Participant the operator designated `verified`.
 *
 * Deliberately not a separate role table. Moderation authority on an Instance comes
 * from whoever runs it, and inventing a second grant mechanism would mean two places to
 * audit when asking who could have removed something.
 */
function requireModerator(ctx: ServiceContext) {
  const actor = requireActor(ctx);
  if (!meetsVerificationLevel(actor.verificationLevel, "verified")) {
    throw new ServiceError("forbidden", "Only a Moderator can do that.");
  }
  return actor;
}

/** The only way anything is ever written to the log. */
async function appendToLog(
  ctx: ServiceContext,
  entry: {
    actorId: string | null;
    action: ModerationAction;
    subjectType: ModerationSubjectType;
    subjectId: string;
    reason?: string | null;
  },
): Promise<ModerationLogEntry> {
  const now = ctx.now();
  const [written] = await ctx.db
    .insert(moderationLog)
    .values({
      id: uuidv7(now.getTime()),
      actorId: entry.actorId,
      action: entry.action,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
      reason: entry.reason ?? null,
      createdAt: now,
    })
    .returning();
  return written!;
}

export async function reportStatement(
  ctx: ServiceContext,
  input: { statementId: string; reason: string },
): Promise<ReportView> {
  const actor = requireActor(ctx);

  const reason = input.reason.trim();
  if (!reason) throw new ServiceError("invalid", "A Report needs a reason, so the queue says what is wrong.");
  if (reason.length > REPORT_REASON_MAX_LENGTH) {
    throw new ServiceError("invalid", `A reason is at most ${REPORT_REASON_MAX_LENGTH} characters.`);
  }

  const [statement] = await ctx.db
    .select({ id: statements.id })
    .from(statements)
    .where(eq(statements.id, input.statementId))
    .limit(1);
  if (!statement) throw new ServiceError("not_found", "No such Statement.");

  const now = ctx.now();
  const [created] = await ctx.db
    .insert(reports)
    .values({
      id: uuidv7(now.getTime()),
      statementId: input.statementId,
      reporterId: actor.id,
      reason,
      status: "open",
      createdAt: now,
    })
    .returning();
  return created!;
}

export async function listOpenReports(ctx: ServiceContext): Promise<ReportView[]> {
  requireModerator(ctx);
  return ctx.db.select().from(reports).where(eq(reports.status, "open")).orderBy(reports.createdAt);
}

export interface ResolveReportInput {
  reportId: string;
  /** `dismissed` leaves the Statement alone; `resolved` accompanies a removal. */
  outcome: Extract<ReportStatus, "resolved" | "dismissed">;
  reason: string;
}

/** Closing a Report is itself a moderation action, so that "nothing happened" is a
 *  recorded decision rather than an absence somebody has to notice. */
export async function resolveReport(ctx: ServiceContext, input: ResolveReportInput): Promise<ReportView> {
  const actor = requireModerator(ctx);
  const now = ctx.now();

  const [updated] = await ctx.db
    .update(reports)
    .set({ status: input.outcome, resolvedAt: now, resolvedBy: actor.id })
    .where(and(eq(reports.id, input.reportId), eq(reports.status, "open")))
    .returning();
  if (!updated) throw new ServiceError("not_found", "No open Report with that identifier.");

  await appendToLog(ctx, {
    actorId: actor.id,
    action: input.outcome === "dismissed" ? "report_dismissed" : "report_resolved",
    subjectType: "report",
    subjectId: input.reportId,
    reason: input.reason,
  });
  return updated;
}

/** Takes a Statement out of routing immediately. The Votes already cast on it stay
 *  where they are; removal is about what voters are shown next, not about rewriting
 *  what people already said. */
export async function removeStatement(
  ctx: ServiceContext,
  input: { statementId: string; reason: string },
): Promise<void> {
  const actor = requireModerator(ctx);

  const [updated] = await ctx.db
    .update(statements)
    .set({ moderationStatus: "removed" })
    .where(eq(statements.id, input.statementId))
    .returning();
  if (!updated) throw new ServiceError("not_found", "No such Statement.");

  await appendToLog(ctx, {
    actorId: actor.id,
    action: "statement_removed",
    subjectType: "statement",
    subjectId: input.statementId,
    reason: input.reason,
  });
}

/**
 * Put back a Statement a Moderator removed.
 *
 * The removal is not unwritten. It stays in the Moderation Log and the restoration is
 * appended beside it, so the record reads as a mistake that was corrected rather than as
 * though nothing happened — a log in which an error can be made to disappear is worth
 * less than one that shows the correction.
 *
 * This says nothing about Redaction. A redacted Statement stays redacted through a
 * restoration: Redaction is an author withdrawing their own words (ADR-0006), and
 * restoring is only ever a decision about whether voters see the Statement.
 */
export async function restoreStatement(
  ctx: ServiceContext,
  input: { statementId: string; reason: string },
): Promise<void> {
  const actor = requireModerator(ctx);

  const [statement] = await ctx.db
    .select({ moderationStatus: statements.moderationStatus })
    .from(statements)
    .where(eq(statements.id, input.statementId))
    .limit(1);
  if (!statement) throw new ServiceError("not_found", "No such Statement.");
  if (statement.moderationStatus !== "removed") {
    throw new ServiceError("conflict", "This Statement has not been removed, so there is nothing to restore.");
  }

  await ctx.db
    .update(statements)
    .set({ moderationStatus: "approved" })
    .where(and(eq(statements.id, input.statementId), eq(statements.moderationStatus, "removed")));

  await appendToLog(ctx, {
    actorId: actor.id,
    action: "statement_restored",
    subjectType: "statement",
    subjectId: input.statementId,
    reason: input.reason,
  });
}

/**
 * Remove a Statement's text, leaving the Statement and its Votes intact.
 *
 * This is deliberately not the same answer as ADR-0004 gives for Votes, because it is
 * not the same claim: a Vote is a data point, a Statement is a person's words, and the
 * case for erasing your own speech is stronger. Against that, a Statement four hundred
 * people voted on cannot simply vanish — those Votes would become votes on nothing while
 * still shaping the opinion map and every Bridge score derived from it. Redaction
 * resolves the tension: the record keeps its shape, the Votes keep their referent, the
 * text goes.
 *
 * A redacted Statement still participates in scoring, which is intended. The Votes were
 * real.
 *
 * Available to a Moderator as well as the author, and logged either way — logging is
 * precisely what stops it becoming a quiet moderation channel that bypasses the log.
 */
export async function redactStatement(
  ctx: ServiceContext,
  input: { statementId: string; reason?: string },
): Promise<void> {
  const actor = requireActor(ctx);

  const [statement] = await ctx.db
    .select({ authorId: statements.authorId })
    .from(statements)
    .where(eq(statements.id, input.statementId))
    .limit(1);
  if (!statement) throw new ServiceError("not_found", "No such Statement.");

  const isAuthor = statement.authorId === actor.id;
  const isModerator = meetsVerificationLevel(actor.verificationLevel, "verified");
  if (!isAuthor && !isModerator) {
    throw new ServiceError("forbidden", "Only the author or a Moderator can redact a Statement.");
  }

  await ctx.db
    .update(statements)
    .set({ text: null, redactedAt: ctx.now() })
    .where(eq(statements.id, input.statementId));

  await appendToLog(ctx, {
    actorId: actor.id,
    action: "statement_redacted",
    subjectType: "statement",
    subjectId: input.statementId,
    reason: input.reason ?? (isAuthor ? "Requested by the author." : null),
  });
}

export interface ReadModerationLogInput {
  limit?: number;
  /** Entries strictly older than this, for paging back through the record. */
  before?: Date;
}

/** Public. No actor required, and none consulted. */
export async function readModerationLog(
  ctx: ServiceContext,
  input: ReadModerationLogInput,
): Promise<ModerationLogEntry[]> {
  const filters = input.before ? [sql`${moderationLog.createdAt} < ${input.before}`] : [];
  return ctx.db
    .select()
    .from(moderationLog)
    .where(and(...filters))
    .orderBy(desc(moderationLog.createdAt))
    .limit(Math.min(input.limit ?? 100, 500));
}
