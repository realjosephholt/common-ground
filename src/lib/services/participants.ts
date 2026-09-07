/**
 * Participants: who they are, what little we hold about them, and how they stop being
 * one.
 *
 * A Participant is pseudonymous by default and a real name is never requested. The
 * strongest claim in this module is the last function in it: deletion genuinely erases
 * every attribute, and what remains is a tombstone carrying nothing (ADR-0004).
 */

import { and, eq, sql } from "drizzle-orm";

import { uuidv7 } from "../db/ids.js";
import { participants, type VerificationLevel } from "../db/schema.js";
import { encodeGeohash } from "../discovery/geohash.js";
import { requireActor, ServiceError, type ServiceContext } from "./context.js";
import { demoteSubjectsOf } from "./vouches.js";

/** The precision a home location is stored at, and the only precision there is. */
export const LOCATION_GEOHASH_PRECISION = 5;
/** A precision-5 geohash cell is about 4.9km x 4.9km. Surfaced to the Participant
 *  verbatim so they can judge the risk themselves rather than trusting a claim. */
export const LOCATION_CELL_KM = 4.9;

export interface ParticipantView {
  id: string;
  displayName: string;
  email: string;
  verificationLevel: VerificationLevel;
  geohash5: string | null;
  regionId: number | null;
  createdAt: Date;
}

type ParticipantRow = typeof participants.$inferSelect;

