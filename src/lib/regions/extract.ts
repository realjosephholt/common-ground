/**
 * Reading the vendored GeoNames extract.
 *
 * Pure: it parses bytes into rows and knows nothing about the database, so the shape of
 * the dataset can be tested against a fixture without a database in sight.
 */

import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { REGION_LEVELS, type RegionLevel } from "../db/schema.js";

export type { RegionLevel };

export interface RegionExtractRow {
  geonameId: number;
  name: string;
  asciiName: string;
  countryCode: string;
  level: RegionLevel;
  /** Retained for parent resolution at seed time and for reconciliation. Never a key:
   *  the concatenated administrative codes are country-specific and get restructured,
   *  which is exactly why `geonameId` is the primary key (ADR-0012). */
  admin1Code: string | null;
  admin2Code: string | null;
}

const DATA_DIR = new URL("../../../data/geonames/", import.meta.url);

const EXPECTED_HEADER = "geoname_id\tname\tascii_name\tcountry_code\tlevel\tadmin1_code\tadmin2_code";

function isRegionLevel(value: string): value is RegionLevel {
  return (REGION_LEVELS as readonly string[]).includes(value);
}

export function parseRegionExtract(tsv: string): RegionExtractRow[] {
  const lines = tsv.split("\n");
  const header = lines[0]?.trim();
  if (header !== EXPECTED_HEADER) {
    throw new Error(`Unexpected Region extract header. Expected:\n${EXPECTED_HEADER}\nGot:\n${header}`);
  }

  const rows: RegionExtractRow[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const [id, name, asciiName, countryCode, level, admin1Code, admin2Code] = line.split("\t");
    const geonameId = Number(id);
    if (!Number.isInteger(geonameId) || !name || !countryCode || !level) continue;
    // Checked rather than cast. A level this format cannot express — a ward, a commune —
    // would otherwise be parented by `parentKeyOf` as though it were an admin2 and end
    // up under the wrong place entirely, silently.
    if (!isRegionLevel(level)) {
      throw new Error(
        `Region ${geonameId} has level "${level}", which this extract format cannot carry. ` +
          `Supported levels: ${REGION_LEVELS.join(", ")}.`,
      );
    }
    rows.push({
      geonameId,
      name,
      asciiName: asciiName || name,
      countryCode,
      level,
      admin1Code: admin1Code || null,
      admin2Code: admin2Code || null,
    });
  }
  return rows;
}

export function readVendoredExtract(): { rows: RegionExtractRow[]; version: string } {
  const gz = readFileSync(fileURLToPath(new URL("regions.tsv.gz", DATA_DIR)));
  const version = readFileSync(fileURLToPath(new URL("VERSION", DATA_DIR)), "utf8").trim();
  return { rows: parseRegionExtract(gunzipSync(gz).toString("utf8")), version };
}

/**
 * The key under which each row's parent should be found.
 *
 * Parents come from the administrative codes because that is the only linkage the small
 * extract carries — but they are resolved to a `geonameId` here and stored as one, so
 * nothing downstream ever holds `US.CA.001` as an identifier.
 *
 * Adding a level to `REGION_LEVELS` means adding its code column to the extract format
 * and a case here. Doing one without the other would give two levels the same key and
 * mis-parent every row at the deeper one, so the parser refuses levels it cannot key.
 */
export function parentKeyOf(row: RegionExtractRow): string | null {
  switch (row.level) {
    case "country":
      return null;
    case "admin1":
      return row.countryCode;
    case "admin2":
      return `${row.countryCode}.${row.admin1Code ?? ""}`;
  }
}

export function keyOf(row: RegionExtractRow): string {
  switch (row.level) {
    case "country":
      return row.countryCode;
    case "admin1":
      return `${row.countryCode}.${row.admin1Code ?? ""}`;
    case "admin2":
      return `${row.countryCode}.${row.admin1Code ?? ""}.${row.admin2Code ?? ""}`;
  }
}
