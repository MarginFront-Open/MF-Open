/**
 * Volume Validation Integration Tests
 *
 * Tests that the API enforces volume field requirements:
 *   - LLM models (costUnit = "1M tokens") require inputTokens + outputTokens
 *   - Non-LLM services require quantity
 *   - Missing volume → MISSING_VOLUME_DATA (stored, cost=null)
 *   - Explicit zero → PROCESSED (zero is a valid value, not "missing")
 *
 * Prerequisites:
 *   1. api-nest running on localhost:4000
 *   2. MF_TEST_SECRET_KEY env var set to a valid secret key
 *   3. "gpt-4o" (openai) and "websearch" (tool) in service_pricing, which
 *      `npm run db:setup` loads
 *
 * Run:
 *   MF_TEST_SECRET_KEY=mf_sk_test_... npx vitest run src/__tests__/volume-validation.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { MarginFrontClient } from "../client";

const API_KEY = process.env.MF_TEST_SECRET_KEY;
const BASE_URL = process.env.MF_TEST_BASE_URL || "http://localhost:4000/v1";
const TS = Date.now();

const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey("Volume Validation (live API)", () => {
  let client: MarginFrontClient;
  const customerExternalId = `vol-test-${TS}`;
  const agentCode = `vol-test-agent-${TS}`;
  const signalName = `vol-test-signal-${TS}`;

  beforeAll(() => {
    client = new MarginFrontClient({
      apiKey: API_KEY!,
      baseUrl: BASE_URL,
      fireAndForget: false,
      timeout: 10000,
      retries: 0,
    });
  });

  // -------------------------------------------------------------------
  // 1. LLM missing BOTH tokens → MISSING_VOLUME_DATA
  // -------------------------------------------------------------------
  it("rejects LLM event missing both inputTokens and outputTokens", async () => {
    const result = await client.usage.record({
      customerExternalId,
      agentCode,
      signalName,
      model: "gpt-4o",
      modelProvider: "openai",
      // no inputTokens, no outputTokens
    });

    expect(result.processed).toBe(1);
    expect(result.successful).toBe(0);
    expect(result.failed).toBe(1);

    const failed = result.results.failed[0] as any;
    expect(failed.code).toBe("MISSING_VOLUME_DATA");
    expect(failed.stored).toBe(true);
    expect(failed.eventId).toBeTruthy();
    expect(failed.error).toContain("inputTokens");
    expect(failed.error).toContain("outputTokens");
  });

  // -------------------------------------------------------------------
  // 2. LLM missing outputTokens only → MISSING_VOLUME_DATA
  // -------------------------------------------------------------------
  it("rejects LLM event missing outputTokens", async () => {
    const result = await client.usage.record({
      customerExternalId,
      agentCode,
      signalName,
      model: "gpt-4o",
      modelProvider: "openai",
      inputTokens: 500,
      // no outputTokens
    });

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);

    const failed = result.results.failed[0] as any;
    expect(failed.code).toBe("MISSING_VOLUME_DATA");
    expect(failed.stored).toBe(true);
  });

  // -------------------------------------------------------------------
  // 3. LLM missing inputTokens only → MISSING_VOLUME_DATA
  // -------------------------------------------------------------------
  it("rejects LLM event missing inputTokens", async () => {
    const result = await client.usage.record({
      customerExternalId,
      agentCode,
      signalName,
      model: "gpt-4o",
      modelProvider: "openai",
      outputTokens: 100,
      // no inputTokens
    });

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);

    const failed = result.results.failed[0] as any;
    expect(failed.code).toBe("MISSING_VOLUME_DATA");
    expect(failed.stored).toBe(true);
  });

  // -------------------------------------------------------------------
  // 4. Non-LLM missing quantity → MISSING_VOLUME_DATA
  //
  // Uses direct HTTP instead of the SDK because the SDK intentionally
  // defaults quantity to 1 (usage.ts normalizeRecord). That's correct
  // fire-and-forget behavior — the SDK always sends complete data.
  // This test proves the API catches the issue for direct REST callers
  // (curl, Postman, custom integrations that skip the SDK).
  // -------------------------------------------------------------------
  it("rejects non-LLM event missing quantity (direct HTTP)", async () => {
    const response = await fetch(`${BASE_URL}/usage/record`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY!,
      },
      body: JSON.stringify({
        records: [
          {
            customerExternalId,
            agentCode,
            signalName,
            model: "WebSearch",
            modelProvider: "tool",
            // no quantity — a direct API caller might forget this
          },
        ],
      }),
    });

    const result = await response.json();

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);

    const failed = result.results.failed[0] as any;
    expect(failed.code).toBe("MISSING_VOLUME_DATA");
    expect(failed.stored).toBe(true);
    expect(failed.error).toContain("quantity");
  });

  // -------------------------------------------------------------------
  // 5. LLM with tokens=0 → PROCESSED (explicit zero is valid)
  // -------------------------------------------------------------------
  it("accepts LLM event with explicit zero tokens", async () => {
    const result = await client.usage.record({
      customerExternalId,
      agentCode,
      signalName,
      model: "gpt-4o",
      modelProvider: "openai",
      inputTokens: 0,
      outputTokens: 0,
    });

    expect(result.processed).toBe(1);
    expect(result.successful).toBe(1);
    expect(result.failed).toBe(0);

    const success = result.results.success[0] as any;
    expect(success.totalCostUsd).toBe("0.0000000000");
  });

  // -------------------------------------------------------------------
  // 6. Non-LLM with quantity=0 → PROCESSED (explicit zero is valid)
  // -------------------------------------------------------------------
  it("accepts non-LLM event with explicit zero quantity", async () => {
    const result = await client.usage.record({
      customerExternalId,
      agentCode,
      signalName,
      model: "WebSearch",
      modelProvider: "tool",
      quantity: 0,
    });

    expect(result.processed).toBe(1);
    expect(result.successful).toBe(1);
    expect(result.failed).toBe(0);

    const success = result.results.success[0] as any;
    expect(success.totalCostUsd).toBe("0.0000000000");
  });

  // -------------------------------------------------------------------
  // 7. Happy path LLM
  // -------------------------------------------------------------------
  it("processes LLM event with tokens normally", async () => {
    const result = await client.usage.record({
      customerExternalId,
      agentCode,
      signalName,
      model: "gpt-4o",
      modelProvider: "openai",
      inputTokens: 500,
      outputTokens: 100,
    });

    expect(result.processed).toBe(1);
    expect(result.successful).toBe(1);
    expect(result.failed).toBe(0);

    const success = result.results.success[0] as any;
    expect(Number(success.totalCostUsd)).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------
  // 8. Unknown model → NEEDS_COST_BACKFILL
  // -------------------------------------------------------------------
  it("flags unknown model as NEEDS_COST_BACKFILL (not MISSING_VOLUME_DATA)", async () => {
    const result = await client.usage.record({
      customerExternalId,
      agentCode,
      signalName,
      model: `fake-model-${TS}`,
      modelProvider: "openai",
      inputTokens: 500,
      outputTokens: 100,
    });

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);

    const failed = result.results.failed[0] as any;
    expect(failed.code).toBe("NEEDS_COST_BACKFILL");
    expect(failed.stored).toBe(true);
  });

  // -------------------------------------------------------------------
  // 9. Mixed batch — different failure codes per record
  // -------------------------------------------------------------------
  it("handles mixed batch with correct code per record", async () => {
    const result = await client.usage.recordBatch([
      // Valid LLM event → PROCESSED
      {
        customerExternalId,
        agentCode,
        signalName,
        model: "gpt-4o",
        modelProvider: "openai",
        inputTokens: 200,
        outputTokens: 50,
      },
      // LLM missing tokens → MISSING_VOLUME_DATA
      {
        customerExternalId,
        agentCode,
        signalName,
        model: "gpt-4o",
        modelProvider: "openai",
        // no tokens
      },
      // Unknown model → NEEDS_COST_BACKFILL
      {
        customerExternalId,
        agentCode,
        signalName,
        model: `batch-unknown-${TS}`,
        modelProvider: "custom",
        inputTokens: 100,
        outputTokens: 50,
      },
    ]);

    expect(result.processed).toBe(3);
    expect(result.successful).toBe(1);
    expect(result.failed).toBe(2);

    // Check the two failures have different codes
    const codes = result.results.failed.map((f: any) => f.code).sort();
    expect(codes).toEqual(["MISSING_VOLUME_DATA", "NEEDS_COST_BACKFILL"]);
  });

  // ===================================================================
  // RESOLUTION TESTS — fill-volume endpoint
  //
  // These test the full cycle: send a bad event → verify it's stored as
  // MISSING_VOLUME_DATA → call fill-volume → verify it becomes PROCESSED.
  // Uses direct HTTP because the SDK doesn't have resolution methods.
  // ===================================================================

  // -------------------------------------------------------------------
  // 10. GET /events/missing-volume returns groups
  // -------------------------------------------------------------------
  it("lists missing-volume groups via GET /events/missing-volume", async () => {
    // Tests 1-3 already created MISSING_VOLUME_DATA events for gpt-4o/openai
    const response = await fetch(`${BASE_URL}/events/missing-volume`, {
      headers: { "X-API-Key": API_KEY! },
    });

    expect(response.ok).toBe(true);
    const data = await response.json();

    expect(data.totalEvents).toBeGreaterThan(0);
    expect(data.groups.length).toBeGreaterThan(0);

    // Find the gpt-4o group — should have costUnit from service_pricing
    const gpt4oGroup = data.groups.find(
      (g: any) => g.model === "gpt-4o" && g.provider === "openai",
    );
    expect(gpt4oGroup).toBeTruthy();
    expect(gpt4oGroup.costUnit).toBe("1M tokens");
    expect(gpt4oGroup.count).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------
  // 11. POST /events/fill-volume resolves LLM events
  // -------------------------------------------------------------------
  it("fills LLM volume and resolves events to PROCESSED", async () => {
    const response = await fetch(`${BASE_URL}/events/fill-volume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY!,
      },
      body: JSON.stringify({
        sourceModel: "gpt-4o",
        sourceProvider: "openai",
        inputTokens: 500,
        outputTokens: 100,
      }),
    });

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.backfilled).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------
  // 12. After fill, GET /events/missing-volume shows fewer (or zero) events
  // -------------------------------------------------------------------
  it("shows zero gpt-4o missing-volume events after fill", async () => {
    const response = await fetch(`${BASE_URL}/events/missing-volume`, {
      headers: { "X-API-Key": API_KEY! },
    });

    const data = await response.json();
    const gpt4oGroup = data.groups.find(
      (g: any) => g.model === "gpt-4o" && g.provider === "openai",
    );
    // All gpt-4o events should be resolved now
    expect(gpt4oGroup).toBeUndefined();
  });

  // -------------------------------------------------------------------
  // 13. Fill non-LLM volume resolves events
  // -------------------------------------------------------------------
  it("fills non-LLM volume and resolves events to PROCESSED", async () => {
    // First create a non-LLM MISSING_VOLUME_DATA event (via direct HTTP)
    await fetch(`${BASE_URL}/usage/record`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY!,
      },
      body: JSON.stringify({
        records: [
          {
            customerExternalId,
            agentCode,
            signalName,
            model: "WebSearch",
            modelProvider: "tool",
            // no quantity
          },
        ],
      }),
    });

    // Fill it
    const fillResponse = await fetch(`${BASE_URL}/events/fill-volume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY!,
      },
      body: JSON.stringify({
        sourceModel: "WebSearch",
        sourceProvider: "tool",
        quantity: 5,
      }),
    });

    expect(fillResponse.ok).toBe(true);
    const data = await fillResponse.json();
    expect(data.backfilled).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // 14. Fill with wrong volume type is rejected
  // -------------------------------------------------------------------
  it("rejects fill-volume with wrong fields for service type", async () => {
    // Create another LLM MISSING_VOLUME_DATA event first
    await client.usage.record({
      customerExternalId,
      agentCode,
      signalName,
      model: "gpt-4o",
      modelProvider: "openai",
      // no tokens → MISSING_VOLUME_DATA
    });

    // Try to fill an LLM model with quantity instead of tokens
    const response = await fetch(`${BASE_URL}/events/fill-volume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY!,
      },
      body: JSON.stringify({
        sourceModel: "gpt-4o",
        sourceProvider: "openai",
        quantity: 5,
        // missing inputTokens and outputTokens
      }),
    });

    expect(response.status).toBe(400);
  });
});
