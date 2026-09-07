import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach } from "vitest";

import { createDatabase, type Database, type DatabaseBackend } from "@/lib/db/client";
import { schema } from "@/lib/db/schema";

/**
 * A migrated database per test file, emptied between tests.
 *
 * The obvious implementation — a brand-new database per test — costs ~650ms of PGlite
 * boot each time, which turns a suite this size into a minute of waiting and makes
 * people stop running it. Truncating gives the same isolation for the price of one
 * statement, and the migration still runs from the checked-in SQL rather than from the
 * schema module, so a migration that does not match the schema fails here.
 */
export interface TestDatabase {
  db: Database;
  backend: DatabaseBackend;
}

const TABLES = Object.values(schema).map((table) => {
  const name = (table as unknown as { [k: symbol]: string })[Symbol.for("drizzle:Name")];
  return `"${name}"`;
});

export function setupTestDatabase(): TestDatabase {
  // Populated in beforeAll. Tests only ever touch it inside a test body, by which time
  // it is real; the cast keeps every call site free of `!`.
  const handle = {} as TestDatabase;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const created = await createDatabase();
    await created.migrate();
    handle.db = created.db;
    handle.backend = created.backend;
    close = created.close;
  }, 60_000);

  beforeEach(async () => {
    await handle.db.execute(sql.raw(`truncate table ${TABLES.join(", ")} restart identity cascade`));
  });

  afterAll(async () => {
    await close?.();
  });

  return handle;
}
