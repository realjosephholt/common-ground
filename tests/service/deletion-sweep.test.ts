import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { queryRows } from "@/lib/db/client";
import { commitTo } from "@/lib/services/commitments";
import { openConversation } from "@/lib/services/conversations";
import { createContext } from "@/lib/services/context";
import { exportMyData, participantReferences } from "@/lib/services/export";
import { readModerationLog, reportStatement } from "@/lib/services/moderation";
import { deleteParticipant } from "@/lib/services/participants";
import { writeStatement } from "@/lib/services/statements";
import { castVote } from "@/lib/services/votes";
import { vouchFor } from "@/lib/services/vouches";
import { setupTestDatabase } from "../helpers/db";
import { aDeliberation, organiser } from "../helpers/deliberation";
import { FIXTURE_REGIONS, signUpVerified } from "../helpers/fixtures";

const ctx = setupTestDatabase();

/**
 * What deletion does to each table that references a Participant, and why.
 *
 * `keeps` means the row survives pointing at the tombstone — the whole design of
 * ADR-0004. `nulls` means the row survives with the reference removed. `removes` means
 * the row goes, which is only ever right for things nobody else relies on.
 */
const DELETION_POLICY: Record<string, "keeps" | "nulls" | "removes"> = {
  "sessions.participant_id": "removes",
  "statements.author_id": "nulls",
  "reports.reporter_id": "nulls",
  "reports.resolved_by": "nulls",
  "votes.participant_id": "keeps",
  "commitments.participant_id": "keeps",
  "conversations.created_by": "keeps",
  "moderation_log.actor_id": "keeps",
  "vouches.voucher_id": "keeps",
  "vouches.subject_id": "keeps",
};

