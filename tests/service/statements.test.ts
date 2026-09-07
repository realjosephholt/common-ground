import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { queryRows } from "@/lib/db/client";
import { STATEMENT_MAX_LENGTH } from "@/lib/db/schema";
import { composerGuidance } from "@/lib/statements/composer";
import { archiveConversation, closeConversation, openConversation } from "@/lib/services/conversations";
import { deleteParticipant } from "@/lib/services/participants";
import { listStatements, writeStatement } from "@/lib/services/statements";
import { setupTestDatabase } from "../helpers/db";
import {
  FIXTURE_REGIONS,
  seedRegionFixture,
  signUp,
  signUpVerified,
  signUpVouched,
  type SignedInParticipant,
} from "../helpers/fixtures";

const ctx = setupTestDatabase();

let counter = 0;
async function organiser(): Promise<SignedInParticipant> {
  counter += 1;
  const vouchers: [SignedInParticipant, SignedInParticipant] = [
    await signUpVerified(ctx.db, { email: `ra${counter}@example.org`, displayName: "Root A" }),
    await signUpVerified(ctx.db, { email: `rb${counter}@example.org`, displayName: "Root B" }),
  ];
  return signUpVouched(ctx.db, { email: `o${counter}@example.org`, displayName: "Organiser", vouchers });
}

async function conversation(person: SignedInParticipant): Promise<string> {
  await seedRegionFixture(ctx.db);
  const opened = await openConversation(person.ctx, {
    regionId: FIXTURE_REGIONS.springfieldIllinois,
    seedTopic: "Transit",
  });
  return opened.id;
}

const A_PROPOSAL = "Ask the city council to fund 20 new bus shelters on the east side before the March budget vote.";

describe("writing a Statement", () => {
  it("writes into an open Conversation", async () => {
    const person = await organiser();
    const conversationId = await conversation(person);

    const { statement } = await writeStatement(person.ctx, { conversationId, text: A_PROPOSAL });

    expect(statement.text).toBe(A_PROPOSAL);
    expect(statement.conversationId).toBe(conversationId);
    expect(statement.authorId).toBe(person.participant.id);
  });

  it("carries a moderation status from creation, so moderation has something to act on", async () => {
    const person = await organiser();
    const conversationId = await conversation(person);
    const { statement } = await writeStatement(person.ctx, { conversationId, text: A_PROPOSAL });
    expect(statement.moderationStatus).toBe("approved");
  });

  it("refuses a closed or archived Conversation", async () => {
    const person = await organiser();
    const conversationId = await conversation(person);

    await closeConversation(person.ctx, { conversationId });
    await expect(writeStatement(person.ctx, { conversationId, text: A_PROPOSAL })).rejects.toMatchObject({
      code: "conflict",
    });

    await archiveConversation(person.ctx, { conversationId });
    await expect(writeStatement(person.ctx, { conversationId, text: A_PROPOSAL })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("refuses a Participant below the Conversation's entry gate", async () => {
    const person = await organiser();
    const conversationId = await conversation(person);
    const fresh = await signUp(ctx.db, { email: "fresh-writer@example.org", displayName: "Fresh" });

    await expect(writeStatement(fresh.ctx, { conversationId, text: A_PROPOSAL })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("enforces a length limit", async () => {
    const person = await organiser();
    const conversationId = await conversation(person);

    await expect(
      writeStatement(person.ctx, { conversationId, text: "x".repeat(STATEMENT_MAX_LENGTH + 1) }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(writeStatement(person.ctx, { conversationId, text: "  " })).rejects.toMatchObject({
      code: "invalid",
    });
  });
});

describe("the composer's guidance", () => {
  it("says nothing about a well-formed proposal", () => {
    expect(composerGuidance(A_PROPOSAL)).toEqual([]);
  });

  it("points out that a complaint is not something anyone can say yes to", () => {
    const codes = composerGuidance("The buses here are terrible and nobody in charge cares.").map((g) => g.code);
    expect(codes).toContain("reads_as_complaint");
  });

  it("names what a vague proposal is missing", () => {
    const codes = composerGuidance("We should improve public transport.").map((g) => g.code);
    expect(codes).toContain("no_target");
    expect(codes).toContain("no_deadline");
  });

  it("guides rather than gates — a complaint is still accepted", async () => {
    const person = await organiser();
    const conversationId = await conversation(person);

    const { statement, guidance } = await writeStatement(person.ctx, {
      conversationId,
      text: "The buses here are terrible and nobody in charge cares.",
    });

    expect(statement.id).toBeDefined();
    expect(guidance.map((g) => g.code)).toContain("reads_as_complaint");
  });
});

describe("a Statement whose author leaves", () => {
  it("survives with authorship nulled (ADR-0006)", async () => {
    const person = await organiser();
    const conversationId = await conversation(person);
    const { statement } = await writeStatement(person.ctx, { conversationId, text: A_PROPOSAL });

    await deleteParticipant(person.ctx);

    const [row] = await queryRows<{ author_id: string | null; text: string | null }>(
      ctx.db,
      sql`select author_id, text from statements where id = ${statement.id}`,
    );
    // The Votes cast on it keep their referent; the words stop being attributed.
    expect(row?.text).toBe(A_PROPOSAL);
    expect(row?.author_id).toBeNull();
  });
});

describe("listing Statements", () => {
  it("returns the Statements in a Conversation", async () => {
    const person = await organiser();
    const conversationId = await conversation(person);
    await writeStatement(person.ctx, { conversationId, text: A_PROPOSAL });
    await writeStatement(person.ctx, { conversationId, text: "Ask the mayor to publish the shelter budget by May." });

    expect(await listStatements(person.ctx, { conversationId })).toHaveLength(2);
  });
});
