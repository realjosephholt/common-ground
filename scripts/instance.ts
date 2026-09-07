/**
 * The Instance's long-running process.
 *
 * It applies migrations, seeds Regions from the vendored extract, and then keeps the
 * one scheduled job M0 has: archiving Conversations that attracted no Votes.
 *
 * There is deliberately no HTTP server here yet. Serving deliberation over HTTP is the
 * next milestone's work, and standing up an unused server now would be a surface to
 * secure with nothing behind it. What this container is for today is making an Instance
 * that an operator can start, migrate and seed with one command, and hand accounts to.
 */

import { createDatabase } from "../src/lib/db/client.js";
import { createContext } from "../src/lib/services/context.js";
import { seedRegions } from "../src/lib/services/regions.js";
import { archiveSilentConversations } from "../src/lib/services/votes.js";

const SWEEP_INTERVAL_MS = Number(process.env["SWEEP_INTERVAL_MS"] ?? 3_600_000);

const handle = await createDatabase();
const ctx = createContext(handle.db);

function log(message: string): void {
  process.stdout.write(`[common-ground] ${new Date().toISOString()} ${message}\n`);
}

// Migrations run on start so that upgrading an Instance never requires the operator to
// run database commands by hand.
log("applying migrations");
await handle.migrate();

log("seeding Regions from the vendored GeoNames extract");
const seeded = await seedRegions(ctx);
log(`Regions ready: ${seeded.inserted} at dataset version ${seeded.version}`);

async function sweep(): Promise<void> {
  try {
    const archived = await archiveSilentConversations(ctx);
    if (archived.length > 0) log(`archived ${archived.length} Conversation(s) that attracted no Votes`);
  } catch (error) {
    // A failed sweep must not take the Instance down: it is a tidying job, and the
    // next tick will try again.
    log(`sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await sweep();
const timer = setInterval(sweep, SWEEP_INTERVAL_MS);

async function shutdown(signal: string): Promise<void> {
  log(`${signal} received, shutting down`);
  clearInterval(timer);
  await handle.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

const cadence =
  SWEEP_INTERVAL_MS < 60_000
    ? `${Math.round(SWEEP_INTERVAL_MS / 1000)}s`
    : `${Math.round(SWEEP_INTERVAL_MS / 60_000)}m`;
log(`running; sweeping every ${cadence}`);
