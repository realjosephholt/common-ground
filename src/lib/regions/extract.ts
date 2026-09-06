/**
 * Reading the vendored GeoNames extract.
 *
 * Pure: it parses bytes into rows and knows nothing about the database, so the shape of
 * the dataset can be tested against a fixture without a database in sight.
 */

import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type RegionLevel = "country" | "admin1" | "admin2" | "admin3" | "admin4";

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
    rows.push({
      geonameId,
      name,
      asciiName: asciiName || name,
      countryCode,
      level: level as RegionLevel,
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
 */
export function parentKeyOf(row: RegionExtractRow): string | null {
  if (row.level === "country") return null;
  if (row.level === "admin1") return row.countryCode;
  return `${row.countryCode}.${row.admin1Code ?? ""}`;
}

export function keyOf(row: RegionExtractRow): string {
  if (row.level === "country") return row.countryCode;
  if (row.level === "admin1") return `${row.countryCode}.${row.admin1Code ?? ""}`;
  return `${row.countryCode}.${row.admin1Code ?? ""}.${row.admin2Code ?? ""}`;
}
