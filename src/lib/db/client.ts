/**
 * The database handle, in two backends behind one type.
 *
 * A contributor runs the whole suite against real Postgres compiled to WASM, in
 * process, with no Docker and no installed database; CI runs the identical suite
 * against Postgres 16 and is authoritative. PGlite is not byte-identical to server
 * Postgres, so the point of running both is that a divergence surfaces on the pull
 * request rather than in production.
 *
 * Service code never learns which backend it got.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { schema } from "./schema";

/** The type every service takes. Deliberately the shared Drizzle base class rather
 *  than either driver's concrete type, so that no service can accidentally depend on
 *  a driver-specific method and quietly stop working on the other backend. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DatabaseBackend = "pglite" | "postgres";

export interface DatabaseConfig {
  /** Defaults to `postgres` when a connection URL is present, `pglite` otherwise. */
  backend?: DatabaseBackend;
  /** Postgres connection string. Ignored by the PGlite backend. */
  url?: string | undefined;
  /** PGlite data directory. Omit for an ephemeral in-memory instance. */
  dataDir?: string | undefined;
}

export interface DatabaseHandle {
  db: Database;
  backend: DatabaseBackend;
  /** Apply every checked-in migration that has not yet run. */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

/** Built from the directory rather than with `new URL(..., import.meta.url)`: bundlers
 *  read that idiom as a static asset reference and try to resolve `./migrations` as a
 *  module, which it is not — it is a directory of SQL read at runtime. */
const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export function resolveBackend(config: DatabaseConfig = {}): DatabaseBackend {
  if (config.backend) return config.backend;
  const url = config.url ?? process.env["DATABASE_URL"];
  return url ? "postgres" : "pglite";
}

export async function createDatabase(config: DatabaseConfig = {}): Promise<DatabaseHandle> {
  const backend = resolveBackend(config);
  return backend === "postgres" ? createPostgres(config) : createPglite(config);
}

async function createPglite(config: DatabaseConfig): Promise<DatabaseHandle> {
  const [{ PGlite }, { drizzle }, { migrate }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
    import("drizzle-orm/pglite/migrator"),
  ]);

  // With no directory this is an ephemeral in-process database, which is what tests
  // want and what a script almost never does — hence PGLITE_DATA_DIR.
  const dataDir = config.dataDir ?? process.env["PGLITE_DATA_DIR"];
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  const db = drizzle(client, { schema });

  return {
    db: db as unknown as Database,
    backend: "pglite",
    migrate: () => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: () => client.close(),
  };
}

async function createPostgres(config: DatabaseConfig): Promise<DatabaseHandle> {
  const url = config.url ?? process.env["DATABASE_URL"];
  if (!url) throw new Error("The postgres backend needs a connection URL (DATABASE_URL).");

  const [{ default: postgres }, { drizzle }, { migrate }] = await Promise.all([
    import("postgres"),
    import("drizzle-orm/postgres-js"),
    import("drizzle-orm/postgres-js/migrator"),
  ]);

  // `max: 1` for the migrator's benefit; the pool is widened by the caller that owns
  // a long-lived server process, not by the test harness.
  const client = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(client, { schema });

  return {
    db: db as unknown as Database,
    backend: "postgres",
    migrate: () => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: () => client.end({ timeout: 5 }),
  };
}

/**
 * Run a raw statement and get plain rows back, whichever backend is underneath.
 *
 * The two drivers genuinely disagree here: PGlite's `execute` resolves to
 * `{ rows: [...] }` and postgres-js resolves to the row array itself. This is exactly
 * the class of divergence the dual-backend arrangement exists to catch, and normalising
 * it in one place is cheaper than every caller discovering it separately.
 */
export async function queryRows<T>(db: Database, statement: SQL): Promise<T[]> {
  const result: unknown = await db.execute(statement);
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}
