/**
 * Instance-level settings and the operator actions that seed an Instance.
 *
 * These are the only services with no acting Participant. They are run from scripts by
 * whoever controls the deployment, not over HTTP, which is why they take no actor and
 * check none — an Instance's operator is established by having shell access to it, and
 * pretending otherwise would just be a second, weaker gate.
 */

import { and, eq, sql } from "drizzle-orm";

import { uuidv7 } from "../db/ids";
import { instanceSettings, participants, type VerificationLevel } from "../db/schema";
import { ServiceError, type ServiceContext } from "./context";
import { normaliseEmail, toParticipantView, type ParticipantView } from "./participants";

export type InstanceSettings = typeof instanceSettings.$inferSelect;

/**
 * The Instance's settings, created with the schema's defaults on first read.
 *
 * Lazily creating them keeps every other service from having to care whether an
 * operator has been through setup yet. The defaults are the ones declared on the table,
 * so what an unconfigured Instance does is visible in the schema rather than here.
 */
export async function getInstanceSettings(ctx: ServiceContext): Promise<InstanceSettings> {
  const [existing] = await ctx.db.select().from(instanceSettings).limit(1);
  if (existing) return existing;

  const now = ctx.now();
  const [created] = await ctx.db
    .insert(instanceSettings)
    .values({ id: uuidv7(now.getTime()), name: "Common Ground", createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  // Lost the race with a concurrent first read; the winner's row is the one that counts.
  const [row] = await ctx.db.select().from(instanceSettings).limit(1);
  return row!;
}

export interface ConfigureInstanceInput {
  name?: string;
  defaultMinVerificationLevel?: VerificationLevel;
  archiveSilentConversationsAfterDays?: number;
  conversationRateLimit?: number;
  conversationRateLimitWindowHours?: number;
}

export async function configureInstance(
  ctx: ServiceContext,
  input: ConfigureInstanceInput,
): Promise<InstanceSettings> {
  const current = await getInstanceSettings(ctx);
  const [updated] = await ctx.db
    .update(instanceSettings)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.defaultMinVerificationLevel !== undefined
        ? { defaultMinVerificationLevel: input.defaultMinVerificationLevel }
        : {}),
      ...(input.archiveSilentConversationsAfterDays !== undefined
        ? { archiveSilentConversationsAfterDays: input.archiveSilentConversationsAfterDays }
        : {}),
      ...(input.conversationRateLimit !== undefined ? { conversationRateLimit: input.conversationRateLimit } : {}),
      ...(input.conversationRateLimitWindowHours !== undefined
        ? { conversationRateLimitWindowHours: input.conversationRateLimitWindowHours }
        : {}),
      updatedAt: ctx.now(),
    })
    .where(eq(instanceSettings.id, current.id))
    .returning();
  return updated!;
}

/**
 * Designate a Participant as `verified`.
 *
 * Without at least one of these the vouching graph has no root: nobody is
 * `vouched`-or-better, so nobody can promote anyone, and the Instance is unusable. This
 * is the operator's way in, and it is deliberately the *only* way a Participant reaches
 * `verified` — vouching tops out at `vouched`.
 */
export async function designateVerified(ctx: ServiceContext, input: { email: string }): Promise<ParticipantView> {
  const [row] = await ctx.db
    .update(participants)
    .set({ verificationLevel: "verified", updatedAt: ctx.now() })
    .where(and(eq(participants.email, normaliseEmail(input.email)), eq(participants.tombstoned, false)))
    .returning();
  if (!row) throw new ServiceError("not_found", `No Participant signed in with ${input.email} yet.`);
  return toParticipantView(row);
}

export async function listVerifiedParticipants(ctx: ServiceContext): Promise<ParticipantView[]> {
  const rows = await ctx.db
    .select()
    .from(participants)
    .where(and(eq(participants.verificationLevel, "verified"), eq(participants.tombstoned, false)))
    .orderBy(sql`created_at`);
  return rows.map(toParticipantView);
}
