/**
 * The Instance's database handle, created once.
 *
 * Next.js re-evaluates modules across requests in development, and a fresh connection
 * pool per request would exhaust Postgres in about a minute. The handle is cached on
 * `globalThis` rather than in a module variable for the same reason: module state does
 * not survive a hot reload, and the pool it was holding leaks.
 *
 * This is the only module the app is allowed to reach the database through, which is
 * what lets `tests/unit/architecture.test.ts` assert that no page or route handler talks
 * to the database directly instead of going through a service.
 */

import { createDatabase, type Database, type DatabaseHandle } from "../lib/db/client";

const CACHE = Symbol.for("common-ground.database");

type Global = typeof globalThis & { [CACHE]?: Promise<DatabaseHandle> };

function handle(): Promise<DatabaseHandle> {
  const cache = globalThis as Global;
  cache[CACHE] ??= createDatabase();
  return cache[CACHE];
}

export async function database(): Promise<Database> {
  return (await handle()).db;
}
