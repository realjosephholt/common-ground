import { contextFromCookies } from "@/web/session";
import { database } from "@/web/db";

export default async function Home() {
  const { cookies } = await import("next/headers");
  const jar = await cookies();
  const ctx = await contextFromCookies(
    await database(),
    Object.fromEntries((await jar.getAll()).map((c) => [c.name, c.value])),
  );

  return (
    <>
      <h1>Common Ground</h1>
      <p>
        Finding causes with enough genuinely shared support that collective action is possible, and then
        organising that action.
      </p>
      {ctx.actor ? (
        <p>
          You are signed in. <a href="/conversations">Find a Conversation</a>.
        </p>
      ) : (
        <p>
          <a href="/sign-in">Sign in</a> to take part. No password — a link is emailed to you.
        </p>
      )}
    </>
  );
}
