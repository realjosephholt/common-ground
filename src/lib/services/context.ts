/**
 * The application service layer's one shared shape.
 *
 * Every service is `(ctx, input) => result`. `ctx` carries the database handle and the
 * acting Participant; route handlers and server actions authenticate and delegate, and
 * contain no rules. This is the milestone's single new seam, and it is where the tests
 * live: most of the invariants here exist *between* tables, so testing individual
 * queries would verify SQL rather than rules.
 */

import type { Database } from "../db/client.js";
import { VERIFICATION_LEVELS, type VerificationLevel } from "../db/schema.js";

/** Who is calling. Never inferred inside a service — always supplied by the caller
 *  that did the authenticating. */
export interface Actor {
  id: string;
  verificationLevel: VerificationLevel;
}

/** A sign-in link, handed to whatever actually delivers it. */
export interface SignInLink {
  email: string;
  token: string;
  expiresAt: Date;
}

/** Delivery is an interface so that the notification system — which is out of scope for
 *  this milestone — can be dropped in without the auth service learning anything about
 *  transports. */
export interface LinkDelivery {
  deliver(link: SignInLink): Promise<void> | void;
}

/** The default. Writes the link to stdout, which is what a self-hosting operator sees
 *  during first setup and what a contributor sees while developing. */
export const stdoutLinkDelivery: LinkDelivery = {
  deliver(link) {
    process.stdout.write(`[common-ground] sign-in link for ${link.email}: ${link.token}\n`);
  },
};

export interface ServiceContext {
  db: Database;
  /** Null for an unauthenticated call. */
  actor: Actor | null;
  /** Injected so that expiry, rate limits and automatic archival are testable without
   *  waiting fourteen days. */
  now: () => Date;
  deliverSignInLink: LinkDelivery;
}

export interface ServiceContextOptions {
  actor?: Actor | null;
  now?: () => Date;
  deliverSignInLink?: LinkDelivery;
}

export function createContext(db: Database, options: ServiceContextOptions = {}): ServiceContext {
  return {
    db,
    actor: options.actor ?? null,
    now: options.now ?? (() => new Date()),
    deliverSignInLink: options.deliverSignInLink ?? stdoutLinkDelivery,
  };
}

export type ServiceErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "conflict"
  | "rate_limited";

/** Services fail by throwing this and nothing else, so a caller can map a code onto a
 *  status without pattern-matching on message text. */
export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export function requireActor(ctx: ServiceContext): Actor {
  if (!ctx.actor) throw new ServiceError("unauthenticated", "This action requires a signed-in Participant.");
  return ctx.actor;
}

/** Weakest to strongest. The only ordering of Verification Levels in the codebase, and
 *  it exists to answer one question — is this Participant past the gate — and never to
 *  weight anything (ADR-0003). */
export function verificationRank(level: VerificationLevel): number {
  return VERIFICATION_LEVELS.indexOf(level);
}

export function meetsVerificationLevel(actual: VerificationLevel, required: VerificationLevel): boolean {
  return verificationRank(actual) >= verificationRank(required);
}
