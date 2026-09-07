/**
 * Regions: seeding them, finding them, and noticing when upstream retires one.
 *
 * A Conversation's scope is a named administrative Region, because a Target's
 * jurisdiction follows administrative boundaries and because people organise around
 * places that have names (ADR-0007). The dataset is vendored, so none of this reaches
 * the network.
 */

import { sql } from "drizzle-orm";

import { queryRows } from "../db/client";
import { REGION_LEVELS, regions } from "../db/schema";
import {
  keyOf,
  parentKeyOf,
  readVendoredExtract,
  type RegionExtractRow,
  type RegionLevel,
} from "../regions/extract";
import type { ServiceContext } from "./context";

/** Countries first, then each administrative level in turn. Seeding in this order means
 *  a row's parent is always already present, so the self-referencing foreign key never
 *  has to be deferred. `REGION_LEVELS` is declared shallowest-first for exactly this. */
const LEVEL_ORDER: readonly RegionLevel[] = REGION_LEVELS;

const INSERT_CHUNK = 1000;

export interface SeedRegionsInput {
  /** Defaults to the vendored extract. Tests pass a fixture instead of the whole world. */
  rows?: RegionExtractRow[];
  version?: string;
}

export interface SeedRegionsResult {
  inserted: number;
  version: string;
}

/**
 * Load the extract into the Region table, parents first.
 *
 * Idempotent, because an operator will run it again after a version bump and should not
 * have to reason about whether that is safe.
 */
export async function seedRegions(ctx: ServiceContext, input: SeedRegionsInput = {}): Promise<SeedRegionsResult> {
  const source = input.rows ? { rows: input.rows, version: input.version ?? "unversioned" } : readVendoredExtract();
  const version = input.version ?? source.version;

  // Administrative codes resolve a parent here and are then done with: what gets stored
  // is a geonameId, so nothing downstream ever holds `US.IL.167` as an identifier.
  const idByKey = new Map<string, number>();
  for (const row of source.rows) idByKey.set(keyOf(row), row.geonameId);

  let inserted = 0;
  for (const level of LEVEL_ORDER) {
    const atLevel = source.rows.filter((row) => row.level === level);
    for (let i = 0; i < atLevel.length; i += INSERT_CHUNK) {
      const chunk = atLevel.slice(i, i + INSERT_CHUNK).map((row) => {
        const parentKey = parentKeyOf(row);
        return {
          geonameId: row.geonameId,
          name: row.name,
          asciiName: row.asciiName,
          countryCode: row.countryCode,
          level: row.level,
          parentId: (parentKey ? idByKey.get(parentKey) : null) ?? null,
          admin1Code: row.admin1Code,
          admin2Code: row.admin2Code,
          datasetVersion: version,
        };
      });

      await ctx.db
        .insert(regions)
        .values(chunk)
        .onConflictDoUpdate({
          target: regions.geonameId,
          set: {
            name: sql`excluded.name`,
            asciiName: sql`excluded.ascii_name`,
            countryCode: sql`excluded.country_code`,
            level: sql`excluded.level`,
            parentId: sql`excluded.parent_id`,
            admin1Code: sql`excluded.admin1_code`,
            admin2Code: sql`excluded.admin2_code`,
            datasetVersion: sql`excluded.dataset_version`,
          },
        });
      inserted += chunk.length;
    }
  }

  return { inserted, version };
}

export interface RegionAncestor {
  geonameId: number;
  name: string;
  level: string;
}

export interface RegionSearchResult {
  geonameId: number;
  name: string;
  level: string;
  countryCode: string;
  /** Immediate parent first, outwards. */
  parents: RegionAncestor[];
  /** The whole chain as one string, which is what makes two Springfields tellable
   *  apart at a glance. */
  path: string;
}

interface ChainRow {
  root: number;
  rank: number;
  geoname_id: number;
  name: string;
  level: string;
  country_code: string;
  depth: number;
}

/**
 * Find Regions by name, each with its parent chain.
 *
 * The chain is the point, not decoration. There is more than one Springfield, and a
 * Participant choosing the wrong one scopes their Conversation to a place whose Target
 * has no authority over anything they care about.
 */
