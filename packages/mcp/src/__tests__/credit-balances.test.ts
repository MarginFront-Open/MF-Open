/**
 * The get_credit_balances MCP tool, end to end.
 *
 * Spawns the REAL compiled MCP server (stdio transport, same as production)
 * against a throwaway local HTTP server standing in for api-nest. No mock of
 * the MCP protocol layer, the api-client, or the tool handler — the request
 * the tool actually makes lands on the stand-in, and the stand-in's response
 * flows back through the real ApiClient.
 *
 * Proves:
 *   - the list call hits GET /v1/credit-balances and passes filters through;
 *   - subscriptionId switches to the single-subscription route instead of
 *     silently filtering a list;
 *   - the response is returned VERBATIM, so remainingUnits (top-up aware) and
 *     overageInProgressUnits (the invoice's top-up-blind math) both survive;
 *   - the tool teaches the two rules that matter — the two numbers, and that
 *     nothing stops at zero;
 *   - the server's own 404 reaches the agent as a plain-English message;
 *   - the pricing-setup instructions name the tool.
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

async function connectClient(
  port: number,
): Promise<{ client: Client; transport: StdioClientTransport }> {
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
  const client = new Client({ name: "credit-balances-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

/** Topped up AND in overage at the same time — the case the split exists for. */
const POOL_ROW = {
  subscriptionId: "sub-1",
  subscriptionName: "Acme pooled plan",
  customerId: "cust-1",
  customerName: "Acme",
  customerExternalId: "acme-ext",
  agentId: "agent-1",
  planId: "plan-1",
  planName: "Pooled",
  poolSizeUnits: 5000,
  consumedUnits: 5300,
  remainingUnits: 1200,
  overageInProgressUnits: 300,
  remainingPercent: 24,
  overageRatePerUnit: 0.03,
  periodStart: "2026-07-01T00:00:00.000Z",
  periodEnd: "2026-08-01T00:00:00.000Z",
  alertsPaused: false,
  noActivePeriod: false,
  implicitFullPool: false,
};

const LIST_RESPONSE = {
  balances: [POOL_ROW],
  asOf: "2026-07-15T12:00:00.000Z",
};

describe("MCP get_credit_balances", () => {
  let server: Server;
  let port: number;
  let requests: Recorded[];
  let client: Client;

  beforeAll(async () => {
    ({ server, port, requests } = await startServer((req, res) => {
      const url = req.url ?? "";
      const method = req.method ?? "";
      if (method === "GET" && url.startsWith("/v1/credit-balances")) {
        return json(res, 200, LIST_RESPONSE);
      }
      if (
        method === "GET" &&
        url === "/v1/subscriptions/sub-1/credit-balance"
      ) {
        return json(res, 200, POOL_ROW);
      }
      if (
        method === "GET" &&
        url === "/v1/subscriptions/no-pool/credit-balance"
      ) {
        return json(res, 404, {
          statusCode: 404,
          message:
            "No credit pool found for subscription no-pool. Either the subscription " +
            "doesn't belong to this organization, or its plan doesn't sell a credit pool.",
        });
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

  it("GETs /credit-balances and returns the response verbatim", async () => {
    const result = await client.callTool({
      name: "get_credit_balances",
      arguments: {},
    });
    const data = JSON.parse(textOf(result as { content: unknown }));

    expect(data).toEqual(LIST_RESPONSE);
    // Both numbers survive: the agent can count down AND state the bill.
    expect(data.balances[0].remainingUnits).toBe(1200);
    expect(data.balances[0].overageInProgressUnits).toBe(300);

    const req = requests.find((r) => r.url.startsWith("/v1/credit-balances"));
    expect(req?.method).toBe("GET");
  });

  it("passes customerId / agentId / belowPercent through as query params", async () => {
    await client.callTool({
      name: "get_credit_balances",
      arguments: { customerId: "cust-1", agentId: "agent-1", belowPercent: 20 },
    });

    const req = [...requests]
      .reverse()
      .find((r) => r.url.startsWith("/v1/credit-balances"));
    expect(req?.url).toContain("customerId=cust-1");
    expect(req?.url).toContain("agentId=agent-1");
    expect(req?.url).toContain("belowPercent=20");
  });

  it("subscriptionId switches to the single-subscription route", async () => {
    const result = await client.callTool({
      name: "get_credit_balances",
      arguments: { subscriptionId: "sub-1" },
    });
    const data = JSON.parse(textOf(result as { content: unknown }));

    expect(data).toEqual(POOL_ROW);
    expect(
      requests.some((r) => r.url === "/v1/subscriptions/sub-1/credit-balance"),
    ).toBe(true);
  });

  it("surfaces the server's plain-English 404 instead of a bare error", async () => {
    const result = await client.callTool({
      name: "get_credit_balances",
      arguments: { subscriptionId: "no-pool" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result as { content: unknown })).toContain(
      "doesn't sell a credit pool",
    );
  });

  it("teaches both rules in its description and is marked read-only", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "get_credit_balances");
    expect(tool).toBeTruthy();

    // What the numbers mean, and that nothing gates.
    expect(tool!.description).toContain("NOTHING STOPS AT ZERO");
    expect(tool!.description).toContain("remainingUnits");
    expect(tool!.description).toContain("overageInProgressUnits");
    expect(tool!.annotations?.readOnlyHint).toBe(true);

    // The MCP reads credit pools only: no credit-pool write tool may appear.
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("create_credit_topup");
    expect(names).not.toContain("pause_credit_alerts");
  });

  it("the pricing-setup instructions name the tool", async () => {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("get_credit_balances");
    expect(instructions).toContain("meter, not a breaker");
  });
});
