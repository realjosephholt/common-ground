/**
 * Everything the Instance holds about one Participant, in a form they can read.
 *
 * Leaving has to be a real option rather than a stated one, and an export is what makes
 * the difference checkable: a person can see exactly what is held, decide whether the
 * deletion policy is acceptable to them, and take their contributions with them.
 *
 * The export deliberately states what deletion would and would not remove. ADR-0004 is
 * narrower than "hard delete" as ordinarily understood, and someone deciding whether to
 * leave should learn that here rather than afterwards.
 */

import { eq, or, sql } from "drizzle-orm";

import { queryRows } from "../db/client.js";
import {
  commitments,
  conversations,
  magicLinkTokens,
  moderationLog,
  reports,
  sessions,
  statements,
  votes,
  vouches,
} from "../db/schema.js";
import { requireActor, ServiceError, type ServiceContext } from "./context.js";
import { findLiveParticipantById, toParticipantView, type ParticipantView } from "./participants.js";

export interface SessionSummary {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface SignInLinkSummary {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface ParticipantExport {
  exportedAt: string;
  participant: ParticipantView;
  vouchesGiven: (typeof vouches.$inferSelect)[];
  vouchesReceived: (typeof vouches.$inferSelect)[];
  conversationsOpened: (typeof conversations.$inferSelect)[];
  statements: (typeof statements.$inferSelect)[];
  votes: (typeof votes.$inferSelect)[];
  commitments: (typeof commitments.$inferSelect)[];
  reportsFiled: (typeof reports.$inferSelect)[];
  moderationActions: (typeof moderationLog.$inferSelect)[];
  /** Token hashes are omitted: they are credentials, and handing someone a file that
   *  can sign them in is a worse trade than a slightly less complete export. */
  sessions: SessionSummary[];
  outstandingSignInLinks: SignInLinkSummary[];
  /** What deleting this account would actually do, stated plainly rather than promised. */
  whatDeletionWouldDo: string[];
}

const DELETION_NOTES = [
  "Every attribute above — your email address, display name, coarse location, Region and " +
    "Verification Level — is erased. What remains is a tombstone carrying no attributes at all.",
  "Your Votes and Commitments survive, attached to that tombstone. Removing them would " +
    "retroactively change results other people relied on, and in a small Conversation could " +
    "shrink an Opinion Group enough to identify whoever is left in it.",
  "Statements you wrote survive with your authorship removed. If you want the words gone as " +
    "well, request Redaction before deleting: that clears the text and is recorded in the " +
    "public Moderation Log.",
  "Conversations you opened survive, and moderation actions you took stay in the public " +
    "Moderation Log, because a log that can be emptied is not a log.",
  "Vouches you gave are revoked, which may demote the people you vouched for. It does not " +
    "cascade any further than them.",
  "Your sessions and any unused sign-in links are deleted outright.",
];

export async function exportMyData(ctx: ServiceContext): Promise<ParticipantExport> {
  const actor = requireActor(ctx);
  const row = await findLiveParticipantById(ctx, actor.id);
  if (!row) throw new ServiceError("not_found", "No such Participant.");

  const [
    vouchesGiven,
    vouchesReceived,
    conversationsOpened,
    authored,
    cast,
    pledged,
    filed,
    moderationActions,
    openSessions,
    signInLinks,
  ] = await Promise.all([
    ctx.db.select().from(vouches).where(eq(vouches.voucherId, actor.id)),
    ctx.db.select().from(vouches).where(eq(vouches.subjectId, actor.id)),
    ctx.db.select().from(conversations).where(eq(conversations.createdBy, actor.id)),
    ctx.db.select().from(statements).where(eq(statements.authorId, actor.id)),
    ctx.db.select().from(votes).where(eq(votes.participantId, actor.id)),
    ctx.db.select().from(commitments).where(eq(commitments.participantId, actor.id)),
    ctx.db.select().from(reports).where(or(eq(reports.reporterId, actor.id), eq(reports.resolvedBy, actor.id))),
    ctx.db.select().from(moderationLog).where(eq(moderationLog.actorId, actor.id)),
    ctx.db
      .select({
        id: sessions.id,
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
      })
      .from(sessions)
      .where(eq(sessions.participantId, actor.id)),
    ctx.db
      .select({
        id: magicLinkTokens.id,
        createdAt: magicLinkTokens.createdAt,
        expiresAt: magicLinkTokens.expiresAt,
        consumedAt: magicLinkTokens.consumedAt,
      })
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.email, row.email!)),
  ]);

  return {
    exportedAt: ctx.now().toISOString(),
    participant: toParticipantView(row),
    vouchesGiven,
    vouchesReceived,
    conversationsOpened,
    statements: authored,
    votes: cast,
    commitments: pledged,
    reportsFiled: filed,
    moderationActions,
    sessions: openSessions,
    outstandingSignInLinks: signInLinks,
    whatDeletionWouldDo: DELETION_NOTES,
  };
}

export interface ParticipantReference {
  table: string;
  column: string;
}

/**
 * Every foreign key in the database that points at a Participant.
 *
 * Read from the live catalogue rather than from a list someone maintains, so that a
 * table added later cannot quietly acquire a reference nobody decided the deletion
 * policy for. The sweep test is what turns that into a failure.
 */
export async function participantReferences(ctx: ServiceContext): Promise<ParticipantReference[]> {
  const rows = await queryRows<{ table_name: string; column_name: string }>(
    ctx.db,
    sql`select tc.table_name, kcu.column_name
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
        join information_schema.constraint_column_usage ccu
          on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
        where tc.constraint_type = 'FOREIGN KEY'
          and tc.table_schema = 'public'
          and ccu.table_name = 'participants'
        order by tc.table_name, kcu.column_name`,
  );
  return rows.map((row) => ({ table: row.table_name, column: row.column_name }));
}
