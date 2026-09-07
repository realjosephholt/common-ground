/**
 * The session cookie, and turning a request into a `ServiceContext`.
 *
 * The web layer holds one piece of state about a signed-in person: the token the
 * service layer already issued. It stores no copy of who they are, because a second
 * record of someone's identity is a second record that can be wrong, and the one that
 * goes stale is always the copy.
 */

import type { Database } from "../lib/db/client";
import { resolveActor } from "../lib/services/auth";
import { createContext, type ServiceContext } from "../lib/services/context";

export const SESSION_COOKIE = "cg_session";

export interface CookieOptions {
  name: string;
  value: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  path: string;
  expires?: Date;
  maxAge?: number;
}

/**
 * `HttpOnly` because this token is a bearer credential for someone's political
 * association, and a cookie readable by script is one an injected script can take.
 * `SameSite=Lax` so a form on another site cannot vote on someone's behalf, while an
 * ordinary link into the Instance still arrives signed in — which matters, because the
 * sign-in link is exactly such a link.
 */
export function sessionCookie(token: string, expiresAt: Date): CookieOptions {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  };
}

/** Expired rather than simply not sent: a cookie that is merely absent from a response
 *  stays in the browser. */
export function clearedSessionCookie(): CookieOptions {
  return {
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  };
}

/**
 * Build the context every service call takes.
 *
 * An unrecognised, expired or revoked token yields a signed-out context rather than an
 * error. Whether someone may do a thing is the service layer's question, and answering
 * it here would put the same rule in two places.
 */
export async function contextFromCookies(
  db: Database,
  cookies: Record<string, string | undefined>,
): Promise<ServiceContext> {
  const anonymous = createContext(db);
  const actor = await resolveActor(anonymous, cookies[SESSION_COOKIE]);
  return createContext(db, { actor });
}
