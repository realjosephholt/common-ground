import type { Database } from "@/lib/db/client.js";
import { openConversation } from "@/lib/services/conversations.js";
import { writeStatement } from "@/lib/services/statements.js";
import { FIXTURE_REGIONS, seedRegionFixture, signUpVerified, signUpVouched, type SignedInParticipant } from "./fixtures.js";

let counter = 0;

/** A Participant who cleared the default `vouched` gate the ordinary way. */
export async function organiser(db: Database, label = "Organiser"): Promise<SignedInParticipant> {
  counter += 1;
  const vouchers: [SignedInParticipant, SignedInParticipant] = [
    await signUpVerified(db, { email: `root-a-${counter}@example.org`, displayName: "Root A" }),
    await signUpVerified(db, { email: `root-b-${counter}@example.org`, displayName: "Root B" }),
  ];
  return signUpVouched(db, { email: `person-${counter}@example.org`, displayName: label, vouchers });
}

export interface Deliberation {
  opener: SignedInParticipant;
  conversationId: string;
  statementId: string;
}

/** An open Conversation with one well-formed Statement in it — the setup almost every
 *  voting, Commitment and moderation test needs before it can say anything. */
export async function aDeliberation(db: Database, now?: () => Date): Promise<Deliberation> {
  await seedRegionFixture(db);
  const opener = await organiser(db);
  if (now) opener.ctx.now = now;

  const conversation = await openConversation(opener.ctx, {
    regionId: FIXTURE_REGIONS.springfieldIllinois,
    seedTopic: "Transit",
  });
  const { statement } = await writeStatement(opener.ctx, {
    conversationId: conversation.id,
    text: "Ask the city council to fund 20 new bus shelters on the east side before the March budget vote.",
  });

  return { opener, conversationId: conversation.id, statementId: statement.id };
}
