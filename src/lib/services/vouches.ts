/**
 * Vouching: the anti-Sybil machinery, as a gate and never as a weight.
 *
 * Sybil resistance is the central unsolved threat here — if accounts are free, "shared
 * support" means nothing. The obvious defence is to weight Votes by how well verified
 * someone is, and we are deliberately not doing that (ADR-0003): weighting rows changes
 * the principal components, which changes *which Opinion Groups exist at all*, which
 * silently moves every readiness score in the system. A gate is also more honest. "You
 * must be vouched to take part here" is legible and contestable; "your vote counted 0.4"
 * is neither.
 */

import { and, eq, isNull, sql } from "drizzle-orm";

import { queryRows } from "../db/client";
import { uuidv7 } from "../db/ids";
import { participants, vouches, type VerificationLevel } from "../db/schema";
import { requireActor, ServiceError, type ServiceContext } from "./context";

/** Bounds how much a single compromised account can manufacture. Five is what makes
 *  the non-cascading revocation in ADR-0008 affordable: the blast radius is capped
 *  without needing a cascade to clean up after it.
 *
 *  Enforced here *and* by a trigger in migration 0002. The check below exists to give a
 *  useful message; the trigger exists because this one cannot be trusted on its own —
 *  two concurrent requests both read four outstanding Vouches and both insert. An
 *  attacker racing the cap is exactly the case it has to survive, so the two must stay
 *  in step, and `tests/service/vouches.test.ts` drives the trigger from this constant. */
export const MAX_OUTSTANDING_VOUCHES = 5;

/** Two, so that no single account is a gateway. */
export const VOUCHES_REQUIRED_FOR_PROMOTION = 2;

/** The levels whose attestation counts towards promoting someone. */
const COUNTING_LEVELS: VerificationLevel[] = ["vouched", "verified"];

export interface VouchView {
  id: string;
  voucherId: string;
  subjectId: string;
  createdAt: Date;
  revokedAt: Date | null;
}

/**
 * How many *counting* Vouches a Participant holds.
 *
 * An attestation from someone below `vouched` is recorded but does not count, and a
 * tombstone's attestations count for nothing at all.
 */
async function countingVouchesFor(ctx: ServiceContext, subjectId: string): Promise<number> {
  const [row] = await queryRows<{ count: number }>(
    ctx.db,
    sql`select count(*)::int as count
        from vouches v
        join participants p on p.id = v.voucher_id
        where v.subject_id = ${subjectId}
          and v.revoked_at is null
          and p.tombstoned = false
          and p.verification_level in ('vouched', 'verified')`,
  );
  return Number(row?.count ?? 0);
}

async function levelOf(ctx: ServiceContext, participantId: string): Promise<VerificationLevel | null> {
  const [row] = await ctx.db
    .select({ level: participants.verificationLevel, tombstoned: participants.tombstoned })
    .from(participants)
    .where(eq(participants.id, participantId))
    .limit(1);
  if (!row || row.tombstoned) return null;
  return row.level;
}

async function setLevel(ctx: ServiceContext, participantId: string, level: VerificationLevel): Promise<void> {
  await ctx.db
    .update(participants)
    .set({ verificationLevel: level, updatedAt: ctx.now() })
    .where(and(eq(participants.id, participantId), eq(participants.tombstoned, false)));
}

/**
 * Promote a Participant if they now have enough support, and then reconsider everyone
 * *they* have vouched for.
 *
 * The recursion is here because a Vouch given before its author was promoted should not
 * be worth less than one given afterwards — otherwise whether an attestation counts
 * depends on the order events happened to arrive in, which nobody could reason about.
 * It terminates because a Participant is only ever promoted once, and `seen` makes that
 * explicit rather than merely true.
 *
 * Note the asymmetry with `demoteIfUnsupported`, which does *not* recurse. That is
 * ADR-0008 and it is not an oversight: gaining support may propagate, losing it must
 * not, because propagating demotion is a silencing tool.
 */
async function promoteIfEligible(ctx: ServiceContext, subjectId: string, seen = new Set<string>()): Promise<void> {
  if (seen.has(subjectId)) return;
  seen.add(subjectId);

  const level = await levelOf(ctx, subjectId);
  if (level === null || COUNTING_LEVELS.includes(level)) return;
  if ((await countingVouchesFor(ctx, subjectId)) < VOUCHES_REQUIRED_FOR_PROMOTION) return;

  await setLevel(ctx, subjectId, "vouched");

  const downstream = await ctx.db
    .select({ subjectId: vouches.subjectId })
    .from(vouches)
    .where(and(eq(vouches.voucherId, subjectId), isNull(vouches.revokedAt)));
  for (const row of downstream) await promoteIfEligible(ctx, row.subjectId, seen);
}

