// The dashboard's Jest loads src/finished-work.ts across the package boundary and
// parses it as CommonJS, where import.meta is a syntax error. One import reaching
// forwarder.ts kills that whole suite at load. The graph is walked, not one file,
// because the break arrives through a module nobody counts as part of the pure half.
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Comments and string bodies out, so a file that only TALKS about the hazard in
 *  prose is not reported as carrying it. */
function codeOnly(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (two === "/*") {
      i += 2;
      while (i < source.length && source.slice(i, i + 2) !== "*/") i++;
      i += 2;
    } else if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
      const quote = source[i];
      i++;
      while (i < source.length && source[i] !== quote) {
        i += source[i] === "\\" ? 2 : 1;
      }
      i++;
    } else {
      out += source[i];
      i++;
    }
  }
  return out;
}

/** Relative specifiers a CommonJS emit would still require. `import type` and
 *  `export type` are erased, so following them would blame a module the runtime
 *  never loads. */
function loadedImportsOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(
    /(?:^|\n)\s*(import|export)\s+(type\s+)?[\s\S]*?from\s*["'](\.[^"']+)["']/g,
  )) {
    if (match[2] === undefined) found.push(match[3]);
  }
  return found;
}

/** Every file reachable from `entry` by a loaded relative import, entry included. */
function importGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [resolve(SRC, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of loadedImportsOf(readFileSync(file, "utf8"))) {
      queue.push(resolve(dirname(file), `${specifier}.ts`));
    }
  }
  return [...seen];
}

function carriesImportMeta(file: string): boolean {
  return /\bimport\s*\.\s*meta\b/.test(codeOnly(readFileSync(file, "utf8")));
}

describe("finished-work.ts stays loadable from a CommonJS parser", () => {
  test("nothing it loads uses import.meta", () => {
    expect(importGraph("finished-work.ts").filter(carriesImportMeta)).toEqual(
      [],
    );
  });

  test("the graph is real, so an empty answer is not a false pass", () => {
    // basename, not a slice on "/": this suite also runs on Windows, where the
    // resolved paths come back with backslashes.
    const names = importGraph("finished-work.ts").map((file) => basename(file));
    expect(names).toContain("finished-work.ts");
    expect(names).toContain("work-item-noun.ts");
  });

  test("forwarder.ts is the shape this guard exists to keep out", () => {
    expect(carriesImportMeta(join(SRC, "forwarder.ts"))).toBe(true);
  });

  test("the published surface still carries both nouns", () => {
    const forwarder = readFileSync(join(SRC, "forwarder.ts"), "utf8");
    expect(forwarder).toMatch(
      /export\s*\{[^}]*WORK_ITEM_NOUN[^}]*WORK_ITEM_NOUN_PLAIN[^}]*\}\s*from\s*"\.\/work-item-noun"/,
    );
  });
});
