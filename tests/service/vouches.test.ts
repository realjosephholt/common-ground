import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { queryRows } from "@/lib/db/client.js";
import { designateVerified } from "@/lib/services/instance.js";
import { deleteParticipant } from "@/lib/services/participants.js";
import { MAX_OUTSTANDING_VOUCHES, revokeVouch, vouchFor } from "@/lib/services/vouches.js";
import { setupTestDatabase } from "../helpers/db.js";
import { signUp, type SignedInParticipant } from "../helpers/fixtures.js";

const ctx = setupTestDatabase();

let counter = 0;
async function participant(displayName: string): Promise<SignedInParticipant> {
  counter += 1;
  return signUp(ctx.db, { email: `p${counter}@example.org`, displayName });
}

/** A Participant the operator has rooted the graph with, refreshed so their context
 *  carries the level they were just given. */
async function verified(displayName: string): Promise<SignedInParticipant> {
  const person = await participant(displayName);
  const view = await designateVerified(person.ctx, { email: person.participant.email });
  person.actor.verificationLevel = view.verificationLevel;
  return person;
}

async function levelOf(id: string): Promise<string | null> {
  const [row] = await queryRows<{ verification_level: string | null }>(
    ctx.db,
    sql`select verification_level from participants where id = ${id}`,
  );
  return row?.verification_level ?? null;
}

describe("promotion", () => {
  it("promotes a Participant on the second live Vouch from vouched-or-better", async () => {
    const [a, b, subject] = [await verified("A"), await verified("B"), await participant("Subject")];

    await vouchFor(a.ctx, { subjectId: subject.participant.id });
    expect(await levelOf(subject.participant.id)).toBe("email");

    await vouchFor(b.ctx, { subjectId: subject.participant.id });
    expect(await levelOf(subject.participant.id)).toBe("vouched");
  });

  it("does not count two Vouches from the same person twice", async () => {
    const a = await verified("A");
    const subject = await participant("Subject");

    await vouchFor(a.ctx, { subjectId: subject.participant.id });
    await expect(vouchFor(a.ctx, { subjectId: subject.participant.id })).rejects.toMatchObject({ code: "conflict" });
    expect(await levelOf(subject.participant.id)).toBe("email");
  });

  it("does not count a Vouch from someone below vouched — until they are promoted", async () => {
    const [a, b] = [await verified("A"), await verified("B")];
    const middle = await participant("Middle");
    const subject = await participant("Subject");

    // Middle is only `email`, so this attestation is recorded and counts for nothing.
    await vouchFor(middle.ctx, { subjectId: subject.participant.id });
    await vouchFor(a.ctx, { subjectId: subject.participant.id });
    expect(await levelOf(subject.participant.id)).toBe("email");

    // Promoting Middle makes their standing attestation count, which promotes Subject.
    await vouchFor(a.ctx, { subjectId: middle.participant.id });
    await vouchFor(b.ctx, { subjectId: middle.participant.id });
    expect(await levelOf(middle.participant.id)).toBe("vouched");
    expect(await levelOf(subject.participant.id)).toBe("vouched");
  });

  it("never promotes past vouched — only an operator confers verified", async () => {
    const [a, b, c, d] = [await verified("A"), await verified("B"), await verified("C"), await verified("D")];
    const subject = await participant("Subject");

    for (const voucher of [a, b, c, d]) await vouchFor(voucher.ctx, { subjectId: subject.participant.id });
    expect(await levelOf(subject.participant.id)).toBe("vouched");
  });
});

