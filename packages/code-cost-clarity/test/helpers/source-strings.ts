import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";

const PKG_ROOT = join(__dirname, "..", "..");
const SRC_ROOT = join(PKG_ROOT, "src");

export interface SourceString {
  file: string;
  line: number;
  text: string;
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found.sort();
}

export function srcFilePaths(): string[] {
  return sourceFiles(SRC_ROOT);
}

export function readSrc(file: string): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

// Parsed with the compiler, not grepped: the copy rules apply only to what a
// customer sees, and a regex cannot tell a string from the same words in a comment.
export function userFacingStrings(): SourceString[] {
  const collected: SourceString[] = [];

  for (const file of srcFilePaths()) {
    const text = readSrc(file);
    const parsed = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        collected.push({
          file: relative(PKG_ROOT, file),
          line:
            parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line +
            1,
          text: node.text,
        });
      }
      ts.forEachChild(node, visit);
    };

    visit(parsed);
  }

  return collected;
}

export interface DocReference {
  file: string;
  line: number;
  url: string;
}

// Sentence punctuation is not part of the URL. A closing paren is dropped only when
// the URL has no opening paren of its own, so links that carry parens survive.
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url[url.length - 1];
    if (last === "." || last === "," || last === ";" || last === ":") {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ")" && !url.includes("(")) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

// Documentation links anywhere in src/ - printed copy, the .env template the
// installer writes, and code comments alike. All three send a human to the page.
export function docReferences(): DocReference[] {
  const found: DocReference[] = [];
  const pattern = /https:\/\/docs\.marginfront\.com\/[^\s"'`\\]+/g;

  for (const file of srcFilePaths()) {
    const lines = readSrc(file).split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        found.push({
          file: relative(PKG_ROOT, file),
          line: index + 1,
          url: trimUrl(match[0]),
        });
      }
    });
  }

  return found;
}

// Headings the README has, normalized so a citation written as
// What init changes matches a heading written as What `init` changes.
export function normalizeHeading(value: string): string {
  return value
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function readmeHeadings(): string[] {
  const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
  return readme
    .split("\n")
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => normalizeHeading(line.replace(/^#{1,6}\s+/, "")));
}

// Case-insensitive on purpose, so "Readme" or "readme" is caught too.
export function mentionsReadme(text: string): boolean {
  return /\breadme\b/i.test(text);
}

// Section names a line claims to point at. Citations come quoted ('README, section
// "Spend Control"') or possessive ("the README's Codex section"). A bare "see the
// README" names nothing and collects nothing.
export function citedSections(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/"([^"]+)"|'([^']+)'|`([^`]+)`/g)) {
    names.push(match[1] ?? match[2] ?? match[3]);
  }
  for (const match of text.matchAll(
    /README'?s?[,:]?\s+(?:section\s+)?([A-Za-z][A-Za-z0-9 ]*?)\s+section/gi,
  )) {
    names.push(match[1]);
  }
  return names;
}

export interface ReadmeCitation {
  cited: string[];
  dead: string[];
}

// EVERY name a line cites has to be a live heading. Asking whether ANY of them is
// lets one live name launder every dead name beside it. Do not weaken this to
// "some" - the fixtures in docs-references.test.ts pin it.
export function readmeCitation(
  text: string,
  headings: string[],
): ReadmeCitation {
  const cited = citedSections(text);
  return {
    cited,
    dead: cited.filter((name) => !headings.includes(normalizeHeading(name))),
  };
}
