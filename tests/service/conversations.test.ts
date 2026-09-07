import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { queryRows } from "@/lib/db/client";
import {
  archiveConversation,
  closeConversation,
  getConversation,
  listConversations,
  openConversation,
  setMinVerificationLevel,
} from "@/lib/services/conversations";
import { configureInstance } from "@/lib/services/instance";
import { deleteParticipant } from "@/lib/services/participants";
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
async function roots(): Promise<[SignedInParticipant, SignedInParticipant]> {
  counter += 1;
  return [
    await signUpVerified(ctx.db, { email: `root-a-${counter}@example.org`, displayName: "Root A" }),
    await signUpVerified(ctx.db, { email: `root-b-${counter}@example.org`, displayName: "Root B" }),
  ];
}

async function organiser(): Promise<SignedInParticipant> {
  counter += 1;
  return signUpVouched(ctx.db, {
    email: `organiser-${counter}@example.org`,
    displayName: "Organiser",
    vouchers: await roots(),
  });
}

describe("opening a Conversation", () => {
  it("lets a vouched Participant open one scoped to a Region", async () => {
    await seedRegionFixture(ctx.db);
    const person = await organiser();

    const conversation = await openConversation(person.ctx, {
      regionId: FIXTURE_REGIONS.springfieldIllinois,
      seedTopic: "Bus shelters on the east side",
    });

    expect(conversation.status).toBe("open");
    expect(conversation.regionId).toBe(FIXTURE_REGIONS.springfieldIllinois);
    expect(conversation.seedTopic).toBe("Bus shelters on the east side");
  });

  it("refuses a Participant who is not yet vouched", async () => {
    await seedRegionFixture(ctx.db);
    const person = await signUp(ctx.db, { email: "fresh@example.org", displayName: "Fresh" });

    await expect(
      openConversation(person.ctx, { regionId: FIXTURE_REGIONS.illinois, seedTopic: "Anything" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a Region that does not exist", async () => {
    await seedRegionFixture(ctx.db);
    const person = await organiser();
    await expect(
      openConversation(person.ctx, { regionId: 999_999_999, seedTopic: "Nowhere" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("requires a seed topic", async () => {
    await seedRegionFixture(ctx.db);
    const person = await organiser();
    await expect(
      openConversation(person.ctx, { regionId: FIXTURE_REGIONS.illinois, seedTopic: "  " }),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("rate limiting", () => {
  it("stops one Participant flooding discovery, and lets up once the window passes", async () => {
    await seedRegionFixture(ctx.db);
    let clock = new Date("2026-05-01T09:00:00Z");
    const person = await organiser();
    person.ctx.now = () => clock;

    await configureInstance(person.ctx, { conversationRateLimit: 2, conversationRateLimitWindowHours: 24 });

    await openConversation(person.ctx, { regionId: FIXTURE_REGIONS.illinois, seedTopic: "One" });
    await openConversation(person.ctx, { regionId: FIXTURE_REGIONS.illinois, seedTopic: "Two" });
    await expect(
      openConversation(person.ctx, { regionId: FIXTURE_REGIONS.illinois, seedTopic: "Three" }),
    ).rejects.toMatchObject({ code: "rate_limited" });

    clock = new Date("2026-05-02T10:00:00Z");
    await expect(
      openConversation(person.ctx, { regionId: FIXTURE_REGIONS.illinois, seedTopic: "Later" }),
    ).resolves.toBeDefined();
  });
});

describe("lifecycle", () => {
  it("moves open -> closed -> archived", async () => {
    await seedRegionFixture(ctx.db);
    const person = await organiser();
    const opened = await openConversation(person.ctx, {
      regionId: FIXTURE_REGIONS.illinois,
      seedTopic: "Lifecycle",
    });

    expect((await closeConversation(person.ctx, { conversationId: opened.id })).status).toBe("closed");
    expect((await archiveConversation(person.ctx, { conversationId: opened.id })).status).toBe("archived");
  });

  it("refuses to reopen a closed Conversation, or to move an archived one at all", async () => {
    await seedRegionFixture(ctx.db);
    const person = await organiser();
    const opened = await openConversation(person.ctx, { regionId: FIXTURE_REGIONS.illinois, seedTopic: "Once" });

    await closeConversation(person.ctx, { conversationId: opened.id });
    await expect(closeConversation(person.ctx, { conversationId: opened.id })).rejects.toMatchObject({
      code: "conflict",
    });

    await archiveConversation(person.ctx, { conversationId: opened.id });
    await expect(closeConversation(person.ctx, { conversationId: opened.id })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(archiveConversation(person.ctx, { conversationId: opened.id })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("drops an archived Conversation from discovery while keeping it readable", async () => {
    await seedRegionFixture(ctx.db);
    const person = await organiser();
    const opened = await openConversation(person.ctx, { regionId: FIXTURE_REGIONS.illinois, seedTopic: "Gone" });
    await archiveConversation(person.ctx, { conversationId: opened.id });

    expect(await listConversations(person.ctx, {})).toEqual([]);
    // Retained for the graph, so Outcomes stay traceable to where they began.
    expect((await getConversation(person.ctx, opened.id)).status).toBe("archived");
  });

  it("lets nobody but the opener or a verified Participant move it", async () => {
    await seedRegionFixture(ctx.db);
    const person = await organiser();
    const bystander = await organiser();
    const opened = await openConversation(person.ctx, { regionId: FIXTURE_REGIONS.illinois, seedTopic: "Mine" });

    await expect(closeConversation(bystander.ctx, { conversationId: opened.id })).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("the entry gate", () => {
  it("takes its default from the Instance and can be raised per Conversation", async () => {
    await seedRegionFixture(ctx.db);
    const person = await organiser();
    const opened = await openConversation(person.ctx, { regionId: FIXTURE_REGIONS.illinois, seedTopic: "Gated" });
    expect(opened.minVerificationLevel).toBe("vouched");

    const [operator] = await roots();
    const raised = await setMinVerificationLevel(operator.ctx, {
      conversationId: opened.id,
      minVerificationLevel: "verified",
    });
    expect(raised.minVerificationLevel).toBe("verified");
  });

  it("refuses to let a Participant open a Conversation gated above their own level", async () => {
    await seedRegionFixture(ctx.db);
    const person = await organiser();
    await expect(
      openConversation(person.ctx, {
        regionId: FIXTURE_REGIONS.illinois,
        seedTopic: "Above me",
        minVerificationLevel: "verified",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("a Conversation whose opener leaves", () => {
  it("survives, pointing at the tombstone", async () => {
    await seedRegionFixture(ctx.db);
    const person = await organiser();
    const opened = await openConversation(person.ctx, { regionId: FIXTURE_REGIONS.illinois, seedTopic: "Outlives" });

    const { tombstoneId } = await deleteParticipant(person.ctx);

    const [row] = await queryRows<{ created_by: string | null; seed_topic: string }>(
      ctx.db,
      sql`select created_by, seed_topic from conversations where id = ${opened.id}`,
    );
    expect(row?.seed_topic).toBe("Outlives");
    expect(row?.created_by).toBe(tombstoneId);
  });
});
