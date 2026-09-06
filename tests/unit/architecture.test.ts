import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ground rule 4 in CONTRIBUTING.md, as a test rather than a request.
 *
 * The discovery engine and the GraphRAG index are pure functions by design, and that is
 * what makes the simulation harness possible: it drives the whole pipeline over planted
 * populations that never touch a database. One import is all it takes to lose that, and
 * it would be lost quietly — the suite would still pass, just slower and against
 * fixtures nobody can plant structure into.
 */

const PURE_MODULES = ["src/lib/discovery", "src/lib/graphrag"];

/** Anything that would drag persistence into a pure module. Matched against the
 *  import specifier itself, so `../db/schema.js` is caught as readily as `drizzle-orm`. */
const FORBIDDEN = [
  /^drizzle-orm(\/|$)/,
  /^@electric-sql\/pglite(\/|$)/,
  /^postgres(\/|$)/,
  /(^|\/)db(\/|$)/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

function importedModules(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [/\bimport\s[^;]*?from\s+["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

describe("module boundaries", () => {
  for (const dir of PURE_MODULES) {
    it(`${dir} imports no persistence`, () => {
      const offenders: string[] = [];
      for (const file of sourceFiles(dir)) {
        const source = readFileSync(file, "utf8");
        for (const specifier of importedModules(source)) {
          if (FORBIDDEN.some((pattern) => pattern.test(specifier))) offenders.push(`${file} -> ${specifier}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
