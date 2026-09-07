/**
 * Seed the Region table from the vendored extract.
 *
 *   npm run regions:seed
 *
 * Reaches no network and needs no third-party account: the extract is in the
 * repository (ADR-0012). Safe to run again after a version bump.
 */

import { createDatabase } from "../src/lib/db/client.js";
import { createContext } from "../src/lib/services/context.js";
import { seedRegions } from "../src/lib/services/regions.js";

const handle = await createDatabase();
try {
  await handle.migrate();
  const result = await seedRegions(createContext(handle.db));
  process.stdout.write(`seeded ${result.inserted} Regions at dataset version ${result.version}\n`);
} finally {
  await handle.close();
}
