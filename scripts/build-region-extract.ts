/**
 * Rebuild the vendored GeoNames Region extract.
 *
 * This is a maintenance tool, not part of running an Instance: it is the only thing in
 * the repository that reaches the network, and it does so on a maintainer's machine so
 * that operators and contributors never have to (ADR-0012).
 *
 *   node scripts/build-region-extract.ts
 *
 * It writes `data/geonames/regions.tsv.gz` and `data/geonames/VERSION`. Review the diff
 * before committing: a version bump can delete Regions that Conversations point at, and
 * `npm run regions:reconcile` is what tells you which.
 */

import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCES = {
  countries: "https://download.geonames.org/export/dump/countryInfo.txt",
  admin1: "https://download.geonames.org/export/dump/admin1CodesASCII.txt",
  admin2: "https://download.geonames.org/export/dump/admin2Codes.txt",
};

const OUT_DIR = fileURLToPath(new URL("../data/geonames/", import.meta.url));

async function fetchText(url: string): Promise<{ body: string; lastModified: string | null }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return { body: await response.text(), lastModified: response.headers.get("last-modified") };
}

function main(): Promise<void> {
  return (async () => {
    const [countries, admin1, admin2] = await Promise.all([
      fetchText(SOURCES.countries),
      fetchText(SOURCES.admin1),
      fetchText(SOURCES.admin2),
    ]);

    const rows: string[] = [];

    for (const line of countries.body.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const f = line.split("\t");
      const [iso, , , , name] = f;
      const geonameId = f[16];
      if (!iso || !name || !geonameId) continue;
      rows.push([geonameId, name, name, iso, "country", "", ""].join("\t"));
    }

    for (const [level, source] of [
      ["admin1", admin1.body],
      ["admin2", admin2.body],
    ] as const) {
      for (const line of source.split("\n")) {
        if (!line) continue;
        const [code, name, asciiName, geonameId] = line.split("\t");
        if (!code || !name || !geonameId) continue;
        const [country = "", a1 = "", a2 = ""] = code.split(".");
        rows.push([geonameId, name, asciiName ?? name, country, level, a1, a2].join("\t"));
      }
    }

    const header = "geoname_id\tname\tascii_name\tcountry_code\tlevel\tadmin1_code\tadmin2_code";
    const version = (admin2.lastModified ?? new Date().toUTCString()).trim();

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}regions.tsv.gz`, gzipSync(`${header}\n${rows.join("\n")}\n`, { level: 9 }));
    writeFileSync(`${OUT_DIR}VERSION`, `${version}\n`);
    process.stdout.write(`wrote ${rows.length} Regions at dataset version ${version}\n`);
  })();
}

await main();
