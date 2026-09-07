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

/**
 * ADR-0003, as a test.
 *
 * Weighting Votes by how well verified someone is is the intuitive Sybil defence and it
 * distorts the maths invisibly: weighting rows changes the principal components, which
 * changes which Opinion Groups exist at all, which moves every readiness score. So
 * Verification Level gates entry and nothing else — and the scoring path does not even
 * name it, which is what makes this checkable without an exception to argue about.
 */
const GATE_VOCABULARY = /verification|vouch/i;

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

  for (const dir of PURE_MODULES) {
    it(`${dir} never reads a Verification Level (ADR-0003)`, () => {
      const offenders = sourceFiles(dir).filter((file) => GATE_VOCABULARY.test(readFileSync(file, "utf8")));
      expect(offenders).toEqual([]);
    });
  }
});

/**
 * The offline guarantee, as a test.
 *
 * An Instance must run with no third-party API keys and no outbound network, so that it
 * can be hosted where the data must not leave. That promise is easy to make and easy to
 * break by accident — one convenient geocoding call, one crash reporter — and the break
 * would be invisible until somebody audited the deployment.
 *
 * `scripts/build-region-extract.ts` is the deliberate exception and lives outside `src/`
 * precisely so that this test can be absolute about everything inside it.
 */
describe("the offline guarantee", () => {
  const NETWORK = [/https?:\/\//, /\bfetch\s*\(/, /\bnode:https?\b/, /\baxios\b/, /\bgot\b\s*\(/];

  it("has nothing under src/ reaching the network", () => {
    const offenders = sourceFiles("src").filter((file) => {
      const source = readFileSync(file, "utf8");
      return NETWORK.some((pattern) => pattern.test(source));
    });
    expect(offenders).toEqual([]);
  });
});
