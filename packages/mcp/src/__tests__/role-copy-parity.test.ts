// LegalKeyScopeGuard (apps/api-nest/src/common/guards/legal-key-scope.guard.ts)
// refuses a legal key everywhere except routes whose @OrgRoles includes 'legal' or that carry
// @IngestRoute / @IngestKeyAllowed / @Public, so every other tool's role copy must say so.
// Drives the compiled dist/index.js over stdio: run `npm run build` first.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";

// The only tools a legal key clears: the twelve Matter tools (@OrgRoles(...LAW_MANAGE_ROLES),
// LAW_MANAGE_ROLES in packages/db/src/lib/org-roles.ts, the one role set containing 'legal'), the two
// @IngestRoute usage POSTs, and the @IngestKeyAllowed doors verify and get_spend_controls.
const LEGAL_REACHABLE_TOOLS = [
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
  "record_usage",
  "record_usage_batch",
  "verify",
  "get_spend_controls",
] as const;

const EXCEPT_INGEST = /except[^.]*ingest-only/i;
const ROLE_LINE = /(Required role|key role)/i;

function sentenceMatching(description: string, pattern: RegExp): string {
  const sentences = description.split(/\.\s+/);
  return sentences.find((s) => pattern.test(s)) ?? "";
}

describe("MCP tool role copy names every denied role", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let tools: Array<{ name: string; description?: string }>;

  beforeAll(async () => {
    const serverPath = path.resolve(__dirname, "../../dist/index.js");
    transport = new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: {
        ...process.env,
        MF_API_SECRET_KEY: "mf_sk_test_fake",
        MARGINFRONT_API_URL: "http://localhost:1/v1",
      },
    });
    client = new Client({ name: "role-copy-parity-test", version: "1.0.0" });
    await client.connect(transport);
    const result = await client.listTools();
    tools = result.tools as Array<{ name: string; description?: string }>;
  }, 30000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
  });

  it("every tool that enumerates the denied roles names legal alongside ingest-only", () => {
    const liars = tools
      .filter((t) => EXCEPT_INGEST.test(t.description ?? ""))
      .map((t) => ({
        name: t.name,
        sentence: sentenceMatching(t.description ?? "", EXCEPT_INGEST),
      }))
      .filter((t) => !/\blegal\b/i.test(t.sentence));

    expect(
      liars,
      `These tools tell a legal key it can call them, but LegalKeyScopeGuard 403s it:\n` +
        liars.map((l) => `  ${l.name}: "${l.sentence}"`).join("\n"),
    ).toEqual([]);
  });

  it("no tool a legal key can actually call claims legal gets a 403", () => {
    const wrong = tools
      .filter((t) => LEGAL_REACHABLE_TOOLS.includes(t.name as never))
      .filter((t) => {
        const d = t.description ?? "";
        return (
          /except[^.]*\blegal\b/i.test(d) || /\blegal\b[^.;]*\b403\b/i.test(d)
        );
      })
      .map((t) => t.name);

    expect(
      wrong,
      `A legal key clears these routes; the copy must not say otherwise: ${wrong.join(", ")}`,
    ).toEqual([]);
  });

  it("every tool states which key roles can call it, so a new tool cannot stay silent", () => {
    const silent = tools
      .filter((t) => !ROLE_LINE.test(t.description ?? ""))
      .map((t) => t.name);
    expect(
      silent,
      `These tools carry no role line at all; add one so a legal or ingest-only key is not left guessing: ${silent.join(", ")}`,
    ).toEqual([]);
  });

  it("every matter tool is on the legal-reachable list, so a new matter tool cannot slip past the check above", () => {
    const unlisted = tools
      .map((t) => t.name)
      .filter(
        (n) => /matter/i.test(n) && !LEGAL_REACHABLE_TOOLS.includes(n as never),
      );
    expect(
      unlisted,
      `Matter tools carry @OrgRoles(...LAW_MANAGE_ROLES) and a legal key clears them; add these to LEGAL_REACHABLE_TOOLS: ${unlisted.join(", ")}`,
    ).toEqual([]);
  });

  it("every legal-reachable tool is still registered under the name this test guards", () => {
    const registered = new Set(tools.map((t) => t.name));
    const missing = LEGAL_REACHABLE_TOOLS.filter((n) => !registered.has(n));
    expect(
      missing,
      `Renamed or dropped tools silently empty the check above: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
