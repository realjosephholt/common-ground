/**
 * Conversations: a bounded space to deliberate in.
 *
 * Scope is a named administrative Region rather than a geohash prefix, because a
 * Target's jurisdiction follows administrative boundaries and a cell straddling two
 * counties names nobody who can grant anything (ADR-0007).
 *
 * Opening one is gated on Verification Level rather than on moderator approval. That is
 * a deliberate choice about where the censorship surface sits: requiring approval would
 * make the operator the gatekeeper of what can be discussed, which relocates the problem
 * instead of removing it. A gate on distinctness bounds flooding without anyone deciding
 * which causes are allowed.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { queryRows } from "../db/client.js";
import { uuidv7 } from "../db/ids.js";
import { conversations, regions, type ConversationStatus, type VerificationLevel } from "../db/schema.js";
import { meetsVerificationLevel, requireActor, ServiceError, type ServiceContext } from "./context.js";
import { getInstanceSettings } from "./instance.js";

/** Below this, a Participant may take part but may not open a Conversation. */
export const MIN_LEVEL_TO_OPEN_CONVERSATION: VerificationLevel = "vouched";

export const SEED_TOPIC_MAX_LENGTH = 200;

export type ConversationView = typeof conversations.$inferSelect;

/**
 * Which moves are legal.
 *
 * `open -> archived` is here and is not a mistake: a Conversation that attracted no
 * Votes in fourteen days is archived automatically without ever being closed, because
 * closing is a statement about a deliberation that happened and nothing happened here.
 */
const LEGAL_TRANSITIONS: Record<ConversationStatus, ConversationStatus[]> = {
  open: ["closed", "archived"],
  closed: ["archived"],
  archived: [],
};

async function loadConversation(ctx: ServiceContext, conversationId: string): Promise<ConversationView> {
  const [row] = await ctx.db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (!row) throw new ServiceError("not_found", "No such Conversation.");
  return row;
}

export async function getConversation(ctx: ServiceContext, conversationId: string): Promise<ConversationView> {
  return loadConversation(ctx, conversationId);
}

export interface OpenConversationInput {
  regionId: number;
  seedTopic: string;
  /** Raises the entry gate above the Instance default. Never lowers it below what the
   *  opener themselves cleared, so nobody can open a room they could not enter. */
  minVerificationLevel?: VerificationLevel;
}

export async function openConversation(
  ctx: ServiceContext,
  input: OpenConversationInput,
): Promise<ConversationView> {
  const actor = requireActor(ctx);

  if (!meetsVerificationLevel(actor.verificationLevel, MIN_LEVEL_TO_OPEN_CONVERSATION)) {
    throw new ServiceError(
      "forbidden",
      `Opening a Conversation needs a Verification Level of ${MIN_LEVEL_TO_OPEN_CONVERSATION} or better.`,
    );
  }

  const seedTopic = input.seedTopic.trim();
  if (!seedTopic) throw new ServiceError("invalid", "A Conversation needs a seed topic.");
  if (seedTopic.length > SEED_TOPIC_MAX_LENGTH) {
    throw new ServiceError("invalid", `A seed topic is at most ${SEED_TOPIC_MAX_LENGTH} characters.`);
  }

  const [region] = await ctx.db
    .select({ geonameId: regions.geonameId })
    .from(regions)
    .where(eq(regions.geonameId, input.regionId))
    .limit(1);
  if (!region) throw new ServiceError("not_found", "No such Region. Search for one by name first.");

  const settings = await getInstanceSettings(ctx);
  const minVerificationLevel = input.minVerificationLevel ?? settings.defaultMinVerificationLevel;
  if (!meetsVerificationLevel(actor.verificationLevel, minVerificationLevel)) {
    throw new ServiceError("forbidden", "You cannot gate a Conversation above your own Verification Level.");
  }

  await assertUnderRateLimit(ctx, actor.id);

  const now = ctx.now();
  const [created] = await ctx.db
    .insert(conversations)
    .values({
      id: uuidv7(now.getTime()),
      regionId: input.regionId,
      seedTopic,
      createdBy: actor.id,
      status: "open",
      minVerificationLevel,
      createdAt: now,
    })
    .returning();
  return created!;
}

/**
 * Flooding is the thing a Verification Level gate does not stop on its own: one vouched
 * account can still open a hundred Conversations and bury everyone else's. The limit is
 * per Participant over a rolling window and is configurable, because what counts as
 * flooding depends on how big the Instance is.
 */
