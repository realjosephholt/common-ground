import type { ReactNode } from "react";

import { SESSION_COOKIE } from "@/web/session";
import "./globals.css";

export const metadata = {
  title: "Common Ground",
  description: "Find causes with enough shared support to act on — then organise the action.",
};

/** Every service call reads live rows, and a cached page would show one Participant
 *  another's view of a Conversation. */
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { cookies } = await import("next/headers");
  const signedIn = (await cookies()).has(SESSION_COOKIE);

  return (
    <html lang="en">
      <body>
        <header className="site">
          <nav>
            <a className="name" href="/">
              Common Ground
            </a>
            <a href="/conversations">Conversations</a>
            <a href="/moderation-log">Moderation Log</a>
            <span className="spacer" />
            {signedIn ? (
              // A real form, so signing out works with no JavaScript — and a POST, so a
              // link someone is tricked into following cannot sign them out.
              <form action="/sign-out" method="post">
                <button type="submit">Sign out</button>
              </form>
            ) : (
              <a href="/sign-in">Sign in</a>
            )}
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
