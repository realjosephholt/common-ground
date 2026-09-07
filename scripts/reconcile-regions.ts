/**
 * Report what a Region dataset version bump would break.
 *
 *   npm run regions:reconcile [-- path/to/deletes-2026-09-06.txt]
 *
 * Run this after `npm run regions:build` and before committing the new extract.
 * GeoNames retires identifiers, and a Region that vanishes underneath a Conversation
 * is a foreign key nobody notices until an organiser cannot open their own
 * Conversation. Exits non-zero when something an Instance uses was retired.
 */

import { readFileSync } from "node:fs";

import { createDatabase } from "../src/lib/db/client.js";
import { createContext } from "../src/lib/services/context.js";
import { parseDeletesFeed, reconcileRegions } from "../src/lib/services/regions.js";

const deletesFile = process.argv[2];
const deletedGeonameIds = deletesFile ? parseDeletesFeed(readFileSync(deletesFile, "utf8")) : [];

const handle = await createDatabase();
try {
  await handle.migrate();
  const report = await reconcileRegions(createContext(handle.db), { deletedGeonameIds });
  process.stdout.write(`dataset ${report.fromVersion ?? "(empty)"} -> ${report.toVersion}\n`);

  if (report.retired.length === 0) {
    process.stdout.write("no Regions retired\n");
  }
  for (const region of report.retired) {
    const { participants, conversations } = region.referencedBy;
    process.stdout.write(
      `retired ${region.geonameId} ${region.name} (${region.level}) — ` +
        `${conversations} Conversation(s), ${participants} Participant(s)\n`,
    );
  }

  if (!report.ok) {
    process.stderr.write("\nSomething in use points at a retired Region. Resolve these before bumping.\n");
    process.exitCode = 1;
  }
} finally {
  await handle.close();
}
