import type { Database } from "@/lib/db/client.js";
import { consumeSignInToken, requestSignIn } from "@/lib/services/auth.js";
import {
  createContext,
  type Actor,
  type LinkDelivery,
  type ServiceContext,
  type SignInLink,
} from "@/lib/services/context.js";
import type { ParticipantView } from "@/lib/services/participants.js";

export function capturingDelivery(): { delivery: LinkDelivery; links: SignInLink[] } {
  const links: SignInLink[] = [];
  return { links, delivery: { deliver: (link) => void links.push(link) } };
}

export interface SignedInParticipant {
  participant: ParticipantView;
  actor: Actor;
  sessionToken: string;
  /** A context already acting as this Participant. */
  ctx: ServiceContext;
}

/** Sign a new Participant up the way a person would: request a link, then spend it. */
export async function signUp(
  db: Database,
  input: { email: string; displayName: string; now?: () => Date },
): Promise<SignedInParticipant> {
  const { delivery, links } = capturingDelivery();
  const anonymous = createContext(db, { deliverSignInLink: delivery, ...(input.now ? { now: input.now } : {}) });

  await requestSignIn(anonymous, { email: input.email, displayName: input.displayName });
  const { participant, sessionToken } = await consumeSignInToken(anonymous, { token: links[0]!.token });

  const actor: Actor = { id: participant.id, verificationLevel: participant.verificationLevel };
  const ctx = createContext(db, { actor, deliverSignInLink: delivery, ...(input.now ? { now: input.now } : {}) });
  return { participant, actor, sessionToken, ctx };
}
