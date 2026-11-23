// A matter is the job AI work is billed against: a firm calls that job a
// case, everyone else calls it a project or a ticket. This pins industry-neutral
// wording for the twelve matter tools, because these strings are what an agent
// reads before it decides whether to use the tools at all.
//
// Source-asserted against src/index.ts (not the compiled dist) so it runs
// without a build step.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SOURCE = readFileSync(join(__dirname, "..", "index.ts"), "utf8");
const LLMS_TXT = readFileSync(
  join(__dirname, "..", "..", "llms-mcp.txt"),
  "utf8",
);
const PACKAGE_JSON = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
) as { description: string };

const MATTER_TOOLS = [
  "list_matters",
  "get_matter",
  "create_matter",
  "update_matter",
  "delete_matter",
  "list_unassigned_events",
  "assign_event_to_matter",
  "list_matter_rules",
  "upsert_matter_rule",
  "delete_matter_rule",
  "apply_matter_rules",
  "export_matter_audit",
] as const;

// Phrases that would read as law-firm only.
const VERTICAL_PHRASES = [
  "For law firms (matters)",
  "legal matter",
  "case/file",
  "the firm's",
  "case identifier",
  "case caption",
  "case number",
  "client or carrier",
  "Matter Tools (Law Firms)",
];

describe("matter copy names the job, not the vertical", () => {
  it("the server instructions define a matter for every org", () => {
    expect(SOURCE).toContain(
      "Matters: a matter is the job AI work is billed against, a case for a firm, a project or ticket for anyone else.",
    );
  });

  it.each(VERTICAL_PHRASES)("src/index.ts doesn't say %s", (phrase) => {
    expect(SOURCE).not.toContain(phrase);
  });

  it.each(VERTICAL_PHRASES)("llms-mcp.txt doesn't say %s", (phrase) => {
    expect(LLMS_TXT).not.toContain(phrase);
  });

  it.each(VERTICAL_PHRASES)(
    "the package description doesn't say %s",
    (phrase) => {
      expect(PACKAGE_JSON.description).not.toContain(phrase);
    },
  );

  // The package description is read before anyone opens src/, so it names
  // no industry either.
  it("the package description names no vertical at all", () => {
    expect(PACKAGE_JSON.description).not.toMatch(/law firm/i);
    expect(PACKAGE_JSON.description).toContain("run the matter record");
  });

  it("the twelve tool names, the legal role copy and the matterId tag are present", () => {
    for (const tool of MATTER_TOOLS) {
      expect(SOURCE).toContain(`"${tool}"`);
    }
    expect(SOURCE).toContain(
      "Required role: Legal (Finance/Admin/Owner also work).",
    );
    expect(SOURCE).toContain("metadata.matterId");
  });
});
