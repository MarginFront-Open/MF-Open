/**
 * SDK Integration Tests
 *
 * These tests hit the REAL API server (localhost:4000) through the SDK.
 * They prove the SDK correctly wraps every endpoint we ship.
 *
 * Prerequisites:
 *   1. api-nest running on localhost:4000
 *   2. MF_TEST_SECRET_KEY env var set to a valid secret key
 *
 * Run:
 *   MF_TEST_SECRET_KEY=mf_sk_test_... npx vitest run src/__tests__/integration.test.ts
 *
 * Skip in CI (no API server):
 *   These tests are skipped when MF_TEST_SECRET_KEY is not set.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarginFrontClient } from "../client";
import type { UsageRecord } from "../types";

// Accept either env var so the same export works for SDK + MCP integration runs.
const API_KEY = process.env.MF_TEST_SECRET_KEY || process.env.MF_API_SECRET_KEY;
const BASE_URL =
  process.env.MF_TEST_BASE_URL ||
  process.env.MARGINFRONT_API_URL ||
  "http://localhost:4000/v1";
const TS = Date.now();

// Skip the entire suite if no API key is configured
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey("SDK Integration (live API)", () => {
  let client: MarginFrontClient;
  let customerId: string;
  let customerExternalId: string;

  beforeAll(async () => {
    client = new MarginFrontClient({
      apiKey: API_KEY!,
      baseUrl: BASE_URL,
      fireAndForget: false, // We WANT errors to throw so tests can catch them
      timeout: 10000,
      retries: 0, // No retries — fail fast in tests
    });

    customerExternalId = `sdk-test-${TS}`;
  });

  // -------------------------------------------------------------------
  // 1. Verify
  // -------------------------------------------------------------------
  it("verifies the API key and returns org info", async () => {
    const result = await client.verify();
    expect(result.verified).toBe(true);
    expect(result.organization).toBeDefined();
    expect(result.organization.id).toBeTruthy();
    expect(result.organization.name).toBeTruthy();
  });

  // -------------------------------------------------------------------
  // 2. Customers
  // -------------------------------------------------------------------
  it("creates a customer", async () => {
    const customer = await client.customers.create({
      name: `SDK Test Customer ${TS}`,
      externalId: customerExternalId,
      email: `sdk-test-${TS}@marginfront-test.invalid`,
    });
    expect(customer).toBeDefined();
    customerId = customer.id;
    expect(customerId).toBeTruthy();
  });

  it("lists customers and finds the one we created", async () => {
    const result = await client.customers.list({
      externalId: customerExternalId,
    });
    expect(result.data.length).toBeGreaterThanOrEqual(1);
    const found = result.data.find((c) => c.externalId === customerExternalId);
    expect(found).toBeDefined();
  });

  it("gets a customer by ID", async () => {
    const customer = await client.customers.get(customerId);
    expect(customer.id).toBe(customerId);
    expect(customer.name).toContain("SDK Test Customer");
  });

  it("updates a customer", async () => {
    const updated = await client.customers.update(customerId, {
      name: `SDK Test Customer Updated ${TS}`,
    });
    expect(updated.name).toContain("Updated");
  });

  // -------------------------------------------------------------------
  // 3. Usage Recording — known model
  // -------------------------------------------------------------------
  it("records a usage event with a known model and gets cost back", async () => {
    const result = await client.usage.record({
      customerExternalId,
      agentCode: `sdk-test-agent-${TS}`,
      signalName: `sdk-test-signal-${TS}`,
      model: "gpt-4o",
      modelProvider: "openai",
      inputTokens: 500,
      outputTokens: 100,
    });

    expect(result.successful).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results.success.length).toBe(1);
    expect(result.results.success[0].totalCostUsd).toBeTruthy();
    expect(result.results.success[0].eventId).toBeTruthy();
  });

  // -------------------------------------------------------------------
  // 4. Usage Recording — unknown model (NEEDS_COST_BACKFILL)
  // -------------------------------------------------------------------
  const unknownModel = `sdk-unknown-model-${TS}`;

  it("records an event with unknown model — stored, not dropped", async () => {
    const result = await client.usage.record({
      customerExternalId,
      agentCode: `sdk-test-agent-${TS}`,
      signalName: `sdk-test-signal-${TS}`,
      model: unknownModel,
      modelProvider: "openai",
      inputTokens: 100,
      outputTokens: 50,
    });

    // Event was processed but flagged as needing backfill
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.successful).toBe(0);
    expect(result.results.failed.length).toBe(1);

    const failed = result.results.failed[0] as any;
    expect(failed.code).toBe("NEEDS_COST_BACKFILL");
    expect(failed.stored).toBe(true);
    expect(failed.eventId).toBeTruthy();
  });

  // -------------------------------------------------------------------
  // 5. Usage Recording — batch with mixed results
  // -------------------------------------------------------------------
  it("records a batch with known + unknown models", async () => {
    const result = await client.usage.recordBatch([
      {
        customerExternalId,
        agentCode: `sdk-test-agent-${TS}`,
        signalName: `sdk-test-signal-${TS}`,
        model: "gpt-4o",
        modelProvider: "openai",
        inputTokens: 200,
        outputTokens: 50,
      },
      {
        customerExternalId,
        agentCode: `sdk-test-agent-${TS}`,
        signalName: `sdk-test-signal-${TS}`,
        model: `another-unknown-${TS}`,
        modelProvider: "custom",
        inputTokens: 100,
        outputTokens: 50,
      },
    ]);

    expect(result.processed).toBe(2);
    expect(result.successful).toBe(1);
    expect(result.failed).toBe(1);
  });

  // -------------------------------------------------------------------
  // 6. Validation — missing required fields
  // -------------------------------------------------------------------
  it("rejects missing modelProvider at the SDK level", () => {
    // TypeScript enforces this at compile time, but runtime validation
    // also catches it if someone bypasses types
    const badRecord = {
      customerExternalId,
      agentCode: `sdk-test-agent-${TS}`,
      signalName: `sdk-test-signal-${TS}`,
      model: "gpt-4o",
      modelProvider: "", // empty = invalid
      inputTokens: 100,
      outputTokens: 50,
    } as UsageRecord;

    expect(() => client.usage.record(badRecord)).rejects.toThrow(
      "modelProvider",
    );
  });

  // -------------------------------------------------------------------
  // 7. Invoices
  // -------------------------------------------------------------------
  it("lists invoices without error", async () => {
    const result = await client.invoices.list();
    expect(result).toBeDefined();
    expect(Array.isArray(result.invoices)).toBe(true);
  });

  // -------------------------------------------------------------------
  // 8. Analytics
  // -------------------------------------------------------------------
  it("fetches usage analytics", async () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const result = await client.analytics.usage({
      startDate: thirtyDaysAgo.toISOString(),
      endDate: now.toISOString(),
    });

    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();
    expect(result.summary.totalEvents).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------
  // 9. Subscriptions
  // -------------------------------------------------------------------
  it("lists subscriptions without error", async () => {
    const result = await client.subscriptions.list();
    expect(result).toBeDefined();
    expect(Array.isArray(result.subscriptions)).toBe(true);
  });

  // -------------------------------------------------------------------
  // 10. fireAndForget mode
  // -------------------------------------------------------------------
  it("fireAndForget client does not throw on network error", async () => {
    const fafClient = new MarginFrontClient({
      apiKey: API_KEY!,
      baseUrl: "http://localhost:99999/v1", // unreachable port
      fireAndForget: true,
      timeout: 2000,
      retries: 0,
    });

    // This should NOT throw — fireAndForget catches it
    const result = await fafClient.usage.record({
      customerExternalId: "test",
      agentCode: "test",
      signalName: "test",
      model: "gpt-4o",
      modelProvider: "openai",
      inputTokens: 1,
      outputTokens: 1,
    });

    // Returns empty response, not an error
    expect(result.processed).toBe(0);
  });

  // -------------------------------------------------------------------
  // 11. Multi-service events
  // -------------------------------------------------------------------
  //
  // For a priced result, first create a sourcing-bot agent, a sourcing-report
  // signal and a customer with a per-report subscription. Without them, events
  // still land via auto-provisioning.
  // -------------------------------------------------------------------
  const SANDBOX_CUSTOMER = "sandbox-customer-001";
  const SANDBOX_AGENT = "sourcing-bot";
  const SANDBOX_SIGNAL = "sourcing-report";

  const multiServiceEventIds: string[] = [];

  it("multi-service all LLM (Claude + GPT-4o)", async () => {
    const result = await client.usage.record({
      customerExternalId: SANDBOX_CUSTOMER,
      agentCode: SANDBOX_AGENT,
      signalName: SANDBOX_SIGNAL,
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
          model: "gpt-4o",
          modelProvider: "openai",
          inputTokens: 1000,
          outputTokens: 500,
          quantity: 1,
        },
      ],
    } as UsageRecord);

    expect(result.processed).toBe(1);
    const successOrFailed =
      (result.results.success[0] as any) || (result.results.failed[0] as any);
    expect(successOrFailed.eventId).toBeTruthy();
    if (result.results.success[0]) {
      const success = result.results.success[0] as any;
      expect(success.services).toHaveLength(2);
      expect(parseFloat(success.totalCostUsd)).toBeGreaterThan(0);
    }
    multiServiceEventIds.push(successOrFailed.eventId);
  });

  it("multi-service all non-LLM (web-search + page-fetch)", async () => {
    const result = await client.usage.record({
      customerExternalId: SANDBOX_CUSTOMER,
      agentCode: SANDBOX_AGENT,
      signalName: SANDBOX_SIGNAL,
      quantity: 1,
      services: [
        { model: "web-search", modelProvider: "search-api", quantity: 5 },
        { model: "page-fetch", modelProvider: "scraper-api", quantity: 3 },
      ],
    } as UsageRecord);

    expect(result.processed).toBe(1);
    // Non-LLM services may not be in service_pricing yet → NEEDS_COST_BACKFILL.
    // The shape works regardless of pricing-table coverage.
    const successOrFailed =
      (result.results.success[0] as any) || (result.results.failed[0] as any);
    expect(successOrFailed.eventId).toBeTruthy();
    multiServiceEventIds.push(successOrFailed.eventId);
  });

  it("multi-service mixing LLM + non-LLM", async () => {
    const result = await client.usage.record({
      customerExternalId: SANDBOX_CUSTOMER,
      agentCode: SANDBOX_AGENT,
      signalName: SANDBOX_SIGNAL,
      quantity: 1,
      services: [
        {
          model: "claude-sonnet-4-6",
          modelProvider: "anthropic",
          inputTokens: 1500,
          outputTokens: 800,
          quantity: 1,
        },
        { model: "google-maps-places", modelProvider: "google", quantity: 3 },
      ],
    } as UsageRecord);

    expect(result.processed).toBe(1);
    const successOrFailed =
      (result.results.success[0] as any) || (result.results.failed[0] as any);
    expect(successOrFailed.eventId).toBeTruthy();
    multiServiceEventIds.push(successOrFailed.eventId);
  });

  it("batch mixing single-service + multi-service entries", async () => {
    const result = await client.usage.recordBatch([
      {
        customerExternalId: SANDBOX_CUSTOMER,
        agentCode: SANDBOX_AGENT,
        signalName: SANDBOX_SIGNAL,
        model: "claude-sonnet-4-6",
        modelProvider: "anthropic",
        inputTokens: 500,
        outputTokens: 200,
      },
      {
        customerExternalId: SANDBOX_CUSTOMER,
        agentCode: SANDBOX_AGENT,
        signalName: SANDBOX_SIGNAL,
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
      },
    ] as UsageRecord[]);

    expect(result.processed).toBe(2);
    // Both should be stored regardless of cost-resolution status
    const total = result.results.success.length + result.results.failed.length;
    expect(total).toBe(2);
  });

  it("cost analytics reflect multi-service events", async () => {
    // Brief settle for raw_ingest → signal_events pipeline
    await new Promise((r) => setTimeout(r, 500));

    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Canonical cost endpoint. Uses costBreakdown(), not cost().
    const result = (await client.analytics.costBreakdown({
      startDate: dayAgo.toISOString(),
      endDate: now.toISOString(),
    })) as any;

    expect(result).toBeDefined();
    // cost is a non-negative number across all events in the window
    expect(typeof result.cost).toBe("number");
    expect(result.cost).toBeGreaterThanOrEqual(0);

    // byModel breakdown should be present and array-shaped
    expect(result.byModel).toBeDefined();
    expect(Array.isArray(result.byModel)).toBe(true);

    // After firing the multi-service tests above, at least one bucket
    // should mention claude/sonnet (the LLM service that resolves)
    const hasClaudeBucket = (result.byModel as any[]).some((b) =>
      /claude|sonnet/i.test(b.model ?? ""),
    );
    expect(hasClaudeBucket).toBe(true);
  });

  // -------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------
  afterAll(async () => {
    if (customerId) {
      try {
        await client.customers.delete(customerId);
      } catch {
        // Best-effort cleanup
      }
    }
  });
});
