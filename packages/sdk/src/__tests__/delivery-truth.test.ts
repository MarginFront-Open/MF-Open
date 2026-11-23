/**
 * Success means delivered.
 *
 * fireAndForget must not swallow transport failures, and the server must not
 * hide validation drops behind success-shaped empty responses (processed: 0,
 * success: true). These tests pin the honest vocabulary: delivered, buffered,
 * and the server's failure fields (code / stored / eventId / rawEventId).
 */

import { describe, it, expect, vi } from "vitest";
import { UsageResource } from "../resources/usage";
import { RetryBuffer } from "../utils/buffer";
import type {
  BatchEventResponse,
  SingleEventResponse,
  UsageRecord,
  UsageRecordResponse,
} from "../types";

const validRecord: UsageRecord = {
  customerExternalId: "cust-123",
  agentCode: "agent-abc",
  signalName: "api_call",
  model: "gpt-4o",
  modelProvider: "openai",
  inputTokens: 100,
  outputTokens: 50,
};

function mockHttp(postFn: (...args: unknown[]) => Promise<unknown>) {
  return { post: postFn } as any;
}

function makeBuffer() {
  return new RetryBuffer(vi.fn().mockResolvedValue(undefined), {
    warn: vi.fn(),
  });
}

describe("transport-failure vocabulary", () => {
  it("recordBatch reports every record as failed, undelivered, and buffered", async () => {
    const http = mockHttp(() => Promise.reject(new Error("network down")));
    const buffer = makeBuffer();
    const usage = new UsageResource(http, true, buffer, { warn: vi.fn() });

    const result = await usage.recordBatch([
      validRecord,
      { ...validRecord, signalName: "second" },
    ]);

    expect(result.processed).toBe(2);
    expect(result.successful).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.delivered).toBe(false);
    expect(result.buffered).toBe(2);
    expect(result.results.failed).toHaveLength(2);
    for (const row of result.results.failed) {
      expect(row.stored).toBe(false);
      expect(row.error).toContain("network down");
    }
    expect(buffer.size).toBe(2);

    buffer.destroy();
  });

  it("trackEvent batch reports success: false with undelivered rows", async () => {
    const http = mockHttp(() => Promise.reject(new Error("network down")));
    const buffer = makeBuffer();
    const usage = new UsageResource(http, true, buffer, { warn: vi.fn() });

    const result = (await usage.trackEvent({
      records: [validRecord, { ...validRecord, signalName: "second" }],
    })) as BatchEventResponse;

    expect(result.success).toBe(false);
    expect(result.totalRecords).toBe(2);
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(2);
    expect(result.buffered).toBe(2);
    expect(result.results).toHaveLength(2);
    for (const row of result.results) {
      expect(row.success).toBe(false);
      expect(row.delivered).toBe(false);
      expect(row.stored).toBe(false);
      expect(row.error).toContain("network down");
    }

    buffer.destroy();
  });

  it("trackEvent single reports undelivered with the buffer count", async () => {
    const http = mockHttp(() => Promise.reject(new Error("network down")));
    const buffer = makeBuffer();
    const usage = new UsageResource(http, true, buffer, { warn: vi.fn() });

    const result = (await usage.trackEvent(validRecord)) as SingleEventResponse;

    expect(result.success).toBe(false);
    expect(result.delivered).toBe(false);
    expect(result.buffered).toBe(1);
    expect(result.error).toContain("network down");

    buffer.destroy();
  });

  it("reports buffered: 0 when there is no retry buffer", async () => {
    const http = mockHttp(() => Promise.reject(new Error("network down")));
    const usage = new UsageResource(http, true, null, { warn: vi.fn() });

    const result = await usage.record(validRecord);

    expect(result.delivered).toBe(false);
    expect(result.buffered).toBe(0);
    expect(result.failed).toBe(1);
  });
});

describe("validation-drop honesty", () => {
  it("recordBatch counts dropped records as failed and never buffers them", async () => {
    const http = mockHttp(() => Promise.resolve({}));
    const buffer = makeBuffer();
    const usage = new UsageResource(http, true, buffer, { warn: vi.fn() });

    const result = await usage.recordBatch([
      { ...validRecord, model: "" },
      { ...validRecord, signalName: "second", model: "" },
    ]);

    expect(result.processed).toBe(2);
    expect(result.failed).toBe(2);
    expect(result.delivered).toBe(false);
    expect(result.buffered).toBe(0);
    expect(buffer.size).toBe(0);

    buffer.destroy();
  });

  it("trackEvent batch reports the drop instead of an empty success", async () => {
    const http = mockHttp(() => Promise.resolve({}));
    const buffer = makeBuffer();
    const usage = new UsageResource(http, true, buffer, { warn: vi.fn() });

    const result = (await usage.trackEvent({
      records: [{ ...validRecord, model: "" }],
    })) as BatchEventResponse;

    expect(result.success).toBe(false);
    expect(result.totalRecords).toBe(1);
    expect(result.failureCount).toBe(1);
    expect(result.buffered).toBe(0);
    expect(result.results[0].delivered).toBe(false);
    expect(result.results[0].stored).toBe(false);
    expect(buffer.size).toBe(0);

    buffer.destroy();
  });
});

describe("server failure-field threading", () => {
  const serverResponse: UsageRecordResponse = {
    processed: 2,
    successful: 1,
    failed: 1,
    results: {
      success: [
        {
          customerExternalId: validRecord.customerExternalId,
          agentCode: validRecord.agentCode,
          signalName: validRecord.signalName,
          quantity: 1,
          eventId: "evt_ok",
          rawEventId: "raw_ok",
          timestamp: new Date().toISOString(),
        },
      ],
      failed: [
        {
          record: { ...validRecord, signalName: "second" },
          error: "unmapped service",
          code: "NEEDS_COST_BACKFILL",
          stored: true,
          eventId: "evt_backfill",
          rawEventId: "raw_backfill",
        },
      ],
    },
  };

  it("trackEvent batch exposes code/stored/eventId/rawEventId on failed rows", async () => {
    const http = mockHttp(() => Promise.resolve(serverResponse));
    const usage = new UsageResource(http, true, null, { warn: vi.fn() });

    const result = (await usage.trackEvent({
      records: [validRecord, { ...validRecord, signalName: "second" }],
    })) as BatchEventResponse;

    expect(result.success).toBe(false);
    const failedRow = result.results.find((row) => !row.success)!;
    expect(failedRow.delivered).toBe(true);
    expect(failedRow.code).toBe("NEEDS_COST_BACKFILL");
    expect(failedRow.stored).toBe(true);
    expect(failedRow.eventId).toBe("evt_backfill");
    expect(failedRow.rawEventId).toBe("raw_backfill");

    const successRow = result.results.find((row) => row.success)!;
    expect(successRow.delivered).toBe(true);
    expect(successRow.responseData?.delivered).toBe(true);
  });

  it("record marks a delivered server response as delivered: true", async () => {
    const http = mockHttp(() => Promise.resolve(serverResponse));
    const usage = new UsageResource(http, true, null, { warn: vi.fn() });

    const result = await usage.record(validRecord);

    expect(result.delivered).toBe(true);
    expect(result.buffered).toBeUndefined();
    expect(result.results.failed[0].code).toBe("NEEDS_COST_BACKFILL");
  });
});
