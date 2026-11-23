/**
 * MCP spend-control tools, end to end.
 *
 * Spawns the REAL compiled MCP server (stdio transport, same as production — see
 * mcp-integration.test.ts) against a throwaway local HTTP server standing in for
 * api-nest. No mock of the MCP protocol layer, the api-client, or the tool
 * handlers — the request the tool actually makes lands on the stand-in, and the
 * stand-in's response flows back through the real ApiClient + errorResponse path.
 *
 * Proves:
 *   - get_spend_controls fans out to /control/caps + /control/spend + /control/coverage
 *     and returns all three composed.
 *   - create/update/delete hit the right verb + path and lead with the server's
 *     plain sentence (echoed, never re-derived here).
 *   - a non-manager key's 403 becomes role guidance, not a bare error (the
 *     gate rides the key; the tool surfaces the server's decision).
 *
 * Requires `npm run build` (dist/index.js), same prerequisite the other MCP
 * integration tests document.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "http";
import * as path from "path";

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ server: Server; port: number; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: raw ? JSON.parse(raw) : undefined,
      });
      handler(req, res, raw);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port, requests };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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
  const client = new Client({ name: "spend-controls-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

const DEV_SENTENCE =
  "Stop Claude spend at $200 for alice@acme.example per week";

// The exact shape GET /control/spend/breakdown returns. The tool
// must surface it verbatim — no reshaping, no invented fields.
const BREAKDOWN = {
  dimension: "branch",
  period: "week",
  window: {
    start: "2026-07-20T00:00:00.000Z",
    end: "2026-07-26T23:59:59.999Z",
  },
  asOf: "2026-07-23T12:00:00.000Z",
  totals: { spentUsd: 12.5, eventCount: 4, unpricedEventCount: 2 },
  rows: [
    {
      key: "acme/platform#feature/caps",
      spentUsd: 12.5,
      eventCount: 2,
      unpricedEventCount: 0,
    },
    {
      key: "acme/platform#main",
      spentUsd: null,
      eventCount: 1,
      unpricedEventCount: 1,
    },
  ],
  noMetadata: { spentUsd: null, eventCount: 1, unpricedEventCount: 1 },
  coveragePercent: 75,
};

describe("MCP spend-control tools (happy path)", () => {
  let server: Server;
  let port: number;
  let requests: Recorded[];
  let client: Client;

  beforeAll(async () => {
    ({ server, port, requests } = await startServer((req, res) => {
      const url = req.url ?? "";
      const method = req.method ?? "";
      if (method === "GET" && url.startsWith("/v1/control/caps")) {
        return json(res, 200, [
          {
            id: "cap-1",
            amountUsd: 5000,
            sentence: "Stop AI spend at $5,000 across the whole team per month",
          },
        ]);
      }
      // must precede the /v1/control/spend match — startsWith would swallow it
      if (method === "GET" && url.startsWith("/v1/control/spend/breakdown")) {
        return json(res, 200, BREAKDOWN);
      }
      if (method === "GET" && url.startsWith("/v1/control/spend")) {
        return json(res, 200, {
          period: "month",
          org: { spentUsd: null, eventCount: 0, unpricedEventCount: 0 },
          dev: null,
        });
      }
      if (method === "GET" && url.startsWith("/v1/control/coverage")) {
        return json(res, 200, {
          armed: 3,
          total: 5,
          asOf: "2026-07-22T12:00:00.000Z",
          claudeCode: { armed: 3, notArmed: 1, unknown: 0, total: 4 },
          // A blended count can read "3 of 5 armed" when no Codex machine was checked.
          codex: { armed: 0, notArmed: 0, unknown: 2, total: 2 },
        });
      }
      if (method === "POST" && url === "/v1/control/caps") {
        return json(res, 201, {
          id: "cap-9",
          amountUsd: 200,
          sentence: DEV_SENTENCE,
        });
      }
      if (method === "PATCH" && url === "/v1/control/caps/cap-9") {
        return json(res, 200, {
          id: "cap-9",
          amountUsd: 350,
          sentence: "Stop Claude spend at $350 for alice@acme.example per week",
        });
      }
      if (method === "DELETE" && url === "/v1/control/caps/cap-9") {
        return json(res, 200, { deleted: true, sentence: DEV_SENTENCE });
      }
      return json(res, 404, { message: `unexpected ${method} ${url}` });
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

  it("get_spend_controls fans out to caps + spend + coverage and composes them", async () => {
    const result = await client.callTool({
      name: "get_spend_controls",
      arguments: { period: "month" },
    });
    const data = JSON.parse(textOf(result as { content: unknown })) as any;

    expect(Array.isArray(data.caps)).toBe(true);
    expect(data.spend.org.spentUsd).toBeNull(); // honest null survives
    // The per-tool objects must reach the agent intact. Without them the agent
    // has only the blended pair to answer "is our spend cap covering the team?",
    // on the one surface where nobody can see the per-tool lines to correct it.
    expect(data.coverage).toEqual({
      armed: 3,
      total: 5,
      asOf: "2026-07-22T12:00:00.000Z",
      claudeCode: { armed: 3, notArmed: 1, unknown: 0, total: 4 },
      codex: { armed: 0, notArmed: 0, unknown: 2, total: 2 },
    });

    const paths = requests.map((r) => `${r.method} ${r.url.split("?")[0]}`);
    expect(paths).toContain("GET /v1/control/caps");
    expect(paths).toContain("GET /v1/control/spend");
    expect(paths).toContain("GET /v1/control/coverage");
    // the period rode the spend query
    const spendReq = requests.find((r) =>
      r.url.startsWith("/v1/control/spend"),
    );
    expect(spendReq?.url).toContain("period=month");
  });

  it("get_internal_spend_breakdown GETs /control/spend/breakdown and returns the response verbatim", async () => {
    const result = await client.callTool({
      name: "get_internal_spend_breakdown",
      arguments: { period: "week", dimension: "branch" },
    });
    const data = JSON.parse(textOf(result as { content: unknown }));

    expect(data).toEqual(BREAKDOWN);

    const req = requests.find((r) =>
      r.url.startsWith("/v1/control/spend/breakdown"),
    );
    expect(req?.method).toBe("GET");
    expect(req?.url).toContain("period=week");
    expect(req?.url).toContain("dimension=branch");
  });

  it("get_internal_spend_breakdown never claims per-PR data", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "get_internal_spend_breakdown");
    expect(tool).toBeTruthy();

    // the schema offers exactly repo and branch — no 'pr' grain exists
    const dimension = (
      tool!.inputSchema as {
        properties: Record<string, { enum?: string[] }>;
      }
    ).properties.dimension;
    expect(dimension.enum).toEqual(["repo", "branch"]);

    expect(tool!.description).toContain(
      "closest stand-in for cost per pull request",
    );

    // asking for a 'pr' grain is rejected before any HTTP request goes out
    const breakdownCallsBefore = requests.filter((r) =>
      r.url.startsWith("/v1/control/spend/breakdown"),
    ).length;
    let rejected = false;
    try {
      const result = await client.callTool({
        name: "get_internal_spend_breakdown",
        arguments: { period: "week", dimension: "pr" },
      });
      rejected = result.isError === true;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    const breakdownCallsAfter = requests.filter((r) =>
      r.url.startsWith("/v1/control/spend/breakdown"),
    ).length;
    expect(breakdownCallsAfter).toBe(breakdownCallsBefore);
  });

  it("create_spend_cap POSTs the params and leads with the server's sentence", async () => {
    const result = await client.callTool({
      name: "create_spend_cap",
      arguments: {
        scope: "dev",
        scopeValue: "alice@acme.example",
        amountUsd: 200,
        period: "week",
        mode: "enforce",
      },
    });
    const text = textOf(result as { content: unknown });

    expect(text).toContain(DEV_SENTENCE);
    const post = requests.find(
      (r) => r.method === "POST" && r.url === "/v1/control/caps",
    );
    expect(post?.body).toMatchObject({
      scope: "dev",
      // The tool supplies providerScope itself so no caller can slice by
      // provider — caps cover all AI tools.
      providerScope: "all",
      amountUsd: 200,
    });
  });

  it("update_spend_cap PATCHes /control/caps/{id} with only the patch fields", async () => {
    const result = await client.callTool({
      name: "update_spend_cap",
      arguments: { id: "cap-9", amountUsd: 350 },
    });
    const text = textOf(result as { content: unknown });

    expect(text).toContain("$350");
    const patch = requests.find(
      (r) => r.method === "PATCH" && r.url === "/v1/control/caps/cap-9",
    );
    expect(patch?.body).toEqual({ amountUsd: 350 }); // id is in the path, not the body
  });

  it("delete_spend_cap DELETEs and echoes the removed cap's sentence", async () => {
    const result = await client.callTool({
      name: "delete_spend_cap",
      arguments: { id: "cap-9" },
    });
    const text = textOf(result as { content: unknown });

    expect(text).toContain("Cap removed");
    expect(text).toContain(DEV_SENTENCE);
    const del = requests.find(
      (r) => r.method === "DELETE" && r.url === "/v1/control/caps/cap-9",
    );
    expect(del).toBeTruthy();
  });
});

describe("MCP create_spend_cap on a non-manager key → role guidance", () => {
  let server: Server;
  let port: number;
  let client: Client;

  beforeAll(async () => {
    ({ server, port } = await startServer((_req, res) => {
      // The exact InsufficientKeyRoleException body the guard returns for a key
      // whose role isn't in CAP_MANAGE_ROLES.
      json(res, 403, {
        statusCode: 403,
        code: "insufficient_key_role",
        required_roles: ["owner", "finance"],
        key_role: "developer",
        message:
          "This API key's role ('developer') is not permitted to perform this action. " +
          "Allowed roles: owner, finance.",
      });
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

  it("names the carried role and the allowed roles, not a bare 403", async () => {
    const result = await client.callTool({
      name: "create_spend_cap",
      arguments: {
        scope: "org",
        providerScope: "all",
        amountUsd: 5000,
        period: "month",
        mode: "track",
      },
    });
    const text = textOf(result as { content: unknown });

    expect(result.isError).toBe(true);
    expect(text).toContain("developer");
    expect(text).toContain("owner, finance");
    expect(text.toLowerCase()).toContain("mint a key");
  });
});
