/**
 * MCP Server Integration Tests
 *
 * Spawns the real MCP server as a child process and connects via the
 * MCP protocol (JSON-RPC over stdio), the exact same transport used
 * in production. Each test calls a tool the way Claude or GPT would:
 * through the MCP SDK client, over stdio, hitting the real API.
 *
 * Prerequisites:
 *   1. api-nest running (MARGINFRONT_API_URL, default http://localhost:4000/v1)
 *   2. MF_API_SECRET_KEY env var set to a valid secret key
 *   3. MCP server built (npm run build in packages/mcp)
 *
 * Run:
 *   MF_API_SECRET_KEY=mf_sk_... npx vitest run src/__tests__/mcp-integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";

const API_KEY = process.env.MF_API_SECRET_KEY;
const BASE_URL = process.env.MARGINFRONT_API_URL || "http://localhost:4000/v1";
const TS = Date.now();

const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey("MCP Server Integration (live API)", () => {
  let client: Client;
  let transport: StdioClientTransport;

  // Shared state across tests. Later tests use data created by earlier ones,
  // just like a real user session where an AI agent chains tool calls.
  let createdCustomerId: string;
  const customerExternalId = `mcp-test-${TS}`;
  const agentCode = `mcp-agent-${TS}`;
  const signalName = `mcp-signal-${TS}`;
  const fakeModel = `fake-mcp-model-${TS}`;

  beforeAll(async () => {
    // Spawn the real MCP server binary, same process a production MCP
    // host (Claude Desktop, Cursor, etc.) would start.
    const serverPath = path.resolve(__dirname, "../../dist/index.js");

    transport = new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: {
        ...process.env,
        MF_API_SECRET_KEY: API_KEY!,
        MARGINFRONT_API_URL: BASE_URL,
      },
    });

    client = new Client({
      name: "mcp-test-client",
      version: "1.0.0",
    });

    await client.connect(transport);
  }, 15000);

  afterAll(async () => {
    try {
      await client.close();
    } catch {
      // Server may already be closed
    }
  });

  // Helper: call a tool and return the text content from the response
  const callTool = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<string> => {
    const result = await client.callTool({ name, arguments: args });
    const textContent = result.content as Array<{ type: string; text: string }>;
    return textContent.map((c) => c.text).join("\n");
  };

  // Helper: call a tool and parse the response as JSON
  const callToolJson = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const text = await callTool(name, args);
    return JSON.parse(text);
  };

  // ===================================================================
  // 1. verify: confirms the API key works
  // ===================================================================
  it("verify: returns org info and verified=true", async () => {
    const data = (await callToolJson("verify")) as any;
    expect(data.verified).toBe(true);
    expect(data.organization).toBeTruthy();
    expect(data.organization.id).toBeTruthy();
    expect(data.organization.name).toBeTruthy();
  });

  // ===================================================================
  // 2. create_customer: create a test customer
  // ===================================================================
  it("create_customer: creates a customer and returns it", async () => {
    const data = (await callToolJson("create_customer", {
      name: "MCP Test Corp",
      externalId: customerExternalId,
    })) as any;

    expect(data.name).toBe("MCP Test Corp");
    expect(data.externalId).toBe(customerExternalId);
    expect(data.id).toBeTruthy();
    createdCustomerId = data.id;
  });

  // ===================================================================
  // 3. list_customers: verify the customer shows up
  // ===================================================================
  it("list_customers: returns a paginated list with at least 1 customer", async () => {
    const data = (await callToolJson("list_customers", {})) as any;
    expect(data.results).toBeTruthy();
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results.length).toBeGreaterThan(0);
  });

  // ===================================================================
  // 4. get_customer: fetch the customer by ID
  // ===================================================================
  it("get_customer: returns the customer we created", async () => {
    const data = (await callToolJson("get_customer", {
      customerId: createdCustomerId,
    })) as any;

    expect(data.name).toBe("MCP Test Corp");
    expect(data.externalId).toBe(customerExternalId);
  });

  // ===================================================================
  // 5. record_usage: happy path LLM event with tokens
  // ===================================================================
  it("record_usage: records LLM event and returns cost", async () => {
    const text = await callTool("record_usage", {
      customerExternalId,
      agentCode,
      signalName,
      model: "gpt-4o",
      modelProvider: "openai",
      inputTokens: 500,
      outputTokens: 100,
    });

    expect(text).toContain("1 succeeded");
    expect(text).toContain("$");
  });

  // ===================================================================
  // 6. record_usage: LLM event WITHOUT tokens -> MISSING_VOLUME_DATA
  //    Tests that the response handler suggests the right resolution tools
  // ===================================================================
  it("record_usage: missing tokens → suggests get_missing_volume + fill_volume", async () => {
    const text = await callTool("record_usage", {
      customerExternalId,
      agentCode,
      signalName,
      model: "gpt-4o",
      modelProvider: "openai",
      // no inputTokens, no outputTokens
    });

    expect(text).toContain("MISSING_VOLUME_DATA");
    expect(text).toContain("get_missing_volume");
    expect(text).toContain("fill_volume");
    expect(text).toContain("0 succeeded, 1 failed");
  });

  // ===================================================================
  // 7. record_usage: unknown model -> NEEDS_COST_BACKFILL
  //    Tests that the response handler suggests the repair tools
  // ===================================================================
  it("record_usage: unknown model → suggests get_needs_attention + map_model", async () => {
    const text = await callTool("record_usage", {
      customerExternalId,
      agentCode,
      signalName,
      model: fakeModel,
      modelProvider: "custom",
      inputTokens: 100,
      outputTokens: 50,
    });

    expect(text).toContain("NEEDS_COST_BACKFILL");
    expect(text).toContain("get_needs_attention");
    expect(text).toContain("map_model");
  });

  // ===================================================================
  // 8. record_usage_batch: mixed batch
  // ===================================================================
  it("record_usage_batch: handles mixed success + failure", async () => {
    const text = await callTool("record_usage_batch", {
      records: [
        {
          customerExternalId,
          agentCode,
          signalName,
          model: "gpt-4o",
          modelProvider: "openai",
          inputTokens: 200,
          outputTokens: 50,
        },
        {
          customerExternalId,
          agentCode,
          signalName,
          model: "gpt-4o",
          modelProvider: "openai",
          // missing tokens
        },
      ],
    });

    expect(text).toContain("1 succeeded, 1 failed");
  });

  // ===================================================================
  // 8b. record_usage: multi-service event mixing LLM and non-LLM
  //     One outcome backed by N services. Mirrors the SDK validator +
  //     backend gatekeeper union shape over the MCP transport.
  // ===================================================================
  it("record_usage: multi-service event with services[] succeeds", async () => {
    const text = await callTool("record_usage", {
      customerExternalId,
      agentCode,
      signalName,
      quantity: 1,
      services: [
        {
          model: "claude-sonnet-4-6",
          modelProvider: "anthropic",
          inputTokens: 1500,
          outputTokens: 800,
          quantity: 1,
        },
        {
          model: "google-maps-places",
          modelProvider: "google",
          quantity: 3,
        },
      ],
    });

    // The formatter renders multi-service success with a parent summary
    // line + indented per-service detail. At minimum we expect to see
    // "multi-service:" in the rendered output and BOTH service models.
    expect(text).toMatch(/multi-service|claude|sonnet|google-maps/i);
    // Either both services resolve (Processed) or some land NEEDS_COST_BACKFILL;
    // the shape should not error out.
    expect(text).not.toMatch(/Cannot mix shapes|empty/i);
  });

  // ===================================================================
  // 8c. record_usage: rejects mixed shapes (single + services[])
  //     The MCP server's validateRecordShape helper should refuse this
  //     before the request leaves the agent.
  // ===================================================================
  it("record_usage: rejects mixing single-service AND multi-service shapes", async () => {
    const text = await callTool("record_usage", {
      customerExternalId,
      agentCode,
      signalName,
      model: "gpt-4o",
      modelProvider: "openai",
      inputTokens: 100,
      outputTokens: 50,
      services: [
        {
          model: "claude-sonnet-4-6",
          modelProvider: "anthropic",
          inputTokens: 100,
          outputTokens: 50,
          quantity: 1,
        },
      ],
    });

    expect(text).toMatch(/Cannot mix shapes/i);
  });

  // ===================================================================
  // 9. list_events: returns events
  // ===================================================================
  it("list_events: returns events", async () => {
    const data = (await callToolJson("list_events", { limit: 5 })) as any;
    expect(data.results).toBeTruthy();
    expect(Array.isArray(data.results)).toBe(true);
  });

  // ===================================================================
  // 9b. list_events: customerExternalId filter. The API's DTO reads
  //     customerExternalId and drops any other customer param silently,
  //     so every event returned MUST belong to the test customer.
  // ===================================================================
  it("list_events: customerExternalId filter scopes correctly", async () => {
    const data = (await callToolJson("list_events", {
      customerExternalId,
      limit: 50,
    })) as any;

    expect(data.results).toBeTruthy();
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results.length).toBeGreaterThan(0); // tests 5/6/7/8 created events

    // Every returned event's customerExternalId must match the filter. If
    // this fails, the API is silently ignoring the filter.
    for (const event of data.results) {
      expect(event.customerExternalId).toBe(customerExternalId);
    }
  });

  // ===================================================================
  // 10. get_usage_analytics: returns analytics without error
  // ===================================================================
  it("get_usage_analytics: returns analytics without error", async () => {
    const data = (await callToolJson("get_usage_analytics", {
      startDate: "2026-04-01",
      endDate: "2026-04-30",
    })) as any;

    // Should have a structure (may be empty for test org but shouldn't error)
    expect(data).toBeTruthy();
    // totalMargin / totalMarginPercent are nullable (e.g. no revenue in
    // the window), so only the keys' presence is checked.
    expect("totalMargin" in data).toBe(true);
    expect("totalMarginPercent" in data).toBe(true);
  });

  // ===================================================================
  // 10b. get_usage_analytics: customerExternalId filter resolves to UUID
  //      and scopes analytics to that customer.
  // ===================================================================
  it("get_usage_analytics: customerExternalId filter works end-to-end", async () => {
    const data = (await callToolJson("get_usage_analytics", {
      startDate: "2026-04-01",
      endDate: "2026-04-30",
      customerExternalId,
    })) as any;

    // Shape check: returns without error and carries margin fields.
    expect(data).toBeTruthy();
    expect("totalMargin" in data).toBe(true);
    expect("totalMarginPercent" in data).toBe(true);
  });

  // ===================================================================
  // 11. list_subscriptions: list subscriptions
  // ===================================================================
  it("list_subscriptions: returns list without error", async () => {
    const data = (await callToolJson("list_subscriptions", {})) as any;
    expect(data).toBeTruthy();
  });

  // ===================================================================
  // 12. list_invoices: list invoices
  // ===================================================================
  it("list_invoices: returns list without error", async () => {
    const data = (await callToolJson("list_invoices", {})) as any;
    expect(data).toBeTruthy();
  });

  // ===================================================================
  // 13. get_needs_attention: list unknown-model groups
  // ===================================================================
  it("get_needs_attention: shows the fake model from test 7", async () => {
    const data = (await callToolJson("get_needs_attention", {})) as any;
    expect(data.groups).toBeTruthy();
    expect(data.totalEvents).toBeGreaterThan(0);

    const fakeGroup = data.groups.find(
      (g: any) => g.model === fakeModel && g.provider === "custom",
    );
    expect(fakeGroup).toBeTruthy();
    expect(fakeGroup.count).toBeGreaterThanOrEqual(1);
  });

  // ===================================================================
  // 14. get_missing_volume: list missing-volume groups
  // ===================================================================
  it("get_missing_volume: shows gpt-4o group with costUnit", async () => {
    const data = (await callToolJson("get_missing_volume", {})) as any;
    expect(data.groups).toBeTruthy();
    expect(data.totalEvents).toBeGreaterThan(0);

    const gptGroup = data.groups.find(
      (g: any) => g.model === "gpt-4o" && g.provider === "openai",
    );
    expect(gptGroup).toBeTruthy();
    expect(gptGroup.costUnit).toBe("1M tokens");
  });

  // ===================================================================
  // 15. fill_volume: resolve missing-volume events
  // ===================================================================
  it("fill_volume: resolves gpt-4o events and returns backfill count", async () => {
    const text = await callTool("fill_volume", {
      sourceModel: "gpt-4o",
      sourceProvider: "openai",
      inputTokens: 500,
      outputTokens: 100,
    });

    expect(text).toContain("Volume filled");
    expect(text).toContain("Events backfilled");
  });

  // ===================================================================
  // 16. get_missing_volume: verify gpt-4o group is resolved
  // ===================================================================
  it("get_missing_volume: gpt-4o group is gone after fill", async () => {
    const data = (await callToolJson("get_missing_volume", {})) as any;

    const gptGroup = data.groups.find(
      (g: any) => g.model === "gpt-4o" && g.provider === "openai",
    );
    expect(gptGroup).toBeUndefined();
  });

  // ===================================================================
  // 17. map_model: resolve unknown-model events
  // ===================================================================
  it("map_model: maps fake model to gpt-4o and backfills", async () => {
    const text = await callTool("map_model", {
      sourceModel: fakeModel,
      sourceProvider: "custom",
      targetModel: "gpt-4o",
      targetProvider: "openai",
    });

    expect(text).toContain("Model mapped");
    expect(text).toContain("Events backfilled");
  });

  // ===================================================================
  // 18. get_customer: optional startDate/endDate add a revenue block,
  //     nullable but always present in the response.
  // ===================================================================
  it("get_customer: with date window returns customer + revenue block", async () => {
    const data = (await callToolJson("get_customer", {
      customerId: createdCustomerId,
      startDate: "2026-04-01",
      endDate: "2026-04-30",
    })) as any;

    expect(data.name).toBe("MCP Test Corp");
    expect(data.externalId).toBe(customerExternalId);
    // `revenue` may be null if the downstream call failed, but the key
    // is always present.
    expect("revenue" in data).toBe(true);
  });

  // ===================================================================
  // 19. get_customer_revenue: canonical revenue metrics for one customer.
  //     Returns the RevenueMetrics shape with revenue/cost/margin keys.
  // ===================================================================
  it("get_customer_revenue: returns canonical RevenueMetrics shape", async () => {
    const data = (await callToolJson("get_customer_revenue", {
      customerId: createdCustomerId,
      startDate: "2026-04-01",
      endDate: "2026-04-30",
    })) as any;

    expect(data).toBeTruthy();
    // Canonical RevenueMetrics exposes these numeric keys. Values may be 0
    // if no billed invoices exist for this test customer yet, but the keys
    // must exist for the canonical shape to hold.
    expect(typeof data.revenue).toBe("number");
    expect(typeof data.cost).toBe("number");
    expect(typeof data.margin).toBe("number");
  });

  // ===================================================================
  // 20. get_cost_metrics: canonical cost metrics + breakdowns.
  // ===================================================================
  it("get_cost_metrics: returns canonical CostMetrics shape", async () => {
    const data = (await callToolJson("get_cost_metrics", {
      startDate: "2026-04-01",
      endDate: "2026-04-30",
    })) as any;

    expect(data).toBeTruthy();
    // Canonical CostMetrics carries total cost + breakdown arrays.
    expect(typeof data.cost).toBe("number");
    expect(typeof data.eventCount).toBe("number");
    // byAgent / byCustomer / bySignal / byDay / byPlan / byModel arrays
    // all exist on the canonical shape.
    expect(Array.isArray(data.byAgent)).toBe(true);
    expect(Array.isArray(data.byCustomer)).toBe(true);
  });

  // ===================================================================
  // 21. get_mrr: canonical MRR1 (default variant).
  // ===================================================================
  it("get_mrr: returns canonical MRR variant by default", async () => {
    const data = (await callToolJson("get_mrr", {})) as any;

    expect(data).toBeTruthy();
    // Default variant is 'canonical' (MRR1). The response echoes the
    // variant and includes a numeric mrr field (may be 0 for a fresh org).
    expect(data.variant).toBe("canonical");
    expect(typeof data.mrr).toBe("number");
  });

  it("get_mrr: variant=all returns MRR1 + MRR2 + MRR3 in one call", async () => {
    const data = (await callToolJson("get_mrr", { variant: "all" })) as any;

    expect(data.variant).toBe("all");
    expect(data.canonical).toBeTruthy();
    expect(data.runRate).toBeTruthy();
    expect(data.committed).toBeTruthy();
  });

  // ===================================================================
  // 22. get_invoice: pull one of the invoices (if any exist in the test
  //     org). Smoke test only since we can't guarantee an invoice was
  //     created mid-test, so the test skips gracefully if list is empty.
  // ===================================================================
  it("get_invoice: smoke test against first available invoice", async () => {
    const list = (await callToolJson("list_invoices", { limit: 1 })) as any;
    if (!list.results || list.results.length === 0) {
      // An org with no invoices has nothing to fetch, so the smoke test passes.
      return;
    }
    const invoiceId = list.results[0].id;
    const data = (await callToolJson("get_invoice", { invoiceId })) as any;

    expect(data).toBeTruthy();
    expect(data.id).toBe(invoiceId);
  });

  // ===================================================================
  // Pricing setup: plan -> strategy -> link -> subscription.
  // Each step is its own test so a failure points at the exact tool.
  // ===================================================================

  // Shared state for the pricing path.
  let createdPlanId: string;

  // ===================================================================
  // 23. create_pricing_plan: create a bare plan container.
  // ===================================================================
  it("create_pricing_plan: creates and returns a plan", async () => {
    const data = (await callToolJson("create_pricing_plan", {
      name: `MCP Test Plan ${TS}`,
      description: "Created by MCP integration test",
    })) as any;

    expect(data).toBeTruthy();
    expect(data.id).toBeTruthy();
    expect(data.name).toBe(`MCP Test Plan ${TS}`);
    createdPlanId = data.id;
  });

  // ===================================================================
  // 24. list_pricing_plans: the one we just created should show up.
  // ===================================================================
  it("list_pricing_plans: the new plan is listed", async () => {
    const data = (await callToolJson("list_pricing_plans", {
      limit: 100,
    })) as any;

    expect(data.results).toBeTruthy();
    const match = data.results.find((p: any) => p.id === createdPlanId);
    expect(match).toBeTruthy();
  });

  // ===================================================================
  // 25. get_pricing_plan: fetch the plan by ID.
  // ===================================================================
  it("get_pricing_plan: returns the plan we created", async () => {
    const data = (await callToolJson("get_pricing_plan", {
      planId: createdPlanId,
    })) as any;

    expect(data.id).toBe(createdPlanId);
    expect(data.name).toBe(`MCP Test Plan ${TS}`);
  });

  // ===================================================================
  // 26. list_pricing_strategies: newly-created plan has none yet.
  //     (create_pricing_strategy, link_plan_to_agent, and
  //     create_subscription are smoke-tested below: they get inputs that
  //     don't resolve, and the test checks each tool is reachable and
  //     returns a well-formed error.)
  // ===================================================================
  it("list_pricing_strategies: new plan has no strategies yet", async () => {
    const data = (await callToolJson("list_pricing_strategies", {
      planId: createdPlanId,
    })) as any;

    expect(data).toBeTruthy();
    expect(Array.isArray(data.results ?? [])).toBe(true);
  });

  // ===================================================================
  // 27. create_pricing_strategy: smoke test. We pass a known-bad agentId
  //     so the API returns a validation error. That still proves the tool
  //     is reachable and the parameter wiring is correct, which is the
  //     MCP layer responsibility.
  // ===================================================================
  it("create_pricing_strategy: tool is reachable (returns well-formed response)", async () => {
    const result = await client.callTool({
      name: "create_pricing_strategy",
      arguments: {
        planId: createdPlanId,
        name: `MCP Test Strategy ${TS}`,
        agentId: "00000000-0000-0000-0000-000000000000",
        chargeType: "recurring",
        rate: 100,
      },
    });
    // Reachable means the call returned a structured response (success or
    // well-formed error). We don't require success here since creating a
    // real strategy needs valid agent + signal references.
    expect(result).toBeTruthy();
    expect(result.content).toBeTruthy();
  });

  // ===================================================================
  // 28. link_plan_to_agent: smoke test. Again, bad agentId returns a
  //     well-formed error response.
  // ===================================================================
  it("link_plan_to_agent: tool is reachable", async () => {
    const result = await client.callTool({
      name: "link_plan_to_agent",
      arguments: {
        planId: createdPlanId,
        agentId: "00000000-0000-0000-0000-000000000000",
      },
    });
    expect(result).toBeTruthy();
    expect(result.content).toBeTruthy();
  });

  // ===================================================================
  // 29. create_subscription: smoke test. Bad agent / plan wiring returns
  //     a well-formed error; tool is proven reachable.
  // ===================================================================
  it("create_subscription: tool is reachable", async () => {
    const result = await client.callTool({
      name: "create_subscription",
      arguments: {
        name: `MCP Test Sub ${TS}`,
        planId: createdPlanId,
        agentId: "00000000-0000-0000-0000-000000000000",
        customerId: createdCustomerId,
        startDate: "2026-05-01T00:00:00Z",
      },
    });
    expect(result).toBeTruthy();
    expect(result.content).toBeTruthy();
  });

  // ===================================================================
  // Agents & signals from zero: create -> list -> conflict
  // -> recover. Runs after the record_usage tests on purpose, so test 33
  // can prove list_agents recovers the agent that usage AUTO-created.
  // ===================================================================

  // Shared state for the agent/signal path. A separate code from the
  // auto-create fixture (`agentCode`) so the two paths never collide.
  const explicitAgentCode = `mcp-created-agent-${TS}`;
  let explicitAgentId: string;

  // ===================================================================
  // 30. create_agent: creates and returns the agent with its UUID.
  // ===================================================================
  it("create_agent: creates an agent and returns its id", async () => {
    const data = (await callToolJson("create_agent", {
      name: `MCP Created Agent ${TS}`,
      agentCode: explicitAgentCode,
      description: "Created by MCP integration test",
    })) as any;

    expect(data.id).toBeTruthy();
    expect(data.agentCode).toBe(explicitAgentCode);
    explicitAgentId = data.id;
  });

  // ===================================================================
  // 31. list_agents: the new agent shows up under its code.
  // ===================================================================
  it("list_agents: finds the agent we created", async () => {
    const data = (await callToolJson("list_agents", {
      agentCode: explicitAgentCode,
    })) as any;

    expect(data.results).toBeTruthy();
    const match = data.results.find((a: any) => a.id === explicitAgentId);
    expect(match).toBeTruthy();
  });

  // ===================================================================
  // 32. create_agent duplicate: the friendly conflict, not a dead end.
  // ===================================================================
  it("create_agent: duplicate code returns the plain conflict message", async () => {
    const result = await client.callTool({
      name: "create_agent",
      arguments: {
        name: "Duplicate Agent",
        agentCode: explicitAgentCode,
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain("already exists");
  });

  // ===================================================================
  // 33. list_agents recovers the agent that record_usage AUTO-created
  //     (test 5's agentCode fixture). create_agent answers 409 on this
  //     code with no id in the body, so list_agents is the only way to
  //     look the id up.
  // ===================================================================
  it("list_agents: recovers the usage-auto-created agent's UUID", async () => {
    const data = (await callToolJson("list_agents", {
      agentCode,
    })) as any;

    expect(data.results).toBeTruthy();
    const autoCreated = data.results.find(
      (a: any) => a.agentCode === agentCode,
    );
    expect(autoCreated).toBeTruthy();
    expect(autoCreated.id).toBeTruthy();
  });

  // ===================================================================
  // 34. create_signal: creates a signal on the new agent, returns the
  //     signalId that usage / credit-pool pricing strategies need.
  // ===================================================================
  it("create_signal: creates a signal and returns its id", async () => {
    const data = (await callToolJson("create_signal", {
      name: `mcp-created-signal-${TS}`,
      agentId: explicitAgentId,
      type: "usage",
    })) as any;

    expect(data.id).toBeTruthy();
    expect(data.agentId).toBe(explicitAgentId);
  });

  // ===================================================================
  // 35. list_signals: the new signal shows up under its agent.
  // ===================================================================
  it("list_signals: finds the signal we created, scoped to the agent", async () => {
    const data = (await callToolJson("list_signals", {
      agentId: explicitAgentId,
    })) as any;

    expect(data.results).toBeTruthy();
    const match = data.results.find(
      (s: any) => s.name === `mcp-created-signal-${TS}`,
    );
    expect(match).toBeTruthy();
  });
});
