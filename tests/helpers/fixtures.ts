import type { Database } from "@/lib/db/client.js";
import { consumeSignInToken, requestSignIn } from "@/lib/services/auth.js";
import {
  createContext,
  type Actor,
  type LinkDelivery,
  type ServiceContext,
  type SignInLink,
} from "@/lib/services/context.js";
import { designateVerified } from "@/lib/services/instance.js";
import type { ParticipantView } from "@/lib/services/participants.js";
import { parseRegionExtract } from "@/lib/regions/extract.js";
import { seedRegions } from "@/lib/services/regions.js";
import { vouchFor } from "@/lib/services/vouches.js";

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

/**
 * A five-Region fixture rather than the 51,710-row vendored extract: seeding the whole
 * world into every test would make the suite slow enough that people stop running it,
 * and the two Springfields prove the parent-chain disambiguation more legibly than a
 * real pair would.
 */
export const REGION_FIXTURE = [
  "geoname_id\tname\tascii_name\tcountry_code\tlevel\tadmin1_code\tadmin2_code",
  "6252001\tUnited States\tUnited States\tUS\tcountry\t\t",
  // A real pair whose relevance order and geonameId order disagree: searching "United
  // States" must not put the Minor Outlying Islands first just because 5854968 < 6252001.
  "5854968\tUnited States Minor Outlying Islands\tUnited States Minor Outlying Islands\tUM\tcountry\t\t",
  "4896861\tIllinois\tIllinois\tUS\tadmin1\tIL\t",
  "4398678\tMissouri\tMissouri\tUS\tadmin1\tMO\t",
  "4250542\tSpringfield\tSpringfield\tUS\tadmin2\tIL\t167",
  "4409896\tSpringfield\tSpringfield\tUS\tadmin2\tMO\t077",
].join("\n");

export const FIXTURE_REGIONS = {
  unitedStates: 6252001,
  minorOutlyingIslands: 5854968,
  illinois: 4896861,
  missouri: 4398678,
  springfieldIllinois: 4250542,
  springfieldMissouri: 4409896,
} as const;

export async function seedRegionFixture(db: Database): Promise<typeof FIXTURE_REGIONS> {
  await seedRegions(createContext(db), { rows: parseRegionExtract(REGION_FIXTURE), version: "fixture-1" });
  return FIXTURE_REGIONS;
}

/** Someone the operator rooted the vouching graph with. Their context is refreshed so
 *  it carries the level they were just given. */
export async function signUpVerified(
  db: Database,
  input: { email: string; displayName: string },
): Promise<SignedInParticipant> {
  const person = await signUp(db, input);
  const view = await designateVerified(person.ctx, { email: person.participant.email });
  person.actor.verificationLevel = view.verificationLevel;
  return person;
}

/**
 * Someone who got in the ordinary way: two `verified` Participants vouched for them.
 * Takes the two vouchers so a caller can reuse a graph root across several people
 * without tripping the five-Vouch cap.
 */
export async function signUpVouched(
  db: Database,
  input: { email: string; displayName: string; vouchers: [SignedInParticipant, SignedInParticipant] },
): Promise<SignedInParticipant> {
  const person = await signUp(db, input);
  for (const voucher of input.vouchers) await vouchFor(voucher.ctx, { subjectId: person.participant.id });
  person.actor.verificationLevel = "vouched";
  return person;
}
