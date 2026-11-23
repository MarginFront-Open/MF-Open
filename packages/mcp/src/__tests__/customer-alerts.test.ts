/**
 * MCP customer-watch tools, end to end.
 *
 * Spawns the REAL compiled MCP server (stdio transport, same as production —
 * see mcp-integration.test.ts) against a throwaway local HTTP server standing
 * in for api-nest. No mock of the MCP protocol layer, the api-client, or the
 * tool handlers — the request the tool actually makes lands on the stand-in,
 * and the stand-in's response flows back through the real ApiClient +
 * errorResponse path.
 *
 * Proves:
 *   - get_customer_alerts GETs /customer-alerts and returns the list verbatim.
 *   - create/update/delete hit the right verb + path with the right payload
 *     (notifyEmail included on create — the identity the server validates).
 *   - create WITHOUT notifyEmail is rejected at the zod layer with a message
 *     naming the fix, before any network call.
 *   - the server's own plain-English 400 (a non-money-role recipient) and 403
 *     (a non-money-role key) surface through errorResponse, not as bare noise.
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
  const client = new Client({ name: "customer-alerts-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

const CUSTOMER_UUID = "3f2a8c1e-0000-4000-8000-000000000001";

const ALERT_ROW = {
  id: "watch-1",
  customerId: CUSTOMER_UUID,
  customerName: "Acme",
  customerExternalId: "acme-1",
  metric: "cost",
  thresholdUsd: 500,
  windowMode: "month",
  customStartDate: null,
  customEndDate: null,
  recipientEmail: "cfo@acme.test",
  createdByUserId: null,
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

const RECIPIENT_400 =
  "\"dev@acme.test\" belongs to a member with the 'developer' role, who can't open " +
  "the customer-alerts feed. Pick a member with a money role: owner, admin, finance.";

describe("MCP customer-watch tools", () => {
  let server: Server;
  let port: number;
  let requests: Recorded[];
  let client: Client;

  beforeAll(async () => {
    ({ server, port, requests } = await startServer((req, res, raw) => {
      const url = req.url ?? "";
      const method = req.method ?? "";
      if (method === "GET" && url === "/v1/customer-alerts") {
        return json(res, 200, [ALERT_ROW]);
      }
      if (method === "POST" && url === "/v1/customer-alerts") {
        const body = raw ? (JSON.parse(raw) as { notifyEmail?: string }) : {};
        if (body.notifyEmail === "dev@acme.test") {
          return json(res, 400, { message: RECIPIENT_400, statusCode: 400 });
        }
        return json(res, 201, { ...ALERT_ROW, id: "watch-9" });
      }
      if (method === "PATCH" && url === "/v1/customer-alerts/watch-9") {
        return json(res, 200, {
          ...ALERT_ROW,
          id: "watch-9",
          thresholdUsd: 750,
        });
      }
      if (method === "DELETE" && url === "/v1/customer-alerts/watch-9") {
        return json(res, 200, { deleted: true, id: "watch-9" });
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

  it("get_customer_alerts GETs /customer-alerts and returns the list verbatim", async () => {
    const result = await client.callTool({
      name: "get_customer_alerts",
      arguments: {},
    });
    const data = JSON.parse(textOf(result as { content: unknown }));
    expect(data).toEqual([ALERT_ROW]);
    const req = requests.find(
      (r) => r.url === "/v1/customer-alerts" && r.method === "GET",
    );
    expect(req).toBeTruthy();
  });

  it("create POSTs the payload INCLUDING notifyEmail — the identity the server validates", async () => {
    const result = await client.callTool({
      name: "create_customer_alert",
      arguments: {
        customerId: CUSTOMER_UUID,
        metric: "cost",
        thresholdUsd: 500,
        windowMode: "month",
        notifyEmail: "cfo@acme.test",
      },
    });
    expect((result as { isError?: boolean }).isError).toBeFalsy();

    const req = requests.find(
      (r) => r.method === "POST" && r.url === "/v1/customer-alerts",
    );
    expect(req).toBeTruthy();
    expect(req!.body).toEqual({
      customerId: CUSTOMER_UUID,
      metric: "cost",
      thresholdUsd: 500,
      windowMode: "month",
      notifyEmail: "cfo@acme.test",
    });
  });

  it("create WITHOUT notifyEmail is rejected before any network call, naming the fix", async () => {
    const before = requests.filter((r) => r.method === "POST").length;
    const result = await client.callTool({
      name: "create_customer_alert",
      arguments: {
        customerId: CUSTOMER_UUID,
        metric: "cost",
        thresholdUsd: 500,
        windowMode: "month",
      },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result as { content: unknown })).toContain("notifyEmail");
    const after = requests.filter((r) => r.method === "POST").length;
    expect(after).toBe(before); // zod stopped it client-side
  });

  it("the server's plain-English recipient 400 surfaces verbatim through errorResponse", async () => {
    const result = await client.callTool({
      name: "create_customer_alert",
      arguments: {
        customerId: CUSTOMER_UUID,
        metric: "cost",
        thresholdUsd: 500,
        windowMode: "month",
        notifyEmail: "dev@acme.test",
      },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result as { content: unknown })).toContain(
      "Pick a member with a money role",
    );
  });

  it("update PATCHes /customer-alerts/:id with only the changed fields", async () => {
    const result = await client.callTool({
      name: "update_customer_alert",
      arguments: { id: "watch-9", thresholdUsd: 750 },
    });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const req = requests.find((r) => r.method === "PATCH");
    expect(req?.url).toBe("/v1/customer-alerts/watch-9");
    expect(req?.body).toEqual({ thresholdUsd: 750 });
  });

  it("delete DELETEs /customer-alerts/:id and confirms", async () => {
    const result = await client.callTool({
      name: "delete_customer_alert",
      arguments: { id: "watch-9" },
    });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const data = JSON.parse(textOf(result as { content: unknown }));
    expect(data.deleted).toBe(true);
    const req = requests.find((r) => r.method === "DELETE");
    expect(req?.url).toBe("/v1/customer-alerts/watch-9");
  });

  it("tool metadata: the read is marked read-only; every description names the money-role gate", async () => {
    const { tools } = await client.listTools();
    const names = [
      "get_customer_alerts",
      "create_customer_alert",
      "update_customer_alert",
      "delete_customer_alert",
    ];
    for (const name of names) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeTruthy();
      expect(tool!.description).toMatch(/owner, admin, or finance/);
    }
    const read = tools.find((t) => t.name === "get_customer_alerts");
    expect(read!.annotations?.readOnlyHint).toBe(true);
  });
});

describe("MCP customer-watch tools — a non-money-role key's 403 becomes guidance", () => {
  let server: Server;
  let port: number;
  let client: Client;

  beforeAll(async () => {
    ({ server, port } = await startServer((_req, res) => {
      // The real OrgRoleGuard denial shape (InsufficientKeyRoleException):
      // code + key_role + required_roles is what errorResponse keys on to
      // produce role guidance instead of a bare 403.
      return json(res, 403, {
        message: "Insufficient key role",
        code: "insufficient_key_role",
        key_role: "developer",
        required_roles: ["owner", "admin", "finance"],
        statusCode: 403,
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

  it("the 403 becomes role guidance naming the key's role and the allowed set", async () => {
    const result = await client.callTool({
      name: "get_customer_alerts",
      arguments: {},
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = textOf(result as { content: unknown });
    expect(text).toContain("'developer'");
    expect(text).toContain("Allowed roles: owner, admin, finance");
  });
});
