import { describe, it, expect, vi } from "vitest";
import { UsageResource } from "../resources/usage";
import { RetryBuffer } from "../utils/buffer";
import type { UsageRecord } from "../types";

const validRecord: UsageRecord = {
  customerExternalId: "cust-123",
  agentCode: "agent-abc",
  signalName: "api_call",
  model: "gpt-4o",
  modelProvider: "openai",
  inputTokens: 100,
  outputTokens: 50,
};

// Minimal mock HttpClient — only post() is used by UsageResource
function mockHttp(postFn: (...args: unknown[]) => Promise<unknown>) {
  return { post: postFn } as any;
}

describe("fireAndForget mode", () => {
  it("does NOT throw when fireAndForget=true and network fails", async () => {
    const http = mockHttp(() => Promise.reject(new Error("network down")));
    const buffer = new RetryBuffer(vi.fn().mockResolvedValue(undefined), {
      warn: vi.fn(),
    });
    const usage = new UsageResource(http, true, buffer, { warn: vi.fn() });

    // Should not throw — but the response must say the event was NOT delivered
    const result = await usage.record(validRecord);
    expect(result.processed).toBe(1);
    expect(result.successful).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.delivered).toBe(false);
    expect(result.buffered).toBe(1);
    expect(result.results.failed[0].stored).toBe(false);
    expect(result.results.failed[0].error).toContain("network down");
    expect(buffer.size).toBe(1);

    buffer.destroy();
  });

  it("DOES throw when fireAndForget=false and network fails", async () => {
    const http = mockHttp(() => Promise.reject(new Error("network down")));
    const usage = new UsageResource(http, false, null, { warn: vi.fn() });

    await expect(usage.record(validRecord)).rejects.toThrow("network down");
  });

  it("logs validation error but does not throw when fireAndForget=true", async () => {
    const http = mockHttp(() => Promise.resolve({}));
    const warnFn = vi.fn();
    const usage = new UsageResource(http, true, null, { warn: warnFn });

    // Missing model — validation should fail
    const badRecord = { ...validRecord, model: "" };
    const result = await usage.record(badRecord);

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.delivered).toBe(false);
    // Validation drops are never buffered — no retry will resurrect them
    expect(result.buffered).toBe(0);
    expect(warnFn).toHaveBeenCalledWith(
      expect.stringContaining("Validation failed"),
    );
  });

  it("throws validation error when fireAndForget=false", async () => {
    const http = mockHttp(() => Promise.resolve({}));
    const usage = new UsageResource(http, false, null, { warn: vi.fn() });

    const badRecord = { ...validRecord, model: "" };
    await expect(usage.record(badRecord)).rejects.toThrow("model is required");
  });
});
