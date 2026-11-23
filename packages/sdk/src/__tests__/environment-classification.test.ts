/**
 * Environment Classification Tests
 *
 * Proves the SDK forwards the optional `environment` field on usage events
 * through to the `/usage/record` payload unchanged. The API uses this field
 * to auto-classify the parent signal's `costCategory` (PRODUCTION_COGS vs
 * DEVELOPMENT_RD) for accounting purposes (COGS vs OpEx).
 *
 * Unit-style: mocks the HttpClient so the assertions can inspect the exact
 * payload that would have hit the API. No live server required.
 */

import { describe, it, expect, vi } from "vitest";
import { UsageResource } from "../resources/usage";
import type { HttpClient } from "../utils/http";
import type { UsageRecord, UsageEnvironment } from "../types";

const baseLLMRecord: UsageRecord = {
  customerExternalId: "cust-123",
  agentCode: "agent-abc",
  signalName: "api_call",
  model: "gpt-4o",
  modelProvider: "openai",
  inputTokens: 100,
  outputTokens: 50,
};

const baseMultiServiceRecord: UsageRecord = {
  customerExternalId: "cust-456",
  agentCode: "research-agent",
  signalName: "reports-delivered",
  services: [
    { model: "web-search", modelProvider: "search-api", quantity: 1 },
    {
      model: "claude-opus-4-1",
      modelProvider: "anthropic",
      inputTokens: 4500,
      outputTokens: 1200,
      quantity: 1,
    },
  ],
};

function mockHttpCapture() {
  const captured: { path: string; body: unknown }[] = [];
  const http: Pick<HttpClient, "post"> = {
    post: vi.fn(async (path: string, body?: unknown) => {
      captured.push({ path, body });
      return {
        processed: 1,
        successful: 1,
        failed: 0,
        results: {
          success: [
            {
              customerExternalId: "cust-123",
              agentCode: "agent-abc",
              signalName: "api_call",
              quantity: 1,
              eventId: "evt_test",
              rawEventId: "raw_test",
              timestamp: new Date().toISOString(),
            },
          ],
          failed: [],
        },
      };
    }) as HttpClient["post"],
  };
  return { http: http as HttpClient, captured };
}

describe("environment field forwarding", () => {
  it("forwards environment=production on a single-service LLM event", async () => {
    const { http, captured } = mockHttpCapture();
    const usage = new UsageResource(http, false, null, { warn: vi.fn() });

    await usage.trackEvent({
      ...baseLLMRecord,
      environment: "production",
    });

    expect(captured.length).toBe(1);
    expect(captured[0].path).toBe("/usage/record");
    const sentRecords = (captured[0].body as { records: UsageRecord[] })
      .records;
    expect(sentRecords[0].environment).toBe("production");
  });

  it("forwards environment=development on a single-service LLM event", async () => {
    const { http, captured } = mockHttpCapture();
    const usage = new UsageResource(http, false, null, { warn: vi.fn() });

    await usage.trackEvent({
      ...baseLLMRecord,
      environment: "development",
    });

    const sentRecords = (captured[0].body as { records: UsageRecord[] })
      .records;
    expect(sentRecords[0].environment).toBe("development");
  });

  it("forwards environment=staging on a single-service LLM event", async () => {
    const { http, captured } = mockHttpCapture();
    const usage = new UsageResource(http, false, null, { warn: vi.fn() });

    await usage.trackEvent({
      ...baseLLMRecord,
      environment: "staging",
    });

    const sentRecords = (captured[0].body as { records: UsageRecord[] })
      .records;
    expect(sentRecords[0].environment).toBe("staging");
  });

  it("forwards environment=testing on a single-service LLM event", async () => {
    const { http, captured } = mockHttpCapture();
    const usage = new UsageResource(http, false, null, { warn: vi.fn() });

    await usage.trackEvent({
      ...baseLLMRecord,
      environment: "testing",
    });

    const sentRecords = (captured[0].body as { records: UsageRecord[] })
      .records;
    expect(sentRecords[0].environment).toBe("testing");
  });

  it("forwards environment on a multi-service event", async () => {
    const { http, captured } = mockHttpCapture();
    const usage = new UsageResource(http, false, null, { warn: vi.fn() });

    await usage.trackEvent({
      ...baseMultiServiceRecord,
      environment: "production",
    });

    const sentRecords = (captured[0].body as { records: UsageRecord[] })
      .records;
    expect(sentRecords[0].environment).toBe("production");
    expect(sentRecords[0].services).toHaveLength(2);
  });

  it("forwards environment on each record in a batch", async () => {
    const { http, captured } = mockHttpCapture();
    const usage = new UsageResource(http, false, null, { warn: vi.fn() });

    await usage.trackEvent({
      records: [
        { ...baseLLMRecord, environment: "production" },
        { ...baseLLMRecord, environment: "development" },
        { ...baseLLMRecord }, // intentionally no environment
      ],
    });

    const sentRecords = (captured[0].body as { records: UsageRecord[] })
      .records;
    expect(sentRecords[0].environment).toBe("production");
    expect(sentRecords[1].environment).toBe("development");
    expect(sentRecords[2].environment).toBeUndefined();
  });

  it("omits environment from payload when not provided (no default injected)", async () => {
    const { http, captured } = mockHttpCapture();
    const usage = new UsageResource(http, false, null, { warn: vi.fn() });

    await usage.trackEvent(baseLLMRecord);

    const sentRecords = (captured[0].body as { records: UsageRecord[] })
      .records;
    expect(sentRecords[0].environment).toBeUndefined();
  });

  it("forwards environment through usage.record() (legacy path)", async () => {
    const { http, captured } = mockHttpCapture();
    const usage = new UsageResource(http, false, null, { warn: vi.fn() });

    await usage.record({
      ...baseLLMRecord,
      environment: "production",
    });

    const sentRecords = (captured[0].body as { records: UsageRecord[] })
      .records;
    expect(sentRecords[0].environment).toBe("production");
  });

  it("forwards environment through usage.recordBatch() (legacy path)", async () => {
    const { http, captured } = mockHttpCapture();
    const usage = new UsageResource(http, false, null, { warn: vi.fn() });

    await usage.recordBatch([
      { ...baseLLMRecord, environment: "production" },
      { ...baseLLMRecord, environment: "testing" },
    ]);

    const sentRecords = (captured[0].body as { records: UsageRecord[] })
      .records;
    expect(sentRecords[0].environment).toBe("production");
    expect(sentRecords[1].environment).toBe("testing");
  });

  it("accepts every UsageEnvironment literal at the type level", () => {
    const envs: UsageEnvironment[] = [
      "production",
      "staging",
      "development",
      "testing",
    ];
    expect(envs).toHaveLength(4);
  });
});
