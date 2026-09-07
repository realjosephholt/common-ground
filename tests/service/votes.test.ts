import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { queryRows } from "@/lib/db/client.js";
import { archiveConversation, closeConversation, openConversation } from "@/lib/services/conversations.js";
import { deleteParticipant } from "@/lib/services/participants.js";
import { writeStatement } from "@/lib/services/statements.js";
import { archiveSilentConversations, castVote, getMyVote, tallyVotes } from "@/lib/services/votes.js";
import { setupTestDatabase } from "../helpers/db.js";
import { aDeliberation, organiser } from "../helpers/deliberation.js";
import { FIXTURE_REGIONS, seedRegionFixture, signUp } from "../helpers/fixtures.js";

const ctx = setupTestDatabase();

describe("casting a Vote", () => {
  it("takes agree, disagree and pass", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);

    for (const value of [1, -1, 0] as const) {
      const vote = await castVote(opener.ctx, { statementId, value });
      expect(vote.value).toBe(value);
    }
  });

  /** Pass is counted distinctly from an unseen Statement: "saw it and abstained" and
   *  "never saw it" are different facts, and the scoring treats them differently. */
  it("records a pass as a Vote rather than as an absence", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);
    await castVote(opener.ctx, { statementId, value: 0 });

    expect((await getMyVote(opener.ctx, { statementId }))?.value).toBe(0);
    expect(await tallyVotes(opener.ctx, { statementId })).toEqual({ agree: 0, disagree: 0, pass: 1 });
  });

  it("replaces a previous Vote rather than accumulating", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);

    await castVote(opener.ctx, { statementId, value: 1 });
    await castVote(opener.ctx, { statementId, value: -1 });

    const [row] = await queryRows<{ count: number }>(
      ctx.db,
      sql`select count(*)::int as count from votes where statement_id = ${statementId}`,
    );
    expect(Number(row?.count)).toBe(1);
    expect((await getMyVote(opener.ctx, { statementId }))?.value).toBe(-1);
  });

  it("constrains the value at the database level, not merely in the service", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);
    await expect(
      ctx.db.execute(
        sql`insert into votes (participant_id, statement_id, value)
            values (${opener.participant.id}, ${statementId}, 7)`,
      ),
    ).rejects.toThrow();
  });

  it("refuses a Conversation that is not open", async () => {
    const { opener, conversationId, statementId } = await aDeliberation(ctx.db);

    await closeConversation(opener.ctx, { conversationId });
    await expect(castVote(opener.ctx, { statementId, value: 1 })).rejects.toMatchObject({ code: "conflict" });

    await archiveConversation(opener.ctx, { conversationId });
    await expect(castVote(opener.ctx, { statementId, value: 1 })).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a Participant below the Conversation's entry gate", async () => {
    const { statementId } = await aDeliberation(ctx.db);
    const fresh = await signUp(ctx.db, { email: "fresh-voter@example.org", displayName: "Fresh" });

    await expect(castVote(fresh.ctx, { statementId, value: 1 })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("a Vote whose author leaves (ADR-0004)", () => {
  it("survives, attributed to the tombstone", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);
    await castVote(opener.ctx, { statementId, value: 1 });

    const { tombstoneId } = await deleteParticipant(opener.ctx);

    const [row] = await queryRows<{ participant_id: string; value: number }>(
      ctx.db,
      sql`select participant_id, value from votes where statement_id = ${statementId}`,
    );
    // Erasing it would retroactively rewrite consensus other people relied on, and in a
    // small Conversation could shrink an Opinion Group enough to identify its members.
    expect(row?.value).toBe(1);
    expect(row?.participant_id).toBe(tombstoneId);
  });
});

describe("automatic archival of dead Conversations", () => {
  it("archives one that attracted no Votes in fourteen days", async () => {
    let clock = new Date("2026-01-01T00:00:00Z");
    const { conversationId } = await aDeliberation(ctx.db, () => clock);

    clock = new Date("2026-01-10T00:00:00Z");
    expect(await archiveSilentConversations({ ...(await organiser(ctx.db)).ctx, now: () => clock })).toEqual([]);

    clock = new Date("2026-01-16T00:00:00Z");
    const archived = await archiveSilentConversations({ ...(await organiser(ctx.db)).ctx, now: () => clock });
    expect(archived.map((c) => c.id)).toContain(conversationId);
  });

  it("leaves alone a Conversation that people actually voted in", async () => {
    let clock = new Date("2026-02-01T00:00:00Z");
    const { opener, conversationId, statementId } = await aDeliberation(ctx.db, () => clock);
    await castVote(opener.ctx, { statementId, value: 1 });

    clock = new Date("2026-03-01T00:00:00Z");
    const archived = await archiveSilentConversations({ ...opener.ctx, now: () => clock });
    expect(archived.map((c) => c.id)).not.toContain(conversationId);
  });

  it("leaves alone a Conversation that is already closed", async () => {
    let clock = new Date("2026-02-01T00:00:00Z");
    const { opener, conversationId } = await aDeliberation(ctx.db, () => clock);
    await closeConversation(opener.ctx, { conversationId });

    clock = new Date("2026-03-01T00:00:00Z");
    const archived = await archiveSilentConversations({ ...opener.ctx, now: () => clock });
    expect(archived.map((c) => c.id)).not.toContain(conversationId);
  });

  it("does not archive a Conversation younger than the window", async () => {
    let clock = new Date("2026-04-01T00:00:00Z");
    await seedRegionFixture(ctx.db);
    const opener = await organiser(ctx.db);
    opener.ctx.now = () => clock;
    const conversation = await openConversation(opener.ctx, {
      regionId: FIXTURE_REGIONS.springfieldIllinois,
      seedTopic: "Fresh",
    });
    await writeStatement(opener.ctx, {
      conversationId: conversation.id,
      text: "Ask the mayor to publish the shelter budget before May.",
    });

    clock = new Date("2026-04-10T00:00:00Z");
    expect(await archiveSilentConversations(opener.ctx)).toEqual([]);
  });
});