async function assertUnderRateLimit(ctx: ServiceContext, participantId: string): Promise<void> {
  const settings = await getInstanceSettings(ctx);
  const since = new Date(ctx.now().getTime() - settings.conversationRateLimitWindowHours * 3_600_000);

  const [row] = await queryRows<{ count: number }>(
    ctx.db,
    sql`select count(*)::int as count from conversations
        where created_by = ${participantId} and created_at > ${since}`,
  );
  if (Number(row?.count ?? 0) >= settings.conversationRateLimit) {
    throw new ServiceError(
      "rate_limited",
      `You have opened ${settings.conversationRateLimit} Conversations in the last ` +
        `${settings.conversationRateLimitWindowHours} hours. Try again later.`,
    );
  }
}

/** The opener, or anyone the operator made `verified`. Moving someone else's
 *  Conversation through its lifecycle is a moderation act, so it takes the level the
 *  operator confers rather than the one the vouching graph does. */
async function assertMayMove(ctx: ServiceContext, conversation: ConversationView): Promise<void> {
  const actor = requireActor(ctx);
  if (conversation.createdBy === actor.id) return;
  if (meetsVerificationLevel(actor.verificationLevel, "verified")) return;
  throw new ServiceError("forbidden", "Only the Participant who opened this Conversation can move it.");
}

async function transition(
  ctx: ServiceContext,
  conversationId: string,
  to: ConversationStatus,
): Promise<ConversationView> {
  const conversation = await loadConversation(ctx, conversationId);
  await assertMayMove(ctx, conversation);

  if (!LEGAL_TRANSITIONS[conversation.status].includes(to)) {
    throw new ServiceError("conflict", `A ${conversation.status} Conversation cannot become ${to}.`);
  }

  const now = ctx.now();
  const [updated] = await ctx.db
    .update(conversations)
    .set({
      status: to,
      ...(to === "closed" ? { closedAt: now } : {}),
      ...(to === "archived" ? { archivedAt: now } : {}),
    })
    .where(and(eq(conversations.id, conversationId), eq(conversations.status, conversation.status)))
    .returning();
  if (!updated) throw new ServiceError("conflict", "This Conversation moved underneath you. Try again.");
  return updated;
}

/** Stops accepting Votes while leaving the Conversation scorable, so a readiness score
 *  keeps a defensible point of reference instead of being computed across years of
 *  non-contemporaneous voting. */
export async function closeConversation(
  ctx: ServiceContext,
  input: { conversationId: string },
): Promise<ConversationView> {
  return transition(ctx, input.conversationId, "closed");
}

/** Removes it from discovery while retaining it for the graph, so Outcomes stay
 *  traceable to where they began. */
export async function archiveConversation(
  ctx: ServiceContext,
  input: { conversationId: string },
): Promise<ConversationView> {
  return transition(ctx, input.conversationId, "archived");
}

export async function setMinVerificationLevel(
  ctx: ServiceContext,
  input: { conversationId: string; minVerificationLevel: VerificationLevel },
): Promise<ConversationView> {
  const actor = requireActor(ctx);
  if (!meetsVerificationLevel(actor.verificationLevel, "verified")) {
    throw new ServiceError("forbidden", "Only an operator-designated Participant can set the entry gate.");
  }

  const [updated] = await ctx.db
    .update(conversations)
    .set({ minVerificationLevel: input.minVerificationLevel })
    .where(eq(conversations.id, input.conversationId))
    .returning();
  if (!updated) throw new ServiceError("not_found", "No such Conversation.");
  return updated;
}

export interface ListConversationsInput {
  regionId?: number;
  /** Defaults to the two states discovery should surface. */
  statuses?: ConversationStatus[];
  limit?: number;
}

export async function listConversations(
  ctx: ServiceContext,
  input: ListConversationsInput,
): Promise<ConversationView[]> {
  const statuses = input.statuses ?? (["open", "closed"] as ConversationStatus[]);
  const filters = [inArray(conversations.status, statuses)];
  if (input.regionId !== undefined) filters.push(eq(conversations.regionId, input.regionId));

  return ctx.db
    .select()
    .from(conversations)
    .where(and(...filters))
    .orderBy(desc(conversations.createdAt))
    .limit(Math.min(input.limit ?? 50, 200));
}

/**
 * The entry gate, and the only place a Verification Level is ever consulted for a
 * decision (ADR-0003). Everything that writes into a Conversation goes through here.
 */
export async function assertMayParticipate(
  ctx: ServiceContext,
  conversationId: string,
): Promise<ConversationView> {
  const actor = requireActor(ctx);
  const conversation = await loadConversation(ctx, conversationId);

  if (!meetsVerificationLevel(actor.verificationLevel, conversation.minVerificationLevel)) {
    throw new ServiceError(
      "forbidden",
      `This Conversation is open to Participants at ${conversation.minVerificationLevel} or better.`,
    );
  }
  return conversation;
}
