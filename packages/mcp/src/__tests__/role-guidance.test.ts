/**
 * Role-aware MCP guidance for insufficient_key_role denials.
 *
 * Spawns the REAL compiled MCP server (the same stdio transport a production MCP
 * host uses — see mcp-integration.test.ts) against a throwaway local HTTP server
 * standing in for api-nest. The stand-in returns the EXACT response body
 * InsufficientKeyRoleException produces
 * (apps/api-nest/src/common/exceptions/insufficient-key-role.exception.ts), so this
 * proves the real ApiClient -> errorResponse() translation path end to end — no
 * mocking of the MCP protocol layer, the api-client, or the error-formatting
 * helper under test. A live database is unnecessary: the api-nest guard tests prove the
 * guard produces this exact body; this test proves the MCP CLIENT reads it right.
 *
 * Requires `npm run build` to have produced dist/index.js first (same
 * prerequisite mcp-integration.test.ts documents).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer, type Server } from "http";
import * as path from "path";

async function startServer(
  handler: (req: any, res: any) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  return { server, port };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function textOf(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((c) => c.text).join("\n");
}

async function connectClient(port: number): Promise<{
  client: Client;
  transport: StdioClientTransport;
}> {
  const serverPath = path.resolve(__dirname, "../../dist/index.js");
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...process.env,
      MF_API_SECRET_KEY: "mf_sk_test_fake",
      MARGINFRONT_API_URL: `http://localhost:${port}/v1`,
    },
  });
  const client = new Client({ name: "role-guidance-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

describe("MCP role-aware guidance on insufficient_key_role", () => {
  let server: Server;
  let port: number;
  let client: Client;

  beforeAll(async () => {
    ({ server, port } = await startServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          statusCode: 403,
          code: "insufficient_key_role",
          required_roles: ["finance", "admin", "owner"],
          key_role: "developer",
          message:
            "This API key's role ('developer') is not permitted to perform this action. " +
            "Allowed roles: finance, admin, owner.",
        }),
      );
    }));
    ({ client } = await connectClient(port));
  }, 15000);

  afterAll(async () => {
    try {
      await client.close();
    } catch {
      // already closed
    }
    await stopServer(server);
  });

  it("generate_invoice: names the carried role and the allowed roles, not a bare 403", async () => {
    const result = await client.callTool({
      name: "generate_invoice",
      arguments: { customerId: "cust-1", subscriptionId: "sub-1" },
    });
    const text = textOf(result as { content: unknown });

    expect(result.isError).toBe(true);
    expect(text).toContain("developer");
    expect(text).toContain("finance, admin, owner");
    expect(text).not.toMatch(/^API error \(403\)/);
    expect(text).not.toMatch(/publishable key/i); // not the generic pk-write fallback
  });

  it("create_customer: guidance tells the agent where to go next", async () => {
    const result = await client.callTool({
      name: "create_customer",
      arguments: { name: "Should Fail" },
    });
    const text = textOf(result as { content: unknown });

    expect(result.isError).toBe(true);
    expect(text.toLowerCase()).toContain("mint a key");
  });
});

/**
 * The SECOND sender of `insufficient_key_role`. The stand-in returns the
 * EXACT body IngestKeyScopeForbiddenException produces
 * (apps/api-nest/src/common/exceptions/ingest-key-scope-forbidden.exception.ts),
 * empty required_roles included. That emptiness is the contract: every role above the
 * ingest floor clears the guard, but the route's own OrgRoleGuard is usually narrower
 * (get_internal_spend_breakdown wants owner/admin/finance), so any list rendered as
 * "Allowed roles" would send the reader to mint a member key that 403s again. This pins
 * that the empty list routes to the server's own sentence rather than to the generic
 * publishable-key remedy, which would blame the wrong key entirely.
 */
describe("MCP guidance on the global ingest-scope denial", () => {
  let server: Server;
  let port: number;
  let client: Client;

  beforeAll(async () => {
    ({ server, port } = await startServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          statusCode: 403,
          code: "insufficient_key_role",
          required_roles: [],
          key_role: "ingest",
          message:
            "This API key's role is 'ingest'. An ingest key can send usage records, " +
            "check which organization it belongs to, and read your spend controls: the " +
            "caps, your organization's AI spend for the current period, any named " +
            "teammate's spend, and cap coverage. It can't reach anything else here, " +
            "including customers, invoices, revenue, and payouts. For this request, use " +
            "a key with a higher role. Create one in the MarginFront dashboard under " +
            "Build, then API keys.",
        }),
      );
    }));
    ({ client } = await connectClient(port));
  }, 15000);

  afterAll(async () => {
    try {
      await client.close();
    } catch {
      // already closed
    }
    await stopServer(server);
  });

  it("get_internal_spend_breakdown: renders the server's explanation, not the five-role list", async () => {
    const result = await client.callTool({
      name: "get_internal_spend_breakdown",
      arguments: { period: "month", dimension: "repo" },
    });
    const text = textOf(result as { content: unknown });

    expect(result.isError).toBe(true);
    expect(text).toContain("'ingest'");
    expect(text).toContain("send usage records");
    // No invented role list: this route needs owner/admin/finance, so any suggested
    // role the server did not author is a second wasted mint for the customer.
    expect(text).not.toContain("Allowed roles");
    // And not the generic 403 fallback either, which blames a publishable key (mf_pk_*)
    // and would send them to rotate a key that was never the problem.
    expect(text).not.toMatch(/publishable key/i);
    expect(text.toLowerCase()).toContain("mint a key");
  });

  it("list_invoices: the same denial explains itself on a money read", async () => {
    const result = await client.callTool({
      name: "list_invoices",
      arguments: {},
    });
    const text = textOf(result as { content: unknown });

    expect(result.isError).toBe(true);
    expect(text).toContain("An ingest key can send usage records");
    expect(text).not.toContain("Allowed roles");
  });
});

describe("A plain 403 (no insufficient_key_role code) still gets the generic message", () => {
  let server: Server;
  let port: number;
  let client: Client;

  beforeAll(async () => {
    ({ server, port } = await startServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Forbidden",
          message: "Secret key required for this operation",
          statusCode: 403,
        }),
      );
    }));
    ({ client } = await connectClient(port));
  }, 15000);

  afterAll(async () => {
    try {
      await client.close();
    } catch {
      // already closed
    }
    await stopServer(server);
  });

  it("create_customer: falls back to the generic pk-write guidance, not role guidance", async () => {
    const result = await client.callTool({
      name: "create_customer",
      arguments: { name: "Should Fail" },
    });
    const text = textOf(result as { content: unknown });

    expect(result.isError).toBe(true);
    expect(text).toMatch(/publishable key/i);
    expect(text).not.toContain("Allowed roles");
  });
});
