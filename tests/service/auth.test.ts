import { describe, expect, it } from "vitest";

import { createContext, ServiceError, type LinkDelivery, type SignInLink } from "@/lib/services/context.js";
import { consumeSignInToken, endSession, resolveActor, requestSignIn } from "@/lib/services/auth.js";
import { setupTestDatabase } from "../helpers/db.js";

const ctx = setupTestDatabase();

function capturingDelivery(): { delivery: LinkDelivery; links: SignInLink[] } {
  const links: SignInLink[] = [];
  return { links, delivery: { deliver: (link) => void links.push(link) } };
}

describe("magic-link sign-in", () => {
  it("authenticates a link exactly once and rejects the reuse", async () => {
    const { delivery, links } = capturingDelivery();
    const context = createContext(ctx.db, { deliverSignInLink: delivery });

    await requestSignIn(context, { email: "ada@example.org", displayName: "Ada" });
    const token = links[0]!.token;

    const session = await consumeSignInToken(context, { token });
    expect(session.participant.displayName).toBe("Ada");

    await expect(consumeSignInToken(context, { token })).rejects.toMatchObject({ code: "invalid" });
  });

  it("rejects a link that has expired", async () => {
    const { delivery, links } = capturingDelivery();
    let clock = new Date("2026-03-01T10:00:00Z");
    const context = createContext(ctx.db, { deliverSignInLink: delivery, now: () => clock });

    await requestSignIn(context, { email: "grace@example.org", displayName: "Grace" });
    clock = new Date("2026-03-01T11:00:00Z");

    await expect(consumeSignInToken(context, { token: links[0]!.token })).rejects.toBeInstanceOf(ServiceError);
  });

  it("establishes a session that can be ended", async () => {
    const { delivery, links } = capturingDelivery();
    const context = createContext(ctx.db, { deliverSignInLink: delivery });

    await requestSignIn(context, { email: "linus@example.org", displayName: "Linus" });
    const { sessionToken, participant } = await consumeSignInToken(context, { token: links[0]!.token });

    expect(await resolveActor(context, sessionToken)).toMatchObject({ id: participant.id });
    await endSession(context, { sessionToken });
    expect(await resolveActor(context, sessionToken)).toBeNull();
  });
});

describe("link delivery", () => {
  it("defaults to writing the link to stdout, so an operator needs no mail server", async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await requestSignIn(createContext(ctx.db), { email: "op@example.org", displayName: "Operator" });
    } finally {
      process.stdout.write = original;
    }

    expect(written.join("")).toContain("sign-in link for op@example.org");
  });
});