/**
 * Demote a Participant who no longer has the support that promoted them — and nobody
 * else.
 *
 * `verified` is never touched: it is conferred by the operator to root the graph, and a
 * revocation must not be able to unmake it.
 */
export async function demoteIfUnsupported(ctx: ServiceContext, subjectId: string): Promise<void> {
  if ((await levelOf(ctx, subjectId)) !== "vouched") return;
  if ((await countingVouchesFor(ctx, subjectId)) >= VOUCHES_REQUIRED_FOR_PROMOTION) return;
  await setLevel(ctx, subjectId, "email");
}

/** Reconsider everyone a Participant had vouched for. Called after their attestations
 *  stop counting — a revocation, or their account being erased. Direct subjects only. */
export async function demoteSubjectsOf(ctx: ServiceContext, voucherId: string): Promise<void> {
  const subjects = await ctx.db
    .select({ subjectId: vouches.subjectId })
    .from(vouches)
    .where(eq(vouches.voucherId, voucherId));
  for (const row of subjects) await demoteIfUnsupported(ctx, row.subjectId);
}

/**
 * Assert that another Participant is a distinct real person.
 *
 * Anyone signed in may vouch. Whether it *counts* is a separate question answered by
 * the voucher's own Verification Level, which is why an attestation from an unpromoted
 * account is still worth recording: it becomes countable the moment they are promoted.
 */
export async function vouchFor(ctx: ServiceContext, input: { subjectId: string }): Promise<VouchView> {
  const actor = requireActor(ctx);
  if (actor.id === input.subjectId) {
    throw new ServiceError("invalid", "You cannot vouch for yourself.");
  }
  if ((await levelOf(ctx, input.subjectId)) === null) {
    throw new ServiceError("not_found", "No such Participant.");
  }

  const outstanding = await ctx.db
    .select({ id: vouches.id })
    .from(vouches)
    .where(and(eq(vouches.voucherId, actor.id), isNull(vouches.revokedAt)));
  if (outstanding.length >= MAX_OUTSTANDING_VOUCHES) {
    throw new ServiceError(
      "forbidden",
      `You may hold ${MAX_OUTSTANDING_VOUCHES} outstanding Vouches. Revoke one to vouch for someone else.`,
    );
  }

  const now = ctx.now();
  const [created] = await ctx.db
    .insert(vouches)
    .values({ id: uuidv7(now.getTime()), voucherId: actor.id, subjectId: input.subjectId, createdAt: now })
    // The live-pair unique index is partial, so a previously revoked Vouch for the same
    // person is re-vouchable; an outstanding one is not.
    .onConflictDoNothing()
    .returning();
  if (!created) throw new ServiceError("conflict", "You already have an outstanding Vouch for this Participant.");

  await promoteIfEligible(ctx, input.subjectId);
  return created;
}

/**
 * Withdraw an attestation.
 *
 * The row is kept and stamped rather than deleted, so the history of who attested to
 * whom survives the revocation — which is the record moderation needs when a ring of
 * colluding accounts is caught.
 */
export async function revokeVouch(ctx: ServiceContext, input: { subjectId: string }): Promise<VouchView> {
  const actor = requireActor(ctx);

  const [revoked] = await ctx.db
    .update(vouches)
    .set({ revokedAt: ctx.now() })
    .where(and(eq(vouches.voucherId, actor.id), eq(vouches.subjectId, input.subjectId), isNull(vouches.revokedAt)))
    .returning();
  if (!revoked) throw new ServiceError("not_found", "You have no outstanding Vouch for this Participant.");

  await demoteIfUnsupported(ctx, input.subjectId);
  return revoked;
}

export async function listVouchesGiven(ctx: ServiceContext): Promise<VouchView[]> {
  const actor = requireActor(ctx);
  return ctx.db.select().from(vouches).where(eq(vouches.voucherId, actor.id));
}

export async function listVouchesReceived(ctx: ServiceContext, subjectId: string): Promise<VouchView[]> {
  return ctx.db.select().from(vouches).where(eq(vouches.subjectId, subjectId));
}
