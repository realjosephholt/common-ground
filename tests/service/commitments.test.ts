import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { queryRows } from "@/lib/db/client.js";
import { COMMITMENT_LEVELS } from "@/lib/db/schema.js";
import { commitmentScore } from "@/lib/discovery/commitment.js";
import { closeConversation } from "@/lib/services/conversations.js";
import {
  commitTo,
  countedCommitments,
  listMyCommitments,
  strongestCommitmentPerParticipant,
  withdrawCommitment,
} from "@/lib/services/commitments.js";
import { deleteParticipant } from "@/lib/services/participants.js";
import { castVote, getMyVote } from "@/lib/services/votes.js";
import { setupTestDatabase } from "../helpers/db.js";
import { aDeliberation } from "../helpers/deliberation.js";

const ctx = setupTestDatabase();

describe("registering a Commitment", () => {
  it("takes any of the five levels", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);

    for (const level of COMMITMENT_LEVELS) {
      const commitment = await commitTo(opener.ctx, { statementId, level });
      expect(commitment.level).toBe(level);
    }
    expect(await listMyCommitments(opener.ctx, { statementId })).toHaveLength(COMMITMENT_LEVELS.length);
  });

  it("is idempotent at the same level", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);

    await commitTo(opener.ctx, { statementId, level: "show_up" });
    await commitTo(opener.ctx, { statementId, level: "show_up" });

    expect(await listMyCommitments(opener.ctx, { statementId })).toHaveLength(1);
  });

  it("can be withdrawn", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);

    await commitTo(opener.ctx, { statementId, level: "fund" });
    await withdrawCommitment(opener.ctx, { statementId, level: "fund" });

    expect(await listMyCommitments(opener.ctx, { statementId })).toEqual([]);
  });

  it("refuses a Conversation that is not open", async () => {
    const { opener, conversationId, statementId } = await aDeliberation(ctx.db);
    await closeConversation(opener.ctx, { conversationId });

    await expect(commitTo(opener.ctx, { statementId, level: "support" })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("only the strongest Commitment counts", () => {
  it("collapses several pledges by one person to their strongest", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);

    await commitTo(opener.ctx, { statementId, level: "support" });
    await commitTo(opener.ctx, { statementId, level: "organize" });
    await commitTo(opener.ctx, { statementId, level: "fund" });

    const strongest = await strongestCommitmentPerParticipant(opener.ctx, { statementId });
    expect(strongest).toEqual([{ participantId: opener.participant.id, level: "organize" }]);
  });

  /** The engine's own rule, exercised through the records the service hands it, so that
   *  the two cannot drift apart: pledging three times must be worth exactly one pledge. */
  it("gives the engine one contribution per person, not three", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);

    await commitTo(opener.ctx, { statementId, level: "support" });
    await commitTo(opener.ctx, { statementId, level: "organize" });

    const records = await countedCommitments(opener.ctx, { statementId });
    const scored = commitmentScore(records, 10);
    expect(scored.people).toBe(1);
    expect(scored.raw).toBe(6);
  });
});

describe("Commitment and Vote are different claims", () => {
  it("neither implies the other", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);

    await commitTo(opener.ctx, { statementId, level: "show_up" });
    expect(await getMyVote(opener.ctx, { statementId })).toBeNull();

    const { opener: other, statementId: otherStatement } = await aDeliberation(ctx.db);
    await castVote(other.ctx, { statementId: otherStatement, value: 1 });
    expect(await listMyCommitments(other.ctx, { statementId: otherStatement })).toEqual([]);
  });

  /**
   * ADR-0005: a Commitment is a signal against a Statement and confers membership of
   * nothing. Nothing downstream may read it as enrolment, so the service exposes no
   * roster — only counts and levels.
   */
  it("exposes no roster that could be mistaken for enrolment", async () => {
    const exports = await import("@/lib/services/commitments.js");
    expect(Object.keys(exports).some((name) => /member|roster|enrol|enroll|signup/i.test(name))).toBe(false);
  });
});

describe("a Commitment whose author leaves", () => {
  it("survives, attributed to the tombstone", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);
    await commitTo(opener.ctx, { statementId, level: "skill" });

    const { tombstoneId } = await deleteParticipant(opener.ctx);

    const [row] = await queryRows<{ participant_id: string; level: string }>(
      ctx.db,
      sql`select participant_id, level from commitments where statement_id = ${statementId}`,
    );
    expect(row?.level).toBe("skill");
    expect(row?.participant_id).toBe(tombstoneId);
  });
});
