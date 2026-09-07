import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The web layer's two boundaries, as tests.
 *
 * #17 says route handlers and server actions authenticate and delegate, and hold no
 * rules. That claim is worth what the thing checking it is worth — which is the same
 * reasoning that put `tests/unit/architecture.test.ts` around the discovery engine.
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.tsx?$/.test(path) ? [path] : [];
  });
}

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [/\bimport\s[^;]*?from\s+["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

describe("the app talks to the database only through a service", () => {
  /**
   * A page that reaches for the schema is a page that has started making decisions the
   * service layer already makes — and it would do so untested, since the whole test
   * suite is pointed at the service seam. `@/web/db` is the one sanctioned door, and it
   * hands out a handle rather than a query.
   */
  it("has nothing under src/app importing the database directly", () => {
    const forbidden = [/^drizzle-orm(\/|$)/, /(^|\/)lib\/db(\/|$)/, /^@\/lib\/db(\/|$)/, /(^|\/)db\/schema/];

    const offenders: string[] = [];
    for (const file of sourceFiles("src/app")) {
      for (const specifier of importsOf(readFileSync(file, "utf8"))) {
        if (forbidden.some((pattern) => pattern.test(specifier))) offenders.push(`${file} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the offline guarantee reaches the browser", () => {
  /**
   * M0's offline test covers what the *server* connects to. This covers what it asks a
   * *reader's browser* to connect to, which is a different disclosure: a webfont request
   * from a page about a Cause tells whoever serves it who is reading, from what address,
   * at what time — and the reader never sees it happen.
   */
  it("has no page, layout or stylesheet referencing a third-party origin", () => {
    const external = /(?:https?:)?\/\/(?!localhost|127\.0\.0\.1)[a-z0-9-]+\.[a-z]/i;

    const offenders: string[] = [];
    for (const file of [...sourceFiles("src/app"), ...cssFiles("src/app")]) {
      const source = readFileSync(file, "utf8");
      for (const line of source.split("\n")) {
        // A comment explaining why we do not do this is not doing it.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (external.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.isFile() && path.endsWith(".css") ? [path] : [];
  });
}

describe("Next.js telemetry", () => {
  /**
   * Next.js reports usage by default. `README.md` and `SECURITY.md` promise an Instance
   * makes no outbound connections, so this is not a preference — it is the difference
   * between those documents being true and being false.
   */
  it("is disabled by every script that starts the application", () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;

    for (const name of ["dev", "build", "start"]) {
      expect(`${name}: ${scripts[name]}`).toContain("NEXT_TELEMETRY_DISABLED=1");
    }
  });

  it("is disabled by the config too, for anything that starts it another way", () => {
    expect(readFileSync("next.config.ts", "utf8")).toContain("NEXT_TELEMETRY_DISABLED");
  });
});
