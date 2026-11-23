/**
 * The agent/signal tools that let pricing setup start from zero.
 *
 * Spawns the REAL compiled MCP server (stdio transport, same as production)
 * against a throwaway local HTTP server standing in for api-nest. No mock of
 * the MCP protocol layer, the api-client, or the tool handlers — the request
 * each tool actually makes lands on the stand-in, and the stand-in's response
 * flows back through the real ApiClient.
 *
 * Proves:
 *   - create_agent POSTs /v1/agents and returns the created agent verbatim
 *     (the id is the agentId every downstream tool needs);
 *   - the duplicate-agentCode 409 reaches the agent as the API's plain
 *     message, and the tool description teaches the list_agents recovery
 *     (usage ingestion auto-creates agents, so the conflict is a normal path,
 *     not a dead end);
 *   - create_signal POSTs /v1/signals, returns the signalId pricing needs,
 *     and surfaces the agent-not-found 404 in plain English;
 *   - list_agents / list_signals GET the open lanes and pass filters through;
 *   - the writes carry the "Required role:" line, the lists are readOnlyHint;
 *   - the pricing-setup instructions name all four tools and teach the
 *     auto-create recovery.
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
  const client = new Client({ name: "agents-signals-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

const AGENT_ROW = {
  id: "agent-uuid-1",
  name: "Support Bot",
  agentCode: "support-bot",
  description: "Handles support tickets",
  isActive: true,
  signalsCount: 0,
  activePlansCount: 0,
  activeSubscriptionsCount: 0,
};

const AGENT_LIST = {
  results: [AGENT_ROW],
  page: 1,
  limit: 10,
  totalPages: 1,
  totalResults: 1,
};

const SIGNAL_ROW = {
  id: "signal-uuid-1",
  name: "tickets-resolved",
  shortName: "tickets",
  agentId: "agent-uuid-1",
  type: "usage",
};

const SIGNAL_LIST = {
  results: [SIGNAL_ROW],
  page: 1,
  limit: 10,
  totalPages: 1,
  totalResults: 1,
};

describe("MCP agent & signal tools", () => {
  let server: Server;
  let port: number;
  let requests: Recorded[];
  let client: Client;

  beforeAll(async () => {
    ({ server, port, requests } = await startServer((req, res, raw) => {
      const url = req.url ?? "";
      const method = req.method ?? "";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

      if (method === "POST" && url === "/v1/agents") {
        if (body.agentCode === "taken-bot") {
          return json(res, 409, {
            statusCode: 409,
            message: "Agent with code 'taken-bot' already exists",
            error: "Conflict",
          });
        }
        return json(res, 201, AGENT_ROW);
      }
      if (method === "GET" && url.startsWith("/v1/agents")) {
        return json(res, 200, AGENT_LIST);
      }
      if (method === "POST" && url === "/v1/signals") {
        if (body.agentId === "agent-gone") {
          return json(res, 404, {
            statusCode: 404,
            message: "Agent not found",
            error: "Not Found",
          });
        }
        return json(res, 201, SIGNAL_ROW);
      }
      if (method === "GET" && url.startsWith("/v1/signals")) {
        return json(res, 200, SIGNAL_LIST);
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

  it("create_agent POSTs /agents and returns the created agent verbatim", async () => {
    const result = await client.callTool({
      name: "create_agent",
      arguments: {
        name: "Support Bot",
        agentCode: "support-bot",
        description: "Handles support tickets",
      },
    });
    const data = JSON.parse(textOf(result as { content: unknown }));

    expect(data).toEqual(AGENT_ROW);
    // The id survives verbatim — it's the agentId every downstream tool needs.
    expect(data.id).toBe("agent-uuid-1");

    const req = requests.find(
      (r) => r.method === "POST" && r.url === "/v1/agents",
    );
    expect(req?.body).toMatchObject({
      name: "Support Bot",
      agentCode: "support-bot",
      description: "Handles support tickets",
    });
  });

  it("duplicate agentCode surfaces the API's conflict message", async () => {
    const result = await client.callTool({
      name: "create_agent",
      arguments: { name: "Taken Bot", agentCode: "taken-bot" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result as { content: unknown })).toContain("already exists");
  });

  it("create_agent's description teaches the list_agents recovery", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "create_agent");
    expect(tool).toBeTruthy();

    // The auto-create trap: usage ingestion creates agents behind the scenes,
    // the 409 body carries no id, so the description MUST route to list_agents
    // or an MCP-only session dead-ends right before pricing.
    expect(tool!.description).toContain("list_agents");
    expect(tool!.description).toContain("Required role:");
  });

  it("create_signal POSTs /signals and returns the signalId pricing needs", async () => {
    const result = await client.callTool({
      name: "create_signal",
      arguments: {
        name: "tickets-resolved",
        agentId: "agent-uuid-1",
        type: "usage",
      },
    });
    const data = JSON.parse(textOf(result as { content: unknown }));

    expect(data).toEqual(SIGNAL_ROW);
    expect(data.id).toBe("signal-uuid-1");

    const req = requests.find(
      (r) => r.method === "POST" && r.url === "/v1/signals",
    );
    expect(req?.body).toMatchObject({
      name: "tickets-resolved",
      agentId: "agent-uuid-1",
      type: "usage",
    });
  });

  it("create_signal surfaces the agent-not-found 404 in plain English", async () => {
    const result = await client.callTool({
      name: "create_signal",
      arguments: { name: "orphan-signal", agentId: "agent-gone" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result as { content: unknown })).toContain("Agent not found");
  });

  it("create_signal's description carries the invoice-naming rule and the recovery", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "create_signal");
    expect(tool).toBeTruthy();

    expect(tool!.description).toContain("invoice");
    expect(tool!.description).toContain("list_signals");
    expect(tool!.description).toContain("Required role:");
  });

  it("list_agents GETs /agents, passes filters through, and is read-only", async () => {
    const result = await client.callTool({
      name: "list_agents",
      arguments: {
        search: "support",
        agentCode: "support-bot",
        isActive: true,
        page: 1,
        limit: 5,
      },
    });
    const data = JSON.parse(textOf(result as { content: unknown }));
    expect(data).toEqual(AGENT_LIST);

    const req = [...requests]
      .reverse()
      .find((r) => r.method === "GET" && r.url.startsWith("/v1/agents"));
    expect(req?.url).toContain("search=support");
    expect(req?.url).toContain("agentCode=support-bot");
    expect(req?.url).toContain("isActive=true");
    expect(req?.url).toContain("limit=5");

    const { tools } = await client.listTools();
    expect(
      tools.find((t) => t.name === "list_agents")!.annotations?.readOnlyHint,
    ).toBe(true);
  });

  it("list_signals GETs /signals, passes filters through, and is read-only", async () => {
    const result = await client.callTool({
      name: "list_signals",
      arguments: { agentId: "agent-uuid-1", name: "tickets", type: "usage" },
    });
    const data = JSON.parse(textOf(result as { content: unknown }));
    expect(data).toEqual(SIGNAL_LIST);

    const req = [...requests]
      .reverse()
      .find((r) => r.method === "GET" && r.url.startsWith("/v1/signals"));
    expect(req?.url).toContain("agentId=agent-uuid-1");
    expect(req?.url).toContain("name=tickets");
    expect(req?.url).toContain("type=usage");

    const { tools } = await client.listTools();
    expect(
      tools.find((t) => t.name === "list_signals")!.annotations?.readOnlyHint,
    ).toBe(true);
  });

  it("the pricing-setup instructions name all four tools and the recovery", async () => {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("create_agent");
    expect(instructions).toContain("create_signal");
    expect(instructions).toContain("list_agents");
    expect(instructions).toContain("list_signals");
    expect(instructions).toContain("auto-creates");
  });
});
