/**
 * Root the vouching graph.
 *
 *   npm run instance:verify -- someone@example.org
 *
 * Without at least one `verified` Participant nobody is vouched-or-better, so nobody can
 * ever be promoted and the Instance is unusable. The person must have signed in at least
 * once first, because a Participant is created by consuming a sign-in link rather than
 * by an operator conjuring one.
 *
 * `verified` is conferred here and nowhere else. Vouching tops out at `vouched`, so this
 * is the only path to the level that moderates.
 */

import { createDatabase } from "../src/lib/db/client.js";
import { createContext } from "../src/lib/services/context.js";
import { designateVerified, listVerifiedParticipants } from "../src/lib/services/instance.js";

const emails = process.argv.slice(2).filter((argument) => argument.includes("@"));

const handle = await createDatabase();
try {
  await handle.migrate();
  const ctx = createContext(handle.db);

  if (emails.length === 0) {
    const existing = await listVerifiedParticipants(ctx);
    process.stdout.write(
      existing.length === 0
        ? "No verified Participants yet. Pass one or more email addresses to designate them.\n"
        : `verified: ${existing.map((p) => `${p.displayName} <${p.email}>`).join(", ")}\n`,
    );
  }

  for (const email of emails) {
    const participant = await designateVerified(ctx, { email });
    process.stdout.write(`verified ${participant.displayName} <${participant.email}>\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await handle.close();
}