export function toParticipantView(row: ParticipantRow): ParticipantView {
  if (row.tombstoned || !row.displayName || !row.email || !row.verificationLevel || !row.createdAt) {
    throw new ServiceError("not_found", "This Participant has been deleted.");
  }
  return {
    id: row.id,
    displayName: row.displayName,
    email: row.email,
    verificationLevel: row.verificationLevel,
    geohash5: row.geohash5,
    regionId: row.regionId,
    createdAt: row.createdAt,
  };
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Find a live Participant by email. Tombstones hold no email, so they are invisible
 *  here — which is exactly why a deleted Participant cannot sign back in. */
export async function findLiveParticipantByEmail(
  ctx: ServiceContext,
  email: string,
): Promise<ParticipantRow | null> {
  const [row] = await ctx.db
    .select()
    .from(participants)
    .where(and(eq(participants.email, normaliseEmail(email)), eq(participants.tombstoned, false)))
    .limit(1);
  return row ?? null;
}

export async function findLiveParticipantById(ctx: ServiceContext, id: string): Promise<ParticipantRow | null> {
  const [row] = await ctx.db
    .select()
    .from(participants)
    .where(and(eq(participants.id, id), eq(participants.tombstoned, false)))
    .limit(1);
  return row ?? null;
}

export interface CreateParticipantInput {
  email: string;
  displayName: string;
  verificationLevel?: VerificationLevel;
}

export async function createParticipant(
  ctx: ServiceContext,
  input: CreateParticipantInput,
): Promise<ParticipantRow> {
  const displayName = input.displayName.trim();
  if (!displayName) throw new ServiceError("invalid", "A display name is required. It need not be your real name.");

  const now = ctx.now();
  const [row] = await ctx.db
    .insert(participants)
    .values({
      id: uuidv7(now.getTime()),
      email: normaliseEmail(input.email),
      displayName,
      verificationLevel: input.verificationLevel ?? "email",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row!;
}

export async function setDisplayName(ctx: ServiceContext, input: { displayName: string }): Promise<ParticipantView> {
  const actor = requireActor(ctx);
  const displayName = input.displayName.trim();
  if (!displayName) throw new ServiceError("invalid", "A display name is required. It need not be your real name.");

  const [row] = await ctx.db
    .update(participants)
    .set({ displayName, updatedAt: ctx.now() })
    .where(and(eq(participants.id, actor.id), eq(participants.tombstoned, false)))
    .returning();
  if (!row) throw new ServiceError("not_found", "No such Participant.");
  return toParticipantView(row);
}

/** What the Instance holds about where someone lives, stated plainly. */
export interface StoredLocation {
  geohash5: string | null;
  regionId: number | null;
  precision: {
    geohashCharacters: number;
    approximateCellKm: number;
    /** Written for a person to read, because "we store a coarse location" is a claim
     *  and this is a description they can check. */
    description: string;
  };
}

function describePrecision(): StoredLocation["precision"] {
  return {
    geohashCharacters: LOCATION_GEOHASH_PRECISION,
    approximateCellKm: LOCATION_CELL_KM,
    description:
      `Your home location is stored as a ${LOCATION_GEOHASH_PRECISION}-character geohash: ` +
      `a grid cell roughly ${LOCATION_CELL_KM}km across. The coordinates you entered are not stored, ` +
      `and cannot be recovered from what is.`,
  };
}

/**
 * Record a coarse home location.
 *
 * The coordinates are truncated to a precision-5 geohash before anything is written,
 * and the precise pair is never persisted. Density scoring works on the geohash, which
 * is why this exists at all; scope comes from the Region and not from here (ADR-0007).
 */
export async function setLocation(
  ctx: ServiceContext,
  input: { latitude: number; longitude: number; regionId?: number | null },
): Promise<StoredLocation> {
  const actor = requireActor(ctx);
  if (!Number.isFinite(input.latitude) || Math.abs(input.latitude) > 90) {
    throw new ServiceError("invalid", "Latitude must be between -90 and 90.");
  }
  if (!Number.isFinite(input.longitude) || Math.abs(input.longitude) > 180) {
    throw new ServiceError("invalid", "Longitude must be between -180 and 180.");
  }

  const geohash5 = encodeGeohash(input.latitude, input.longitude, LOCATION_GEOHASH_PRECISION);
  const [row] = await ctx.db
    .update(participants)
    .set({ geohash5, regionId: input.regionId ?? null, updatedAt: ctx.now() })
    .where(and(eq(participants.id, actor.id), eq(participants.tombstoned, false)))
    .returning();
  if (!row) throw new ServiceError("not_found", "No such Participant.");

  return { geohash5: row.geohash5, regionId: row.regionId, precision: describePrecision() };
}

export async function getStoredLocation(ctx: ServiceContext): Promise<StoredLocation> {
  const actor = requireActor(ctx);
  const row = await findLiveParticipantById(ctx, actor.id);
  if (!row) throw new ServiceError("not_found", "No such Participant.");
  return { geohash5: row.geohash5, regionId: row.regionId, precision: describePrecision() };
}

export async function getParticipant(ctx: ServiceContext, id: string): Promise<ParticipantView> {
  const row = await findLiveParticipantById(ctx, id);
  if (!row) throw new ServiceError("not_found", "No such Participant.");
  return toParticipantView(row);
}

/**
 * Erase a Participant, leaving a tombstone.
 *
 * This will look like an incomplete deletion and it is the deliberate outcome. Fully
 * deleting the row would take every Vote with it, retroactively rewriting consensus
 * other people relied on; in a small Conversation, removing one member of a
 * three-person Opinion Group can shrink it enough to identify the remaining two. So the
 * person is erased and their contributions stay, attached to a row that carries nothing
 * — not a location, not a Verification Level, not even a creation time, because any
 * surviving attribute is a correlation handle (ADR-0004).
 *
 * The database's `participants_tombstone_is_empty` check refuses to store the result
 * unless it is genuinely empty.
 */
export async function deleteParticipant(ctx: ServiceContext): Promise<{ tombstoneId: string }> {
  const actor = requireActor(ctx);

  return ctx.db.transaction(async (tx) => {
    const scoped = { ...ctx, db: tx as unknown as ServiceContext["db"] };
    await onParticipantErased(scoped, actor.id);

    const [row] = await tx
      .update(participants)
      .set({
        originInstance: null,
        email: null,
        displayName: null,
        geohash5: null,
        regionId: null,
        verificationLevel: null,
        createdAt: null,
        updatedAt: null,
        tombstoned: true,
      })
      .where(and(eq(participants.id, actor.id), eq(participants.tombstoned, false)))
      .returning();
    if (!row) throw new ServiceError("not_found", "No such Participant.");

    return { tombstoneId: row.id };
  });
}

/**
 * Everything that must happen in other tables when a Participant is erased.
 *
 * Kept as one function, called from inside the deletion transaction, so that a table
 * added later has exactly one place to declare what happens to it — rather than
 * deletion being retrofitted table by table and one being missed.
 */
async function onParticipantErased(ctx: ServiceContext, participantId: string): Promise<void> {
  // Sessions and unconsumed sign-in links are not shared artefacts, so they go.
  await ctx.db.execute(sql`delete from sessions where participant_id = ${participantId}`);
  await ctx.db.execute(
    sql`delete from magic_link_tokens where email = (select email from participants where id = ${participantId})`,
  );

  // Statements survive with authorship nulled: a Statement four hundred people voted on
  // cannot vanish, but the words stop being attributed (ADR-0006).
  await ctx.db.execute(sql`update statements set author_id = null where author_id = ${participantId}`);

  // A Report is nobody's shared artefact, so there is nothing gained by keeping it
  // pointed at the tombstone.
  await ctx.db.execute(sql`update reports set reporter_id = null where reporter_id = ${participantId}`);
  await ctx.db.execute(sql`update reports set resolved_by = null where resolved_by = ${participantId}`);

  // A departed Participant's attestations stop counting. The edges are stamped rather
  // than removed, so who attested to whom survives; then the direct subjects are
  // reconsidered and nobody further, exactly as a manual revocation would (ADR-0008).
  await ctx.db.execute(
    sql`update vouches set revoked_at = ${ctx.now()} where revoked_at is null and (voucher_id = ${participantId} or subject_id = ${participantId})`,
  );
  await demoteSubjectsOf(ctx, participantId);

  // Votes, Commitments, Conversations and the Moderation Log deliberately keep pointing
  // at the tombstone. That is the whole design (ADR-0004).
}