describe("the outstanding-Vouch cap", () => {
  it(`rejects a Vouch beyond ${MAX_OUTSTANDING_VOUCHES}`, async () => {
    const voucher = await verified("Voucher");
    const subjects = [];
    for (let i = 0; i < MAX_OUTSTANDING_VOUCHES; i++) subjects.push(await participant(`S${i}`));

    for (const subject of subjects) await vouchFor(voucher.ctx, { subjectId: subject.participant.id });

    const sixth = await participant("Sixth");
    await expect(vouchFor(voucher.ctx, { subjectId: sixth.participant.id })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("frees capacity when a Vouch is revoked", async () => {
    const voucher = await verified("Voucher");
    const subjects = [];
    for (let i = 0; i < MAX_OUTSTANDING_VOUCHES; i++) subjects.push(await participant(`S${i}`));
    for (const subject of subjects) await vouchFor(voucher.ctx, { subjectId: subject.participant.id });

    await revokeVouch(voucher.ctx, { subjectId: subjects[0]!.participant.id });

    const sixth = await participant("Sixth");
    await expect(vouchFor(voucher.ctx, { subjectId: sixth.participant.id })).resolves.toBeDefined();
  });
});

describe("revocation (ADR-0008)", () => {
  it("records the revocation rather than deleting the edge", async () => {
    const voucher = await verified("Voucher");
    const subject = await participant("Subject");

    await vouchFor(voucher.ctx, { subjectId: subject.participant.id });
    await revokeVouch(voucher.ctx, { subjectId: subject.participant.id });

    const rows = await queryRows<{ revoked_at: string | null }>(
      ctx.db,
      sql`select revoked_at from vouches where voucher_id = ${voucher.participant.id}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revoked_at).not.toBeNull();
  });

  it("demotes the direct subject and nobody further", async () => {
    const [a, b] = [await verified("A"), await verified("B")];
    const middle = await participant("Middle");
    const downstream = await participant("Downstream");
    const other = await verified("Other");

    await vouchFor(a.ctx, { subjectId: middle.participant.id });
    await vouchFor(b.ctx, { subjectId: middle.participant.id });
    expect(await levelOf(middle.participant.id)).toBe("vouched");

    middle.actor.verificationLevel = "vouched";
    await vouchFor(middle.ctx, { subjectId: downstream.participant.id });
    await vouchFor(other.ctx, { subjectId: downstream.participant.id });
    expect(await levelOf(downstream.participant.id)).toBe("vouched");

    await revokeVouch(a.ctx, { subjectId: middle.participant.id });

    expect(await levelOf(middle.participant.id)).toBe("email");
    // The cascade is the attack: one compromised well-connected account must not be
    // able to revoke its way through a Conversation and silence people.
    expect(await levelOf(downstream.participant.id)).toBe("vouched");
  });

  it("does not demote a Participant the operator made verified", async () => {
    const [a, b] = [await verified("A"), await verified("B")];
    const subject = await verified("Subject");

    await vouchFor(a.ctx, { subjectId: subject.participant.id });
    await vouchFor(b.ctx, { subjectId: subject.participant.id });
    await revokeVouch(a.ctx, { subjectId: subject.participant.id });

    expect(await levelOf(subject.participant.id)).toBe("verified");
  });
});

describe("Vouches touching a tombstone", () => {
  it("revokes a deleted Participant's attestations and demotes only their direct subjects", async () => {
    const [a, b] = [await verified("A"), await verified("B")];
    const subject = await participant("Subject");

    await vouchFor(a.ctx, { subjectId: subject.participant.id });
    await vouchFor(b.ctx, { subjectId: subject.participant.id });
    expect(await levelOf(subject.participant.id)).toBe("vouched");

    await deleteParticipant(a.ctx);

    expect(await levelOf(subject.participant.id)).toBe("email");
    const [live] = await queryRows<{ count: number }>(
      ctx.db,
      sql`select count(*)::int as count from vouches where voucher_id = ${a.participant.id} and revoked_at is null`,
    );
    expect(Number(live?.count)).toBe(0);
  });

  it("keeps the edge, so who attested to whom survives the deletion", async () => {
    const a = await verified("A");
    const subject = await participant("Subject");
    await vouchFor(a.ctx, { subjectId: subject.participant.id });
    await deleteParticipant(a.ctx);

    const [count] = await queryRows<{ count: number }>(
      ctx.db,
      sql`select count(*)::int as count from vouches where voucher_id = ${a.participant.id}`,
    );
    expect(Number(count?.count)).toBe(1);
  });
});
