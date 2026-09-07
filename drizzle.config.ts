import { defineConfig } from "drizzle-kit";

/** Migrations are generated here and checked into the repo. Nothing generates them at
 *  runtime: an Instance applies the SQL that was reviewed, not SQL derived on the spot
 *  from whatever the schema module happens to say today. */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./src/lib/db/migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost:5432/common_ground" },
});