export async function searchRegions(
  ctx: ServiceContext,
  input: { query: string; limit?: number },
): Promise<RegionSearchResult[]> {
  const term = input.query.trim();
  if (!term) return [];
  const limit = Math.min(input.limit ?? 20, 100);
  const prefix = `${term}%`;

  const rows = await queryRows<ChainRow>(
    ctx.db,
    sql`
      with recursive matched as (
        select geoname_id,
               row_number() over (
                 order by (lower(ascii_name) = lower(${term})) desc, length(name), name
               ) as rank
        from regions
        where ascii_name ilike ${prefix} or name ilike ${prefix}
        order by rank
        limit ${limit}
      ),
      chain as (
        select m.geoname_id as root, m.rank, r.geoname_id, r.name, r.level, r.country_code, 0 as depth, r.parent_id
        from matched m
        join regions r on r.geoname_id = m.geoname_id
        union all
        select c.root, c.rank, p.geoname_id, p.name, p.level, p.country_code, c.depth + 1, p.parent_id
        from chain c
        join regions p on p.geoname_id = c.parent_id
      )
      -- Ordered by rank, not by root: grouping on the identifier would sort results by
      -- geonameId and throw away the relevance the CTE just computed.
      select root, rank, geoname_id, name, level, country_code, depth from chain order by rank, depth
    `,
  );

  // Insertion order is the ranked order, and a Map preserves it.
  const byRoot = new Map<number, ChainRow[]>();
  for (const row of rows) {
    const bucket = byRoot.get(row.root);
    if (bucket) bucket.push(row);
    else byRoot.set(row.root, [row]);
  }

  const results: RegionSearchResult[] = [];
  for (const chain of byRoot.values()) {
    const [self, ...ancestors] = chain;
    if (!self) continue;
    results.push({
      geonameId: self.geoname_id,
      name: self.name,
      level: self.level,
      countryCode: self.country_code,
      parents: ancestors.map((a) => ({ geonameId: a.geoname_id, name: a.name, level: a.level })),
      path: [self.name, ...ancestors.map((a) => a.name)].join(", "),
    });
  }
  return results;
}

/** GeoNames publishes `deletes-YYYY-MM-DD.txt` as `geonameId<TAB>name<TAB>reason`. */
export function parseDeletesFeed(text: string): number[] {
  const ids: number[] = [];
  for (const line of text.split("\n")) {
    const id = Number(line.split("\t")[0]);
    if (Number.isInteger(id) && id > 0) ids.push(id);
  }
  return ids;
}

export interface RetiredRegion {
  geonameId: number;
  name: string;
  level: string;
  referencedBy: { participants: number; conversations: number };
}

export interface ReconciliationReport {
  fromVersion: string | null;
  toVersion: string;
  /** Regions this Instance holds that the new extract no longer does. */
  retired: RetiredRegion[];
  /** True when nothing an Instance actually uses was retired. */
  ok: boolean;
}

/**
 * Check a dataset version bump before it breaks something.
 *
 * GeoNames retires identifiers — merges duplicates, restructures a country's
 * administrative tree — and a Region that vanishes underneath a Conversation is a
 * foreign key nobody notices until an organiser cannot open their own Conversation.
 * This reports; it never deletes. Deciding what a Conversation scoped to a retired
 * county should become is a judgement, not a migration.
 */
export async function reconcileRegions(
  ctx: ServiceContext,
  input: { rows?: RegionExtractRow[]; version?: string; deletedGeonameIds?: number[] } = {},
): Promise<ReconciliationReport> {
  const source = input.rows ? { rows: input.rows, version: input.version ?? "unversioned" } : readVendoredExtract();
  const toVersion = input.version ?? source.version;

  const incoming = new Set(source.rows.map((row) => row.geonameId));
  for (const id of input.deletedGeonameIds ?? []) incoming.delete(id);

  const held = await queryRows<{ geoname_id: number; name: string; level: string; dataset_version: string }>(
    ctx.db,
    sql`select geoname_id, name, level, dataset_version from regions`,
  );

  const missing = held.filter((row) => !incoming.has(row.geoname_id));
  const retired: RetiredRegion[] = [];

  for (const row of missing) {
    const [counts] = await queryRows<{ participants: number; conversations: number }>(
      ctx.db,
      sql`select
            (select count(*)::int from participants where region_id = ${row.geoname_id}) as participants,
            (select count(*)::int from conversations where region_id = ${row.geoname_id}) as conversations`,
    );
    retired.push({
      geonameId: row.geoname_id,
      name: row.name,
      level: row.level,
      referencedBy: {
        participants: Number(counts?.participants ?? 0),
        conversations: Number(counts?.conversations ?? 0),
      },
    });
  }

  return {
    fromVersion: held[0]?.dataset_version ?? null,
    toVersion,
    retired,
    ok: retired.every((r) => r.referencedBy.participants === 0 && r.referencedBy.conversations === 0),
  };
}
