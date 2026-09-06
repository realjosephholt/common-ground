import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { queryRows } from "@/lib/db/client.js";
import { parseRegionExtract, readVendoredExtract } from "@/lib/regions/extract.js";
import { createContext } from "@/lib/services/context.js";
import { parseDeletesFeed, reconcileRegions, searchRegions, seedRegions } from "@/lib/services/regions.js";
import { setupTestDatabase } from "../helpers/db.js";

const ctx = setupTestDatabase();

/**
 * A fixture rather than the 51,710-row vendored extract: seeding the whole world into
 * every test would make the suite slow enough that people stop running it, and the two
 * Springfields prove the disambiguation more legibly than a real pair would.
 */
const FIXTURE = [
  "geoname_id\tname\tascii_name\tcountry_code\tlevel\tadmin1_code\tadmin2_code",
  "6252001\tUnited States\tUnited States\tUS\tcountry\t\t",
  "4896861\tIllinois\tIllinois\tUS\tadmin1\tIL\t",
  "4398678\tMissouri\tMissouri\tUS\tadmin1\tMO\t",
  "4250542\tSpringfield\tSpringfield\tUS\tadmin2\tIL\t167",
  "4409896\tSpringfield\tSpringfield\tUS\tadmin2\tMO\t077",
].join("\n");

function context() {
  return createContext(ctx.db);
}

describe("seeding Regions", () => {
  it("populates Regions with their parent relationships", async () => {
    const result = await seedRegions(context(), { rows: parseRegionExtract(FIXTURE), version: "fixture-1" });
    expect(result.inserted).toBe(5);

    const rows = await queryRows<{ name: string; parent: string | null }>(
      ctx.db,
      sql`select child.name, parent.name as parent
          from regions child left join regions parent on parent.geoname_id = child.parent_id
          order by child.geoname_id`,
    );
    expect(rows).toContainEqual({ name: "Illinois", parent: "United States" });
    expect(rows).toContainEqual({ name: "United States", parent: null });
    expect(rows.filter((r) => r.name === "Springfield").map((r) => r.parent).sort()).toEqual(["Illinois", "Missouri"]);
  });

  it("is safe to run twice", async () => {
    const rows = parseRegionExtract(FIXTURE);
    await seedRegions(context(), { rows, version: "fixture-1" });
    await seedRegions(context(), { rows, version: "fixture-2" });

    const [count] = await queryRows<{ count: number }>(ctx.db, sql`select count(*)::int as count from regions`);
    expect(Number(count?.count)).toBe(5);
  });

  it("keys Regions on geonameId and never on the administrative codes", async () => {
    await seedRegions(context(), { rows: parseRegionExtract(FIXTURE), version: "fixture-1" });
    const [row] = await queryRows<{ geoname_id: number }>(
      ctx.db,
      sql`select geoname_id from regions where ascii_name = 'Springfield' and admin1_code = 'IL'`,
    );
    expect(row?.geoname_id).toBe(4250542);
  });
});

describe("finding a Region", () => {
  it("tells two identically-named places apart by their parent chain", async () => {
    await seedRegions(context(), { rows: parseRegionExtract(FIXTURE), version: "fixture-1" });

    const results = await searchRegions(context(), { query: "Springfield" });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.path).sort()).toEqual([
      "Springfield, Illinois, United States",
      "Springfield, Missouri, United States",
    ]);
    expect(results[0]!.parents.map((p) => p.name)).toHaveLength(2);
  });

  it("matches a prefix, case-insensitively", async () => {
    await seedRegions(context(), { rows: parseRegionExtract(FIXTURE), version: "fixture-1" });
    expect((await searchRegions(context(), { query: "illin" })).map((r) => r.name)).toEqual(["Illinois"]);
  });
});

describe("reconciling a dataset version bump", () => {
  it("reports references broken by a Region that upstream has retired", async () => {
    await seedRegions(context(), { rows: parseRegionExtract(FIXTURE), version: "fixture-1" });

    // Springfield, Illinois has been retired upstream, and something points at it.
    await ctx.db.execute(
      sql`insert into participants (id, email, display_name, verification_level, created_at, region_id)
          values ('01930000-0000-7000-8000-000000000001', 'x@example.org', 'X', 'email', now(), 4250542)`,
    );

    const report = await reconcileRegions(context(), {
      rows: parseRegionExtract(FIXTURE).filter((r) => r.geonameId !== 4250542),
      version: "fixture-2",
      deletedGeonameIds: [4250542],
    });

    expect(report.ok).toBe(false);
    expect(report.retired).toHaveLength(1);
    expect(report.retired[0]).toMatchObject({ geonameId: 4250542, name: "Springfield" });
    expect(report.retired[0]!.referencedBy).toMatchObject({ participants: 1, conversations: 0 });
  });

  it("passes when nothing references a retired Region", async () => {
    await seedRegions(context(), { rows: parseRegionExtract(FIXTURE), version: "fixture-1" });
    const report = await reconcileRegions(context(), {
      rows: parseRegionExtract(FIXTURE).filter((r) => r.geonameId !== 4409896),
      version: "fixture-2",
      deletedGeonameIds: [4409896],
    });
    expect(report.ok).toBe(true);
  });

  it("reads the published deletes feed format", () => {
    const feed = "4250542\tSpringfield\tduplicate\n4409896\tSpringfield\tmoved to 123\n";
    expect(parseDeletesFeed(feed)).toEqual([4250542, 4409896]);
  });
});

describe("the vendored extract", () => {
  it("is present in the repository and parses without touching the network", () => {
    const { rows, version } = readVendoredExtract();
    expect(rows.length).toBeGreaterThan(10_000);
    expect(version).not.toBe("");
    expect(rows.some((r) => r.asciiName === "Travis County" && r.countryCode === "US")).toBe(true);
  });
});
