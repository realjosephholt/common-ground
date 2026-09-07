import { describe, expect, it } from "vitest";

import { ServiceError } from "@/lib/services/context";
import { SESSION_COOKIE, contextFromCookies, sessionCookie, clearedSessionCookie } from "@/web/session";
import { httpStatusFor, presentServiceError } from "@/web/errors";
import { setupTestDatabase } from "../helpers/db";
import { signUp } from "../helpers/fixtures";

const ctx = setupTestDatabase();

describe("turning a request into a ServiceContext", () => {
  it("resolves the acting Participant from the session cookie", async () => {
    const signedIn = await signUp(ctx.db, { email: "seam@example.org", displayName: "Seam" });

    const context = await contextFromCookies(ctx.db, { [SESSION_COOKIE]: signedIn.sessionToken });

    expect(context.actor).toMatchObject({ id: signedIn.participant.id, verificationLevel: "email" });
  });

  it("yields a signed-out context when there is no cookie", async () => {
    expect((await contextFromCookies(ctx.db, {})).actor).toBeNull();
  });

  it("yields a signed-out context for a token that is not a session", async () => {
    expect((await contextFromCookies(ctx.db, { [SESSION_COOKIE]: "not-a-token" })).actor).toBeNull();
  });
});

describe("the session cookie", () => {
  /** A cookie readable by script is a cookie an injected script can exfiltrate, and this
   *  one is a bearer token for someone's political association. */
  it("is HttpOnly, Secure and SameSite", () => {
    const cookie = sessionCookie("a-token", new Date("2026-10-01T00:00:00Z"));

    expect(cookie.httpOnly).toBe(true);
    expect(cookie.secure).toBe(true);
    expect(cookie.sameSite).toBe("lax");
    expect(cookie.path).toBe("/");
  });

  it("clears by expiring rather than by being dropped", () => {
    const cleared = clearedSessionCookie();
    expect(cleared.value).toBe("");
    expect(cleared.maxAge).toBe(0);
  });
});

describe("presenting a ServiceError", () => {
  it("maps every code to a status", () => {
    const codes = ["unauthenticated", "forbidden", "not_found", "invalid", "conflict", "rate_limited"] as const;
    expect(codes.map((code) => httpStatusFor(code))).toEqual([401, 403, 404, 400, 409, 429]);
  });

  /** The service layer writes its messages for people, so they are shown rather than
   *  replaced with something vaguer. */
  it("keeps the service's own sentence", () => {
    const presented = presentServiceError(new ServiceError("forbidden", "Opening a Conversation needs vouched."));
    expect(presented).toEqual({ status: 403, code: "forbidden", message: "Opening a Conversation needs vouched." });
  });

  /** An unexpected error must not leak a stack trace or a query to a visitor. */
  it("does not pass an unknown error's message through", () => {
    const presented = presentServiceError(new Error("connection to 10.0.0.4 refused: password authentication"));

    expect(presented.status).toBe(500);
    expect(presented.message).not.toContain("10.0.0.4");
    expect(presented.message).not.toContain("password");
  });
});
