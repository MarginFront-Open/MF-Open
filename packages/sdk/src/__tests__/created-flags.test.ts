/**
 * The server's created {customer, agent, signal} flags must
 * survive every SDK response mapping — single trackEvent, batch trackEvent
 * success rows, and batch failed (stored-failure) rows.
 *
 * Also pins the intentional gap: an idempotent replay's server row carries no
 * created field, so the mapped response's created is undefined. undefined
 * means "no provisioning info" (replay, older server), NOT "nothing created"
 * — that would be { customer: false, agent: false, signal: false }.
 */

import { describe, it, expect, vi } from "vitest";
import { UsageResource } from "../resources/usage";
import type {
  BatchEventResponse,
  SingleEventResponse,
  UsageRecord,
  UsageRecordResponse,
} from "../types";

const record: UsageRecord = {
  customerExternalId: "cust-123",
  agentCode: "agent-abc",
  signalName: "api_call",
  model: "gpt-4o",
  modelProvider: "openai",
  inputTokens: 100,
  outputTokens: 50,
};

const CREATED_ALL = { customer: true, agent: true, signal: true };

function successRow(overrides: Record<string, unknown> = {}) {
  return {
    customerExternalId: "cust-123",
    agentCode: "agent-abc",
    signalName: "api_call",
    totalCostUsd: "0.0012000000",
    eventId: "evt-1",
    rawEventId: "raw-1",
    timestamp: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

function serverResponse(
  body: Partial<UsageRecordResponse>,
): UsageRecordResponse {
  return {
    processed: 1,
    successful: 1,
    failed: 0,
    results: { success: [], failed: [] },
    ...body,
  } as UsageRecordResponse;
}

function usageWith(response: UsageRecordResponse) {
  const http = { post: vi.fn().mockResolvedValue(response) } as any;
  return new UsageResource(http, false, null, { warn: vi.fn() });
}

describe("single trackEvent", () => {
  it("passes the created flags through to SingleEventResponse", async () => {
    const usage = usageWith(
      serverResponse({
        results: {
          success: [successRow({ created: CREATED_ALL }) as any],
          failed: [],
        },
      }),
    );

    const result = (await usage.trackEvent(record)) as SingleEventResponse;

    expect(result.success).toBe(true);
    expect(result.created).toEqual(CREATED_ALL);
  });

  it("an idempotent replay (no created from the server) maps to undefined, never false-flags", async () => {
    const usage = usageWith(
      serverResponse({
        results: { success: [successRow() as any], failed: [] },
      }),
    );

    const result = (await usage.trackEvent(record)) as SingleEventResponse;

    expect(result.success).toBe(true);
    expect(result.created).toBeUndefined();
  });
});

describe("batch trackEvent", () => {
  it("passes created through success rows and stored-failure rows", async () => {
    const usage = usageWith(
      serverResponse({
        processed: 2,
        successful: 1,
        failed: 1,
        results: {
          success: [successRow({ created: CREATED_ALL }) as any],
          failed: [
            {
              record,
              code: "NEEDS_COST_BACKFILL",
              stored: true,
              eventId: "evt-2",
              rawEventId: "raw-2",
              error: "unknown model",
              created: { customer: true, agent: false, signal: true },
            } as any,
          ],
        },
      }),
    );

    const result = (await usage.trackEvent({
      records: [record, { ...record, signalName: "second" }],
    })) as BatchEventResponse;

    const successRowMapped = result.results.find((r) => r.success);
    const failedRowMapped = result.results.find((r) => !r.success);
    expect(successRowMapped?.responseData?.created).toEqual(CREATED_ALL);
    expect(failedRowMapped?.created).toEqual({
      customer: true,
      agent: false,
      signal: true,
    });
  });

  it("replay rows in a batch map to undefined created", async () => {
    const usage = usageWith(
      serverResponse({
        results: { success: [successRow() as any], failed: [] },
      }),
    );

    const result = (await usage.trackEvent({
      records: [record],
    })) as BatchEventResponse;

    expect(result.results[0].responseData?.created).toBeUndefined();
  });
});

describe("raw record()/recordBatch() passthrough", () => {
  it("record() returns the server rows untouched, created flags included", async () => {
    const usage = usageWith(
      serverResponse({
        results: {
          success: [successRow({ created: CREATED_ALL }) as any],
          failed: [],
        },
      }),
    );

    const result = await usage.record(record);

    expect(result.results.success[0].created).toEqual(CREATED_ALL);
  });
});
