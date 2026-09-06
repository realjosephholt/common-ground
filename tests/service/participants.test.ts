import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { queryRows } from "@/lib/db/client.js";
import { participants } from "@/lib/db/schema.js";
import { consumeSignInToken, requestSignIn, resolveActor } from "@/lib/services/auth.js";
import { createContext } from "@/lib/services/context.js";
import { deleteParticipant, getStoredLocation, setDisplayName, setLocation } from "@/lib/services/participants.js";
import { setupTestDatabase } from "../helpers/db.js";
import { capturingDelivery, signUp } from "../helpers/fixtures.js";

const ctx = setupTestDatabase();

describe("becoming a Participant", () => {
  it("requires a display name from someone the Instance has never seen", async () => {
    const { delivery } = capturingDelivery();
    const context = createContext(ctx.db, { deliverSignInLink: delivery });
    await expect(requestSignIn(context, { email: "nobody@example.org" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("never asks for a real name, and takes the display name as given", async () => {
    const { participant } = await signUp(ctx.db, { email: "rosa@example.org", displayName: "a neighbour" });
    expect(participant.displayName).toBe("a neighbour");
  });

  it("refuses a blank display name", async () => {
    const { ctx: context } = await signUp(ctx.db, { email: "sam@example.org", displayName: "Sam" });
    await expect(setDisplayName(context, { displayName: "   " })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("coarse location", () => {
  it("stores a precision-5 geohash and no coordinates, and says so plainly", async () => {
    const { ctx: context } = await signUp(ctx.db, { email: "kim@example.org", displayName: "Kim" });

    // Austin City Hall, to five significant figures of nobody's business.
    const stored = await setLocation(context, { latitude: 30.2649, longitude: -97.7471 });

    expect(stored.geohash5).toHaveLength(5);
    expect(stored.precision.geohashCharacters).toBe(5);
    expect(stored.precision.description).toContain("4.9km");

    const [row] = await ctx.db.select().from(participants).where(eq(participants.id, context.actor!.id));
    expect(row?.geohash5).toBe(stored.geohash5);
    // Nothing in the row can reconstruct where they actually are.
    expect(JSON.stringify(row)).not.toContain("30.26");
  });

  it("collapses two addresses in the same cell to the same stored value", async () => {
    const a = await signUp(ctx.db, { email: "a@example.org", displayName: "A" });
    const b = await signUp(ctx.db, { email: "b@example.org", displayName: "B" });

    const first = await setLocation(a.ctx, { latitude: 30.2649, longitude: -97.7471 });
    const second = await setLocation(b.ctx, { latitude: 30.2661, longitude: -97.7443 });
    expect(second.geohash5).toBe(first.geohash5);
  });

  it("reports the stored precision even before a location is set", async () => {
    const { ctx: context } = await signUp(ctx.db, { email: "pat@example.org", displayName: "Pat" });
    const stored = await getStoredLocation(context);
    expect(stored.geohash5).toBeNull();
    expect(stored.precision.approximateCellKm).toBe(4.9);
  });
});

describe("deletion (ADR-0004)", () => {
  it("erases every attribute and leaves an attribute-free tombstone", async () => {
    const signedIn = await signUp(ctx.db, { email: "ida@example.org", displayName: "Ida" });
    await setLocation(signedIn.ctx, { latitude: 51.5072, longitude: -0.1276 });

    await deleteParticipant(signedIn.ctx);

    const rows = await queryRows<Record<string, unknown>>(
      ctx.db,
      sql`select * from participants where id = ${signedIn.participant.id}`,
    );
    expect(rows).toHaveLength(1);

    // Named individually rather than looped, so that adding an attribute to the table
    // without deciding what deletion does to it fails here.
    const tombstone = rows[0]!;
    expect(tombstone["tombstoned"]).toBe(true);
    for (const attribute of [
      "origin_instance",
      "email",
      "display_name",
      "geohash5",
      "region_id",
      "verification_level",
      "created_at",
      "updated_at",
    ]) {
      expect({ [attribute]: tombstone[attribute] }).toEqual({ [attribute]: null });
    }
    expect(Object.keys(tombstone).sort()).toEqual(
      [
        "created_at",
        "display_name",
        "email",
        "geohash5",
        "id",
        "origin_instance",
        "region_id",
        "tombstoned",
        "updated_at",
        "verification_level",
      ].sort(),
    );
  });

  it("ends the deleted Participant's sessions", async () => {
    const signedIn = await signUp(ctx.db, { email: "otto@example.org", displayName: "Otto" });
    await deleteParticipant(signedIn.ctx);
    expect(await resolveActor(signedIn.ctx, signedIn.sessionToken)).toBeNull();
  });

  it("does not let a tombstone sign back in on an outstanding link", async () => {
    const { delivery, links } = capturingDelivery();
    const anonymous = createContext(ctx.db, { deliverSignInLink: delivery });

    const signedIn = await signUp(ctx.db, { email: "vera@example.org", displayName: "Vera" });
    await requestSignIn(anonymous, { email: "vera@example.org" });
    await deleteParticipant(signedIn.ctx);

    await expect(consumeSignInToken(anonymous, { token: links[0]!.token })).rejects.toMatchObject({ code: "invalid" });
  });

  it("frees the email address, so the same person may start again as someone new", async () => {
    const first = await signUp(ctx.db, { email: "zoe@example.org", displayName: "Zoe" });
    await deleteParticipant(first.ctx);

    const second = await signUp(ctx.db, { email: "zoe@example.org", displayName: "Zoe again" });
    expect(second.participant.id).not.toBe(first.participant.id);
  });

  /** The service is not the only thing that can write to this table, so the invariant
   *  is a constraint. If this test ever fails, the tombstone has become a correlation
   *  handle regardless of what the service layer does. */
  it("is refused by the database if any attribute survives the erasure", async () => {
    const signedIn = await signUp(ctx.db, { email: "half@example.org", displayName: "Half" });

    await expect(
      ctx.db.execute(
        sql`update participants set tombstoned = true, email = null, display_name = null,
            verification_level = null, created_at = null, updated_at = null
            where id = ${signedIn.participant.id}`,
      ),
    ).resolves.toBeDefined();

    const stillThere = await signUp(ctx.db, { email: "other@example.org", displayName: "Other" });
    await expect(
      ctx.db.execute(
        sql`update participants set tombstoned = true where id = ${stillThere.participant.id}`,
      ),
    ).rejects.toThrow();
  });
});
