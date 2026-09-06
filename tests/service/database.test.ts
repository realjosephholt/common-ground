import { sql } from "drizzle-orm";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { queryRows, resolveBackend } from "@/lib/db/client.js";
import { schema } from "@/lib/db/schema.js";
import { setupTestDatabase } from "../helpers/db.js";

const ctx = setupTestDatabase();

describe("database foundation", () => {
  it("selects the backend from configuration, defaulting to the one that needs no install", () => {
    expect(resolveBackend({ backend: "postgres" })).toBe("postgres");
    expect(resolveBackend({ url: "postgres://localhost/cg" })).toBe("postgres");
    expect(resolveBackend({ backend: "pglite", url: "postgres://localhost/cg" })).toBe("pglite");
  });

  it("applies the checked-in migrations", async () => {
    const applied = await queryRows<{ count: number }>(
      ctx.db,
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );
    expect(Number(applied[0]?.count ?? 0)).toBeGreaterThan(0);
  });

  /**
   * The migrations are hand-extended (the Moderation Log's append-only trigger is not
   * expressible in the schema module), so the two can drift. This test is what makes
   * that drift a failure here instead of a mystery in production.
   */
  it("produces a database matching every table and column the schema module declares", async () => {
    const live = await queryRows<{ table_name: string; column_name: string }>(
      ctx.db,
      sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`,
    );
    const actual = new Set(live.map((r) => `${r.table_name}.${r.column_name}`));

    const expected: string[] = [];
    for (const table of Object.values(schema) as PgTable[]) {
      const name = getTableName(table);
      for (const column of Object.values(getTableColumns(table))) expected.push(`${name}.${column.name}`);
    }

    expect(expected.filter((c) => !actual.has(c))).toEqual([]);
  });

  it("hands each test an empty database", async () => {
    const rows = await queryRows<{ count: number }>(ctx.db, sql`select count(*)::int as count from participants`);
    expect(Number(rows[0]?.count ?? 0)).toBe(0);
  });
});
