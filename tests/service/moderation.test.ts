import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { queryRows } from "@/lib/db/client.js";
import { createContext } from "@/lib/services/context.js";
import {
  listOpenReports,
  readModerationLog,
  redactStatement,
  removeStatement,
  reportStatement,
  resolveReport,
} from "@/lib/services/moderation.js";
import { nextStatementsToVote } from "@/lib/services/routing.js";
import { castVote, tallyVotes } from "@/lib/services/votes.js";
import { setupTestDatabase } from "../helpers/db.js";
import { aDeliberation, organiser } from "../helpers/deliberation.js";
import { signUpVerified } from "../helpers/fixtures.js";

const ctx = setupTestDatabase();

let counter = 0;
async function moderator() {
  counter += 1;
  return signUpVerified(ctx.db, { email: `mod-${counter}@example.org`, displayName: "Moderator" });
}

describe("Reports", () => {
  it("records a Report with a reason", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);
    const report = await reportStatement(opener.ctx, { statementId, reason: "Names a private individual." });

    expect(report.status).toBe("open");
    expect(report.reason).toBe("Names a private individual.");
  });

  it("requires a reason, so a queue entry always says what is wrong", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);
    await expect(reportStatement(opener.ctx, { statementId, reason: "  " })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("puts open Reports in a queue a Moderator can work", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);
    await reportStatement(opener.ctx, { statementId, reason: "Harassment." });

    const queue = await listOpenReports((await moderator()).ctx);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.statementId).toBe(statementId);
  });

  it("shows the queue to nobody but a Moderator", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);
    await reportStatement(opener.ctx, { statementId, reason: "Harassment." });

    await expect(listOpenReports(opener.ctx)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("cannot be silently dropped — resolving one writes to the log", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);
    const report = await reportStatement(opener.ctx, { statementId, reason: "Spam." });
    const mod = await moderator();

    await resolveReport(mod.ctx, { reportId: report.id, outcome: "dismissed", reason: "Within policy." });

    expect(await listOpenReports(mod.ctx)).toEqual([]);
    const log = await readModerationLog(createContext(ctx.db), {});
    expect(log.map((entry) => entry.action)).toContain("report_dismissed");
  });
});

describe("the Moderation Log", () => {
  it("records actor, action, target, reason and timestamp for every action", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);
    const mod = await moderator();

    await removeStatement(mod.ctx, { statementId, reason: "Breaches the content policy." });

    const [entry] = await readModerationLog(createContext(ctx.db), {});
    expect(entry).toMatchObject({
      actorId: mod.participant.id,
      action: "statement_removed",
      targetType: "statement",
      targetId: statementId,
      reason: "Breaches the content policy.",
    });
    expect(entry!.createdAt).toBeInstanceOf(Date);
    void opener;
  });

  it("is readable by someone who is not signed in at all", async () => {
    const { statementId } = await aDeliberation(ctx.db);
    const mod = await moderator();
    await removeStatement(mod.ctx, { statementId, reason: "Policy." });

    // Suppression of a Cause has to be visible rather than invisible, which means the
    // log cannot require an account to read.
    const log = await readModerationLog(createContext(ctx.db), {});
    expect(log).toHaveLength(1);
  });

  it("exposes no update or delete path", async () => {
    const exports = await import("@/lib/services/moderation.js");
    const mutators = Object.keys(exports).filter((name) => /(update|edit|delete|amend|purge).*log/i.test(name));
    expect(mutators).toEqual([]);
  });

  /** Append-only is structural, not a promise the service layer makes. A log a
   *  moderator can quietly edit is not a log. */
  it("refuses an UPDATE or a DELETE at the database", async () => {
    const { statementId } = await aDeliberation(ctx.db);
    const mod = await moderator();
    await removeStatement(mod.ctx, { statementId, reason: "Policy." });

    await expect(ctx.db.execute(sql`update moderation_log set reason = 'nothing to see'`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`delete from moderation_log`)).rejects.toThrow();
  });
});

describe("Redaction (ADR-0006)", () => {
  it("clears the text while the Statement and its Votes survive", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);
    const voter = await organiser(ctx.db, "Voter");
    await castVote(opener.ctx, { statementId, value: 1 });
    void voter;

    await redactStatement(opener.ctx, { statementId, reason: "I want my words back." });

    const [row] = await queryRows<{ text: string | null; redacted_at: string | null }>(
      ctx.db,
      sql`select text, redacted_at from statements where id = ${statementId}`,
    );
    expect(row?.text).toBeNull();
    expect(row?.redacted_at).not.toBeNull();

    // A Statement four hundred people voted on cannot simply vanish: those Votes would
    // become votes on nothing while still shaping the opinion map.
    expect(await tallyVotes(opener.ctx, { statementId })).toEqual({ agree: 1, disagree: 0, pass: 0 });
  });

  it("appends to the Moderation Log, so it cannot become a quiet moderation channel", async () => {
    const { opener, statementId } = await aDeliberation(ctx.db);
    await redactStatement(opener.ctx, { statementId, reason: "Second thoughts." });

    const log = await readModerationLog(createContext(ctx.db), {});
    expect(log.map((entry) => entry.action)).toContain("statement_redacted");
  });

  it("is available to the author and to a Moderator, and to nobody else", async () => {
    const { statementId } = await aDeliberation(ctx.db);
    const stranger = await organiser(ctx.db, "Stranger");

    await expect(redactStatement(stranger.ctx, { statementId })).rejects.toMatchObject({ code: "forbidden" });
    await expect(redactStatement((await moderator()).ctx, { statementId })).resolves.toBeUndefined();
  });
});

describe("routing after moderation", () => {
  it("stops routing a removed Statement to voters immediately", async () => {
    const { conversationId, statementId } = await aDeliberation(ctx.db);
    const voter = await organiser(ctx.db, "Voter");

    expect(await nextStatementsToVote(voter.ctx, { conversationId, limit: 5 })).toContain(statementId);

    await removeStatement((await moderator()).ctx, { statementId, reason: "Policy." });

    expect(await nextStatementsToVote(voter.ctx, { conversationId, limit: 5 })).not.toContain(statementId);
  });

  it("keeps routing a redacted Statement, because the Votes on it were real", async () => {
    const { opener, conversationId, statementId } = await aDeliberation(ctx.db);
    const voter = await organiser(ctx.db, "Voter");
    await redactStatement(opener.ctx, { statementId });

    expect(await nextStatementsToVote(voter.ctx, { conversationId, limit: 5 })).toContain(statementId);
  });

  it("does not route a Statement back to someone who already voted on it", async () => {
    const { conversationId, statementId } = await aDeliberation(ctx.db);
    const voter = await organiser(ctx.db, "Voter");

    await castVote(voter.ctx, { statementId, value: -1 });
    expect(await nextStatementsToVote(voter.ctx, { conversationId, limit: 5 })).toEqual([]);
  });
});
