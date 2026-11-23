/**
 * The retry buffer is auth-aware.
 *
 * A 401/403 means the KEY is dead, so retrying cannot deliver the event.
 * New events drop immediately with an honest warning. Buffered events are
 * destroyed only after the auth failure repeats on a second consecutive
 * flush (the server can dress its own infra faults as generic 401s, so one 401 is never proof of a bad key).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "http";
import { RetryBuffer } from "../utils/buffer";
import { UsageResource } from "../resources/usage";
import { WarnLogger } from "../utils/warn-logger";
import {
  createErrorFromResponse,
  isAuthFailure,
  AuthenticationError,
  NetworkError,
  TimeoutError,
} from "../errors";
import { isAuthFailure as isAuthFailureFromIndex } from "../index";
import { MarginFrontClient } from "../client";
import type { UsageRecord, UsageRecordResponse } from "../types";

const makeRecord = (id: string): UsageRecord => ({
  customerExternalId: `cust-${id}`,
  agentCode: "agent-test",
  signalName: "test-signal",
  model: "gpt-4o",
  modelProvider: "openai",
});

const validRecord = makeRecord("valid");

// Errors are built through the real factory so this suite breaks if the
// 401/403 class mapping in errors.ts ever drifts.
const authError = (
  status: 401 | 403,
  message = "Invalid API key",
  metadata: Record<string, unknown> = {},
) => createErrorFromResponse(status, message, undefined, metadata);

const cleanResponse = (records: UsageRecord[]): UsageRecordResponse => ({
  processed: records.length,
  successful: records.length,
  failed: 0,
  results: {
    success: records.map((record, i) => ({
      customerExternalId: record.customerExternalId,
      agentCode: record.agentCode,
      signalName: record.signalName,
      quantity: 1,
      eventId: `evt_${i}`,
      rawEventId: `raw_${i}`,
      timestamp: new Date().toISOString(),
    })),
    failed: [],
  },
});

function mockHttp(postFn: (...args: unknown[]) => Promise<unknown>) {
  return { post: postFn } as any;
}

function allWarnText(warnFn: ReturnType<typeof vi.fn>): string {
  return warnFn.mock.calls.map((call) => call[0]).join("\n");
}

describe("isAuthFailure", () => {
  it("is true for factory-built 401 and 403 errors", () => {
    expect(isAuthFailure(authError(401))).toBe(true);
    expect(isAuthFailure(authError(403))).toBe(true);
  });

  it("is false for retryable failures", () => {
    expect(isAuthFailure(createErrorFromResponse(429, "slow down"))).toBe(
      false,
    );
    expect(isAuthFailure(createErrorFromResponse(500, "boom"))).toBe(false);
    expect(isAuthFailure(new NetworkError("net down"))).toBe(false);
    expect(isAuthFailure(new TimeoutError("timed out"))).toBe(false);
  });

  it("is false for non-API errors and non-objects", () => {
    expect(isAuthFailure(new Error("network down"))).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
    expect(isAuthFailure(undefined)).toBe(false);
    expect(isAuthFailure("401")).toBe(false);
  });

  it("is duck-typed on statusCode, not instanceof", () => {
    // Dual CJS/ESM builds can put two copies of the error classes in one
    // process, where instanceof silently fails. The shape is the contract.
    expect(isAuthFailure({ statusCode: 401 })).toBe(true);
    expect(isAuthFailure({ statusCode: 403 })).toBe(true);
    expect(isAuthFailure({ statusCode: 500 })).toBe(false);
  });

  it("is exported from the public entry point", () => {
    expect(typeof isAuthFailureFromIndex).toBe("function");
    expect(isAuthFailureFromIndex(authError(401))).toBe(true);
  });
});

describe("new events drop immediately on auth failure (fire-and-forget)", () => {
  function makeUsage(error: unknown) {
    const warnFn = vi.fn();
    const http = mockHttp(() => Promise.reject(error));
    const buffer = new RetryBuffer(vi.fn().mockResolvedValue(undefined), {
      warn: warnFn,
    });
    const usage = new UsageResource(http, true, buffer, { warn: warnFn });
    return { usage, buffer, warnFn };
  }

  it("drops a 401 record without buffering and warns about the key", async () => {
    const { usage, buffer, warnFn } = makeUsage(authError(401));

    const result = await usage.record(validRecord);

    expect(result.delivered).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.buffered).toBe(0);
    expect(buffer.size).toBe(0);
    const text = allWarnText(warnFn);
    expect(text).toContain("HTTP 401");
    expect(text).not.toContain("queued for retry");

    buffer.destroy();
  });

  it("leads the 403 warning with the publishable-key remedy", async () => {
    const { usage, buffer, warnFn } = makeUsage(
      authError(403, "Secret key required for this operation"),
    );

    await usage.record(validRecord);

    const text = allWarnText(warnFn);
    expect(text).toContain("mf_pk_");
    expect(text).toContain("mf_sk_");
    expect(text).not.toContain("Allowed roles");

    buffer.destroy();
  });

  it("names the key role and allowed roles when the 403 carries them", async () => {
    const { usage, buffer, warnFn } = makeUsage(
      authError(403, "role denied", {
        requiredRoles: ["developer", "admin", "owner"],
        keyRole: "ingest",
      }),
    );

    await usage.record(validRecord);

    const text = allWarnText(warnFn);
    expect(text).toContain("'ingest'");
    expect(text).toContain("developer, admin, owner");
    expect(text).not.toContain("mf_pk_");

    buffer.destroy();
  });

  it("routes a 403 with an undefined requiredRoles value to the publishable remedy", async () => {
    // parseApiError always writes the requiredRoles KEY into metadata, with
    // an undefined value on non-role 403s. An `in` check would misroute this.
    const { usage, buffer, warnFn } = makeUsage(
      authError(403, "Secret key required", {
        requiredRoles: undefined,
        keyRole: undefined,
      }),
    );

    await usage.record(validRecord);

    const text = allWarnText(warnFn);
    expect(text).toContain("mf_pk_");
    expect(text).not.toContain("Allowed roles");

    buffer.destroy();
  });

  it("buffers non-auth failures for retry", async () => {
    const { usage, buffer, warnFn } = makeUsage(
      createErrorFromResponse(500, "boom"),
    );

    const result = await usage.record(validRecord);

    expect(result.buffered).toBe(1);
    expect(buffer.size).toBe(1);
    expect(allWarnText(warnFn)).toContain("queued for retry");

    buffer.destroy();
  });

  it("drops a whole recordBatch on a 401 with one warning, not three", async () => {
    const { usage, buffer, warnFn } = makeUsage(authError(401));

    const result = await usage.recordBatch([
      makeRecord("1"),
      makeRecord("2"),
      makeRecord("3"),
    ]);

    expect(result.failed).toBe(3);
    expect(result.buffered).toBe(0);
    expect(buffer.size).toBe(0);
    for (const row of result.results.failed) {
      expect(row.stored).toBe(false);
    }
    const authWarns = warnFn.mock.calls.filter((call) =>
      String(call[0]).includes("HTTP 401"),
    );
    expect(authWarns).toHaveLength(1);
    expect(String(authWarns[0][0])).toContain("3 event(s)");

    buffer.destroy();
  });

  it("throws on 401 when fireAndForget is false and never touches the buffer", async () => {
    const http = mockHttp(() => Promise.reject(authError(401)));
    const buffer = new RetryBuffer(vi.fn().mockResolvedValue(undefined), {
      warn: vi.fn(),
    });
    const noteAuthDrop = vi.spyOn(buffer, "noteAuthDrop");
    const usage = new UsageResource(http, false, buffer, { warn: vi.fn() });

    await expect(usage.record(validRecord)).rejects.toThrow(
      AuthenticationError,
    );
    expect(noteAuthDrop).not.toHaveBeenCalled();

    buffer.destroy();
  });
});

describe("buffered events: confirm-then-drop", () => {
  type SendFn = (
    records: UsageRecord[],
  ) => Promise<UsageRecordResponse | undefined | void>;

  let sendFn: ReturnType<typeof vi.fn<Parameters<SendFn>, ReturnType<SendFn>>>;
  let warnFn: ReturnType<typeof vi.fn>;
  let buffer: RetryBuffer;

  beforeEach(() => {
    vi.useFakeTimers();
    sendFn = vi
      .fn<Parameters<SendFn>, ReturnType<SendFn>>()
      .mockImplementation(async (records) => cleanResponse(records));
    warnFn = vi.fn();
    buffer = new RetryBuffer(sendFn, { warn: warnFn });
  });

  afterEach(() => {
    buffer.destroy();
    vi.useRealTimers();
  });

  it("a single 401 flush leaves the buffer intact", async () => {
    sendFn.mockRejectedValue(authError(401));
    buffer.push(makeRecord("1"));
    buffer.push(makeRecord("2"));

    await buffer.flush();

    expect(buffer.size).toBe(2);
    expect(allWarnText(warnFn)).toContain("still queued");

    sendFn.mockImplementation(async (records) => cleanResponse(records));
    await buffer.flush();
    expect(sendFn).toHaveBeenLastCalledWith([makeRecord("1"), makeRecord("2")]);
    expect(buffer.size).toBe(0);
  });

  it("a second consecutive 401 flush drops the held events with the honest cause", async () => {
    sendFn.mockRejectedValue(authError(401));
    buffer.push(makeRecord("1"));
    buffer.push(makeRecord("2"));

    await buffer.flush();
    expect(buffer.size).toBe(2);
    await buffer.flush();

    expect(buffer.size).toBe(0);
    const text = allWarnText(warnFn);
    expect(text).toContain("twice in a row");
    expect(text).toContain("2 held event(s)");
    expect(text).not.toContain("connectivity");
  });

  it("a 403 confirms the same way as a 401", async () => {
    sendFn.mockRejectedValue(authError(403));
    buffer.push(makeRecord("1"));

    await buffer.flush();
    expect(buffer.size).toBe(1);
    await buffer.flush();

    expect(buffer.size).toBe(0);
    expect(allWarnText(warnFn)).toContain("HTTP 403");
  });

  it("a clean flush between two 401s resets the confirmation", async () => {
    sendFn.mockRejectedValueOnce(authError(401));
    buffer.push(makeRecord("1"));
    await buffer.flush();
    expect(buffer.size).toBe(1);

    await buffer.flush();
    expect(buffer.size).toBe(0);

    sendFn.mockRejectedValue(authError(401));
    buffer.push(makeRecord("2"));
    await buffer.flush();

    expect(buffer.size).toBe(1);
  });

  it("a resolved send with failed rows also resets the confirmation", async () => {
    // The reset condition is "the send resolved", not "the flush was clean":
    // even a 200 full of failed rows proves the key is alive.
    const record = makeRecord("1");
    buffer.push(record);

    sendFn.mockRejectedValueOnce(authError(401));
    await buffer.flush();
    expect(buffer.size).toBe(1);

    sendFn.mockImplementationOnce(async (records) => ({
      processed: records.length,
      successful: 0,
      failed: records.length,
      results: {
        success: [],
        failed: [{ record, error: "db write failed", stored: false }],
      },
    }));
    await buffer.flush();
    expect(buffer.size).toBe(1);

    sendFn.mockRejectedValue(authError(401));
    await buffer.flush();

    expect(buffer.size).toBe(1);
  });

  it("counts only literally consecutive auth failures", async () => {
    buffer.push(makeRecord("1"));

    sendFn.mockRejectedValueOnce(authError(401));
    await buffer.flush();
    sendFn.mockRejectedValueOnce(new Error("network down"));
    await buffer.flush();
    sendFn.mockRejectedValue(authError(401));
    await buffer.flush();

    expect(buffer.size).toBe(1);
  });

  it("an auth failure consumes no delivery attempt", async () => {
    buffer.push(makeRecord("stubborn"));

    sendFn.mockRejectedValueOnce(authError(401));
    await buffer.flush();
    expect(buffer.size).toBe(1);

    sendFn.mockRejectedValue(new Error("network down"));
    for (let i = 0; i < 4; i++) {
      await buffer.flush();
      expect(buffer.size).toBe(1);
    }

    // The MAX_ATTEMPTS drop lands on the 5th non-auth flush. If the 401 had
    // burned an attempt, the 4th would have dropped it.
    await buffer.flush();
    expect(buffer.size).toBe(0);
    expect(allWarnText(warnFn)).toContain("dropped after 5 retries");
  });

  it("an auth hold does not escalate the backoff", async () => {
    sendFn.mockRejectedValue(authError(401));
    buffer.push(makeRecord("1"));

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(buffer.size).toBe(1);

    // The confirming flush fires one BASE interval later (t=20s), not after
    // a doubled backoff (t=30s).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(buffer.size).toBe(0);
  });

  it("a confirming flush spares records that were not part of it", async () => {
    buffer.push(makeRecord("doomed"));
    sendFn.mockRejectedValueOnce(authError(401));
    await buffer.flush();
    expect(buffer.size).toBe(1);

    let release!: () => void;
    sendFn.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          release = () => reject(authError(401));
        }),
    );
    const confirmingFlush = buffer.flush();
    buffer.push(makeRecord("late-arrival"));
    release();
    await confirmingFlush;

    // "doomed" was dropped on its second strike; "late-arrival" has zero.
    expect(buffer.size).toBe(1);

    sendFn.mockRejectedValue(authError(401));
    await buffer.flush();
    expect(buffer.size).toBe(1);
    await buffer.flush();
    expect(buffer.size).toBe(0);
  });

  it("overlapping flush calls count as one cycle, not two strikes", async () => {
    buffer.push(makeRecord("1"));

    let release!: () => void;
    sendFn.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          release = () => reject(authError(401));
        }),
    );
    const first = buffer.flush();
    const second = buffer.flush();
    release();
    await Promise.all([first, second]);

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(buffer.size).toBe(1);

    sendFn.mockRejectedValue(authError(401));
    await buffer.flush();
    expect(buffer.size).toBe(0);
  });

  it("holds a full buffer through an unconfirmed 401 without evicting", async () => {
    sendFn.mockRejectedValue(authError(401));
    for (let i = 0; i < 1000; i++) {
      buffer.push(makeRecord(`${i}`));
    }

    await buffer.flush();

    expect(buffer.size).toBe(1000);
    expect(warnFn).not.toHaveBeenCalledWith(
      expect.stringContaining("dropping oldest event"),
      expect.anything(),
    );
  });

  it("destroy during an auth hold is a clean stop", async () => {
    sendFn.mockRejectedValue(authError(401));
    buffer.push(makeRecord("1"));
    await buffer.flush();
    expect(buffer.size).toBe(1);

    buffer.destroy();

    expect(buffer.size).toBe(0);
    expect(buffer.push(makeRecord("late"))).toBe(false);
  });
});

describe("recovery signal", () => {
  it("reports send-time drops when delivery resumes without the buffer ever filling", async () => {
    const warnFn = vi.fn();
    const sink = { warn: warnFn };
    let failing = true;
    const http = mockHttp((_path, body) =>
      failing
        ? Promise.reject(authError(401))
        : Promise.resolve(
            cleanResponse((body as { records: UsageRecord[] }).records),
          ),
    );
    const buffer = new RetryBuffer(vi.fn().mockResolvedValue(undefined), sink);
    const usage = new UsageResource(http, true, buffer, sink);

    await usage.record(validRecord);
    await usage.record(validRecord);
    expect(buffer.size).toBe(0);

    failing = false;
    await usage.record(validRecord);

    const recovery = warnFn.mock.calls.filter((call) =>
      String(call[0]).includes("accepting events again"),
    );
    expect(recovery).toHaveLength(1);
    expect(String(recovery[0][0])).toContain("2 event(s)");

    warnFn.mockClear();
    await usage.record(validRecord);
    expect(allWarnText(warnFn)).not.toContain("accepting events again");

    buffer.destroy();
  });

  it("counts confirmed buffer drops in the same recovery total", async () => {
    const warnFn = vi.fn();
    const sink = { warn: warnFn };
    const sendFn = vi.fn().mockRejectedValue(authError(401));
    const buffer = new RetryBuffer(sendFn, sink);
    let failing = true;
    const http = mockHttp((_path, body) =>
      failing
        ? Promise.reject(new Error("network down"))
        : Promise.resolve(
            cleanResponse((body as { records: UsageRecord[] }).records),
          ),
    );
    const usage = new UsageResource(http, true, buffer, sink);

    await usage.record(validRecord);
    expect(buffer.size).toBe(1);
    await buffer.flush();
    await buffer.flush();
    expect(buffer.size).toBe(0);

    failing = false;
    await usage.record(validRecord);

    const recovery = warnFn.mock.calls.filter((call) =>
      String(call[0]).includes("accepting events again"),
    );
    expect(recovery).toHaveLength(1);
    expect(String(recovery[0][0])).toContain("1 event(s)");

    buffer.destroy();
  });
});

describe("auth warn throttle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeThrottledUsage(errorForStatus: (call: number) => unknown) {
    const handlerCalls: Array<[string, string]> = [];
    const logger = new WarnLogger({
      apiKey: "mf_sk_test",
      logging: {
        handler: (level, message) => handlerCalls.push([level, message]),
      },
    });
    let calls = 0;
    const http = mockHttp(() => Promise.reject(errorForStatus(calls++)));
    const usage = new UsageResource(http, true, null, logger);
    return { usage, handlerCalls };
  }

  it("warns once per 60s window and reports the suppressed total when it reopens", async () => {
    vi.useFakeTimers();
    const { usage, handlerCalls } = makeThrottledUsage(() => authError(401));

    await usage.record(validRecord);
    await usage.record(validRecord);
    await usage.record(validRecord);

    let authWarns = handlerCalls.filter(([, msg]) => msg.includes("HTTP 401"));
    expect(authWarns).toHaveLength(1);
    expect(authWarns[0][1]).toContain("1 event(s)");

    vi.advanceTimersByTime(61_000);
    await usage.record(validRecord);

    authWarns = handlerCalls.filter(([, msg]) => msg.includes("HTTP 401"));
    expect(authWarns).toHaveLength(2);
    // 2 suppressed inside the window plus this call: nothing goes invisible.
    expect(authWarns[1][1]).toContain("3 event(s)");
  });

  it("throttles 401 and 403 independently", async () => {
    vi.useFakeTimers();
    const { usage, handlerCalls } = makeThrottledUsage((call) =>
      call === 0 ? authError(401) : authError(403),
    );

    await usage.record(validRecord);
    await usage.record(validRecord);

    expect(
      handlerCalls.filter(([, msg]) => msg.includes("HTTP 401")),
    ).toHaveLength(1);
    expect(
      handlerCalls.filter(([, msg]) => msg.includes("HTTP 403")),
    ).toHaveLength(1);
  });
});

describe("warning routability", () => {
  async function startServer(
    handler: (req: unknown, res: any) => void,
  ): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    return { server, port };
  }

  it("a zero-config client still prints the auth warning to the console", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Invalid API key", statusCode: 401 }));
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const client = new MarginFrontClient({
        apiKey: "mf_sk_test",
        baseUrl: `http://localhost:${port}/v1`,
        retries: 0,
        timeout: 2000,
      });

      await client.usage.record(validRecord);

      const authWarn = warnSpy.mock.calls.find((call) =>
        String(call[0]).includes("HTTP 401"),
      );
      expect(authWarn).toBeDefined();
      expect(String(authWarn![0])).toContain("[MarginFront] ");
    } finally {
      warnSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("routes warnings to a custom handler instead of the console", () => {
    const handler = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = new WarnLogger({
      apiKey: "mf_sk_test",
      logging: { handler },
    });

    logger.warn("some data was lost", { detail: 1 });

    expect(handler).toHaveBeenCalledWith("warn", "some data was lost", {
      detail: 1,
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("logging.enabled false silences data-loss warnings", () => {
    const handler = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = new WarnLogger({
      apiKey: "mf_sk_test",
      logging: { enabled: false, handler },
    });

    logger.warn("dropped");
    logger.warnThrottled("key", "dropped");

    expect(handler).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("logging.level does NOT silence data-loss warnings", () => {
    // Deliberate: level filters routine HTTP logs. Quieting those must not
    // hide a data-loss warning; only enabled: false does.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = new WarnLogger({
      apiKey: "mf_sk_test",
      logging: { level: "error" },
    });

    logger.warn("dropped");

    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("debug false does NOT silence data-loss warnings", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = new WarnLogger({ apiKey: "mf_sk_test", debug: false });

    logger.warn("dropped");

    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});