describe("the deletion sweep", () => {
  /**
   * The invariant most likely to be broken silently later is not any single one of
   * these — it is someone adding a table with a Participant reference and never
   * deciding what deletion does to it. So the catalogue is read from the live database
   * rather than from a list kept by hand.
   */
  it("has a decided policy for every foreign key pointing at a Participant", async () => {
    const references = await participantReferences(createContext(ctx.db));
    const undecided = references
      .map((r) => `${r.table}.${r.column}`)
      .filter((key) => !(key in DELETION_POLICY));

    expect(undecided).toEqual([]);
    expect(references.length).toBeGreaterThanOrEqual(Object.keys(DELETION_POLICY).length);
  });

  it("covers create -> participate -> delete -> verify across every table", async () => {
    // ---- create ------------------------------------------------------------
    const { opener, conversationId, statementId } = await aDeliberation(ctx.db);
    const other = await organiser(ctx.db, "Other");
    const moderatorish = await signUpVerified(ctx.db, { email: "sweep-mod@example.org", displayName: "Mod" });

    // ---- participate -------------------------------------------------------
    const ownConversation = await openConversation(opener.ctx, {
      regionId: FIXTURE_REGIONS.springfieldMissouri,
      seedTopic: "Also mine",
    });
    const own = await writeStatement(opener.ctx, {
      conversationId,
      text: "Ask the county board to fund a warming centre before December.",
    });
    await castVote(opener.ctx, { statementId, value: 1 });
    await commitTo(opener.ctx, { statementId, level: "organize" });
    await reportStatement(opener.ctx, { statementId, reason: "Testing the sweep." });
    await vouchFor(moderatorish.ctx, { subjectId: opener.participant.id });
    await vouchFor(opener.ctx, { subjectId: other.participant.id });

    const exported = await exportMyData(opener.ctx);
    expect(exported.participant.email).toBe(opener.participant.email);
    expect(exported.votes).toHaveLength(1);
    expect(exported.commitments).toHaveLength(1);
    expect(exported.statements).toHaveLength(2);
    expect(exported.conversationsOpened).toHaveLength(2);
    expect(exported.vouchesGiven).toHaveLength(1);
    // Two from the roots that promoted them to `vouched`, plus the one just given.
    expect(exported.vouchesReceived).toHaveLength(3);
    expect(exported.reportsFiled).toHaveLength(1);
    expect(exported.whatDeletionWouldDo.join(" ")).toContain("tombstone");

    // The Instance holds these about them too, and an export that claims to be
    // everything has to include them. Token hashes are deliberately not in the shape:
    // handing someone a file that can sign them in is a worse trade than omitting it.
    expect(exported.sessions.length).toBeGreaterThan(0);
    expect(exported.outstandingSignInLinks.length).toBeGreaterThan(0);
    expect(JSON.stringify(exported)).not.toContain("tokenHash");

    // ---- delete ------------------------------------------------------------
    // The identifier rotates: a UUIDv7 encodes its mint time, so keeping one would
    // leave the sign-up moment readable off the tombstone.
    const { tombstoneId: id } = await deleteParticipant(opener.ctx);
    expect(id).not.toBe(opener.participant.id);

    // ---- verify ------------------------------------------------------------
    const [tombstone] = await queryRows<Record<string, unknown>>(
      ctx.db,
      sql`select * from participants where id = ${id}`,
    );
    for (const [column, value] of Object.entries(tombstone!)) {
      if (column === "id" || column === "tombstoned") continue;
      expect({ [column]: value }).toEqual({ [column]: null });
    }

    const counts = await queryRows<Record<string, number>>(
      ctx.db,
      sql`select
        (select count(*)::int from votes where participant_id = ${id})              as votes_kept,
        (select count(*)::int from commitments where participant_id = ${id})        as commitments_kept,
        (select count(*)::int from conversations where created_by = ${id})          as conversations_kept,
        (select count(*)::int from vouches where voucher_id = ${id})                as vouches_given_kept,
        (select count(*)::int from vouches where subject_id = ${id})                as vouches_received_kept,
        (select count(*)::int from vouches
           where (voucher_id = ${id} or subject_id = ${id}) and revoked_at is null) as vouches_still_live,
        (select count(*)::int from statements where author_id = ${id})              as statements_attributed,
        (select count(*)::int from reports where reporter_id = ${id})               as reports_attributed,
        (select count(*)::int from sessions where participant_id = ${id})           as sessions_left,
        (select count(*)::int from statements where conversation_id = ${conversationId}) as statements_surviving`,
    );

    expect(counts[0]).toMatchObject({
      votes_kept: 1,
      commitments_kept: 1,
      conversations_kept: 2,
      vouches_given_kept: 1,
      vouches_received_kept: 3,
      vouches_still_live: 0,
      statements_attributed: 0,
      reports_attributed: 0,
      sessions_left: 0,
      statements_surviving: 2,
    });

    // The Report itself is still in the queue: erasing the reporter must not erase the
    // thing they reported, or deletion becomes a way to withdraw a complaint silently.
    const [reportRows] = await queryRows<{ count: number }>(
      ctx.db,
      sql`select count(*)::int as count from reports where status = 'open'`,
    );
    expect(Number(reportRows?.count)).toBe(1);

    void own;
    void ownConversation;
  });

  it("leaves a tombstone that cannot be told apart from any other", async () => {
    const first = await organiser(ctx.db, "First");
    const second = await organiser(ctx.db, "Second");
    await deleteParticipant(first.ctx);
    await deleteParticipant(second.ctx);

    const rows = await queryRows<Record<string, unknown>>(
      ctx.db,
      sql`select * from participants where tombstoned = true`,
    );
    expect(rows).toHaveLength(2);

    // Everything except the identifier is identical, so no attribute distinguishes one
    // deleted person from another — which is what stops the tombstone being a
    // correlation handle.
    const shapes = rows.map((row) => JSON.stringify({ ...row, id: null }));
    expect(new Set(shapes).size).toBe(1);

    // Nulling `id` above would hide a timestamp encoded inside it, so check it
    // separately rather than assuming the columns are the whole story.
    for (const row of rows) {
      const hex = String(row["id"]).replace(/-/g, "");
      expect(hex[12]).toBe("4");
    }
  });

  it("keeps a departed moderator's actions in the public log", async () => {
    const { statementId } = await aDeliberation(ctx.db);
    const mod = await signUpVerified(ctx.db, { email: "leaving-mod@example.org", displayName: "Leaving" });
    await reportStatement(mod.ctx, { statementId, reason: "Something." });

    const before = await readModerationLog(createContext(ctx.db), {});
    await deleteParticipant(mod.ctx);
    const after = await readModerationLog(createContext(ctx.db), {});

    expect(after).toHaveLength(before.length);
  });

  it("refuses to export anything to a tombstone", async () => {
    const person = await organiser(ctx.db, "Gone");
    await deleteParticipant(person.ctx);
    await expect(exportMyData(person.ctx)).rejects.toMatchObject({ code: "not_found" });
  });
});
