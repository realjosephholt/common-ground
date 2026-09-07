import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { queryRows } from "@/lib/db/client.js";
import { parseRegionExtract, readVendoredExtract } from "@/lib/regions/extract.js";
import { createContext } from "@/lib/services/context.js";
import { parseDeletesFeed, reconcileRegions, searchRegions, seedRegions } from "@/lib/services/regions.js";
import { setupTestDatabase } from "../helpers/db.js";
import { REGION_FIXTURE } from "../helpers/fixtures.js";

const ctx = setupTestDatabase();

function context() {
  return createContext(ctx.db);
}

describe("seeding Regions", () => {
  it("populates Regions with their parent relationships", async () => {
    const result = await seedRegions(context(), { rows: parseRegionExtract(REGION_FIXTURE), version: "fixture-1" });
    expect(result.inserted).toBe(6);

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
    const rows = parseRegionExtract(REGION_FIXTURE);
    await seedRegions(context(), { rows, version: "fixture-1" });
    await seedRegions(context(), { rows, version: "fixture-2" });

    const [count] = await queryRows<{ count: number }>(ctx.db, sql`select count(*)::int as count from regions`);
    expect(Number(count?.count)).toBe(6);
  });

  it("keys Regions on geonameId and never on the administrative codes", async () => {
    await seedRegions(context(), { rows: parseRegionExtract(REGION_FIXTURE), version: "fixture-1" });
    const [row] = await queryRows<{ geoname_id: number }>(
      ctx.db,
      sql`select geoname_id from regions where ascii_name = 'Springfield' and admin1_code = 'IL'`,
    );
    expect(row?.geoname_id).toBe(4250542);
  });
});

describe("finding a Region", () => {
  it("tells two identically-named places apart by their parent chain", async () => {
    await seedRegions(context(), { rows: parseRegionExtract(REGION_FIXTURE), version: "fixture-1" });

    const results = await searchRegions(context(), { query: "Springfield" });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.path).sort()).toEqual([
      "Springfield, Illinois, United States",
      "Springfield, Missouri, United States",
    ]);
    expect(results[0]!.parents.map((p) => p.name)).toHaveLength(2);
  });

  /** The parent chain is built with a recursive CTE, and the obvious way to reassemble
   *  it — group by the matched row's identifier — silently re-sorts results by
   *  geonameId and throws the relevance away. */
  it("puts an exact match first, ahead of longer names that merely start the same", async () => {
    await seedRegions(context(), { rows: parseRegionExtract(REGION_FIXTURE), version: "fixture-1" });

    const results = await searchRegions(context(), { query: "United States" });

    // "United States Minor Outlying Islands" has the lower geonameId of the two, so
    // reassembling the parent chains by grouping on that identifier would put it first.
    expect(results.map((r) => r.name)).toEqual([
      "United States",
      "United States Minor Outlying Islands",
    ]);
  });

  it("matches a prefix, case-insensitively", async () => {
    await seedRegions(context(), { rows: parseRegionExtract(REGION_FIXTURE), version: "fixture-1" });
    expect((await searchRegions(context(), { query: "illin" })).map((r) => r.name)).toEqual(["Illinois"]);
  });
});

describe("reconciling a dataset version bump", () => {
  it("reports references broken by a Region that upstream has retired", async () => {
    await seedRegions(context(), { rows: parseRegionExtract(REGION_FIXTURE), version: "fixture-1" });

    // Springfield, Illinois has been retired upstream, and something points at it.
    await ctx.db.execute(
      sql`insert into participants (id, email, display_name, verification_level, created_at, region_id)
          values ('01930000-0000-7000-8000-000000000001', 'x@example.org', 'X', 'email', now(), 4250542)`,
    );

    const report = await reconcileRegions(context(), {
      rows: parseRegionExtract(REGION_FIXTURE).filter((r) => r.geonameId !== 4250542),
      version: "fixture-2",
      deletedGeonameIds: [4250542],
    });

    expect(report.ok).toBe(false);
    expect(report.retired).toHaveLength(1);
    expect(report.retired[0]).toMatchObject({ geonameId: 4250542, name: "Springfield" });
    expect(report.retired[0]!.referencedBy).toMatchObject({ participants: 1, conversations: 0 });
  });

  it("passes when nothing references a retired Region", async () => {
    await seedRegions(context(), { rows: parseRegionExtract(REGION_FIXTURE), version: "fixture-1" });
    const report = await reconcileRegions(context(), {
      rows: parseRegionExtract(REGION_FIXTURE).filter((r) => r.geonameId !== 4409896),
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
