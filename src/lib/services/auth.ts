/**
 * Magic-link sign-in and sessions.
 *
 * No passwords: a password is a thing to lose, reuse, and be phished for, and an
 * Instance holding political-association data should hold as few secrets about people
 * as it can. Neither the sign-in token nor the session token is stored — only their
 * hashes — so a database leak does not hand an attacker a set of working sign-in links.
 */

import { and, eq, gt, isNull } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";

import { uuidv7 } from "../db/ids.js";
import { magicLinkTokens, participants, sessions } from "../db/schema.js";
import type { Actor, ServiceContext } from "./context.js";
import { ServiceError } from "./context.js";
import {
  createParticipant,
  findLiveParticipantByEmail,
  normaliseEmail,
  toParticipantView,
  type ParticipantView,
} from "./participants.js";

/** Short enough that an intercepted email is usually already useless. */
export const SIGN_IN_LINK_TTL_MINUTES = 15;
export const SESSION_TTL_DAYS = 30;

function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface RequestSignInInput {
  email: string;
  /** Required only when the email belongs to nobody yet. Held on the token rather than
   *  on a participant row, so an unconsumed link creates no account. */
  displayName?: string;
}

export async function requestSignIn(ctx: ServiceContext, input: RequestSignInInput): Promise<{ expiresAt: Date }> {
  const email = normaliseEmail(input.email);
  if (!email.includes("@")) throw new ServiceError("invalid", "That does not look like an email address.");

  const existing = await findLiveParticipantByEmail(ctx, email);
  const displayName = input.displayName?.trim();
  if (!existing && !displayName) {
    throw new ServiceError("invalid", "A display name is required to join. It need not be your real name.");
  }

  const now = ctx.now();
  const token = mintToken();
  const expiresAt = new Date(now.getTime() + SIGN_IN_LINK_TTL_MINUTES * 60_000);

  await ctx.db.insert(magicLinkTokens).values({
    id: uuidv7(now.getTime()),
    email,
    displayName: displayName ?? null,
    tokenHash: hashToken(token),
    createdAt: now,
    expiresAt,
  });

  await ctx.deliverSignInLink.deliver({ email, token, expiresAt });
  return { expiresAt };
}

export interface EstablishedSession {
  sessionToken: string;
  expiresAt: Date;
  participant: ParticipantView;
}

/**
 * Spend a sign-in link.
 *
 * The consumption is a conditional UPDATE rather than a read followed by a write, so
 * two simultaneous uses of the same link cannot both succeed — single-use is decided by
 * the database, not by how quickly the second request arrives.
 */
export async function consumeSignInToken(ctx: ServiceContext, input: { token: string }): Promise<EstablishedSession> {
  const now = ctx.now();
  const rejected = new ServiceError("invalid", "That sign-in link is expired or has already been used.");

  const [claimed] = await ctx.db
    .update(magicLinkTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(magicLinkTokens.tokenHash, hashToken(input.token)),
        isNull(magicLinkTokens.consumedAt),
        gt(magicLinkTokens.expiresAt, now),
      ),
    )
    .returning();
  if (!claimed) throw rejected;

  const existing = await findLiveParticipantByEmail(ctx, claimed.email);
  const participant =
    existing ??
    (await createParticipant(ctx, {
      email: claimed.email,
      // A link minted for an address that had no account always carries a display name;
      // `requestSignIn` refuses to issue one otherwise.
      displayName: claimed.displayName ?? "",
    }));

  const session = await openSession(ctx, participant.id);
  return { ...session, participant: toParticipantView(participant) };
}

async function openSession(ctx: ServiceContext, participantId: string): Promise<{ sessionToken: string; expiresAt: Date }> {
  const now = ctx.now();
  const sessionToken = mintToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 86_400_000);

  await ctx.db.insert(sessions).values({
    id: uuidv7(now.getTime()),
    participantId,
    tokenHash: hashToken(sessionToken),
    createdAt: now,
    expiresAt,
  });
  return { sessionToken, expiresAt };
}

/**
 * Turn a session token into an Actor, or nothing.
 *
 * A tombstoned Participant fails here: their sessions are deleted on erasure, and the
 * join to a live Participant would fail even if one survived.
 */
export async function resolveActor(ctx: ServiceContext, sessionToken: string | null | undefined): Promise<Actor | null> {
  if (!sessionToken) return null;
  const now = ctx.now();

  const [row] = await ctx.db
    .select({ id: participants.id, verificationLevel: participants.verificationLevel })
    .from(sessions)
    .innerJoin(participants, eq(participants.id, sessions.participantId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(sessionToken)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        eq(participants.tombstoned, false),
      ),
    )
    .limit(1);

  if (!row?.verificationLevel) return null;
  return { id: row.id, verificationLevel: row.verificationLevel };
}

export async function endSession(ctx: ServiceContext, input: { sessionToken: string }): Promise<void> {
  await ctx.db
    .update(sessions)
    .set({ revokedAt: ctx.now() })
    .where(and(eq(sessions.tokenHash, hashToken(input.sessionToken)), isNull(sessions.revokedAt)));
}
