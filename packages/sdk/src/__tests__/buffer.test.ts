import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RetryBuffer } from "../utils/buffer";
import type {
  UsageRecord,
  UsageRecordFailure,
  UsageRecordResponse,
} from "../types";

const makeRecord = (id: string): UsageRecord => ({
  customerExternalId: `cust-${id}`,
  agentCode: "agent-test",
  signalName: "test-signal",
  model: "gpt-4o",
  modelProvider: "openai",
});

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

const failureResponse = (
  records: UsageRecord[],
  failed: UsageRecordFailure[],
): UsageRecordResponse => ({
  processed: records.length,
  successful: records.length - failed.length,
  failed: failed.length,
  results: {
    success: [],
    failed,
  },
});

type SendFn = (
  records: UsageRecord[],
) => Promise<UsageRecordResponse | undefined | void>;

describe("RetryBuffer", () => {
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

  it("holds events and flushes on manual call", async () => {
    buffer.push(makeRecord("1"));
    buffer.push(makeRecord("2"));
    expect(buffer.size).toBe(2);

    await buffer.flush();

    expect(sendFn).toHaveBeenCalledOnce();
    expect(sendFn).toHaveBeenCalledWith([makeRecord("1"), makeRecord("2")]);
    expect(buffer.size).toBe(0);
  });

  it("treats a shapeless sendFn response as a clean flush", async () => {
    sendFn.mockResolvedValue(undefined);
    buffer.push(makeRecord("1"));

    await buffer.flush();

    expect(buffer.size).toBe(0);
  });

  it("keeps records pushed during an in-flight flush — not lost, not double-sent", async () => {
    const recordA = makeRecord("in-flight");
    const recordB = makeRecord("late-arrival");

    let release!: () => void;
    sendFn.mockImplementationOnce(
      (records) =>
        new Promise((resolve) => {
          release = () => resolve(cleanResponse(records));
        }),
    );

    buffer.push(recordA);
    const flushPromise = buffer.flush();
    buffer.push(recordB);
    release();
    await flushPromise;

    // recordB survived recordA's clean flush instead of being cleared unsent
    expect(buffer.size).toBe(1);

    await buffer.flush();
    expect(sendFn).toHaveBeenLastCalledWith([recordB]);
    expect(buffer.size).toBe(0);
  });

  it("flushes on timer", async () => {
    buffer.push(makeRecord("1"));

    // Advance past the 10s flush interval
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sendFn).toHaveBeenCalledOnce();
    expect(buffer.size).toBe(0);
  });

  it("drops oldest event when at capacity", () => {
    // Fill the buffer to 1000
    for (let i = 0; i < 1000; i++) {
      buffer.push(makeRecord(`${i}`));
    }
    expect(buffer.size).toBe(1000);

    // Push one more — oldest should drop, but the new push is still accepted
    expect(buffer.push(makeRecord("overflow"))).toBe(true);
    expect(buffer.size).toBe(1000);
    expect(warnFn).toHaveBeenCalledWith(
      expect.stringContaining("dropping oldest event"),
      expect.anything(),
    );
  });

  it("rejects pushes after destroy", () => {
    buffer.destroy();
    expect(buffer.push(makeRecord("late"))).toBe(false);
    expect(buffer.size).toBe(0);
  });

  it("retries up to 5 times then drops", async () => {
    sendFn.mockRejectedValue(new Error("network down"));
    buffer.push(makeRecord("stubborn"));

    // Flush 5 times (each attempt bumps the counter)
    for (let i = 0; i < 5; i++) {
      await buffer.flush();
    }

    // After 5 failed attempts, event should be dropped
    expect(buffer.size).toBe(0);
    expect(warnFn).toHaveBeenCalledWith(
      expect.stringContaining("dropped after 5 retries"),
      expect.anything(),
    );
  });

  it("stops timer when buffer is empty after successful flush", async () => {
    buffer.push(makeRecord("1"));

    await vi.advanceTimersByTimeAsync(10_000);
    expect(buffer.size).toBe(0);

    // Clear the mock and advance again — sendFn should NOT be called
    // because the timer stopped when the buffer drained
    sendFn.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("destroy clears buffer and stops timer", () => {
    buffer.push(makeRecord("1"));
    buffer.push(makeRecord("2"));
    expect(buffer.size).toBe(2);

    buffer.destroy();

    expect(buffer.size).toBe(0);
  });

  describe("flush partial-failure policy", () => {
    it("re-queues only stored:false rows on a mixed response", async () => {
      const recordA = makeRecord("A");
      const recordB = makeRecord("B");
      buffer.push(recordA);
      buffer.push(recordB);

      sendFn.mockImplementation(async (records) =>
        failureResponse(records, [
          { record: recordA, error: "db write failed", stored: false },
          {
            record: recordB,
            error: "unmapped service",
            code: "NEEDS_COST_BACKFILL",
            stored: true,
            eventId: "evt_b",
          },
        ]),
      );

      await buffer.flush();

      // Only A comes back; B was stored server-side and must never re-send
      expect(buffer.size).toBe(1);
      expect(warnFn).toHaveBeenCalledWith(
        expect.stringContaining("not retried"),
        expect.objectContaining({ record: recordB }),
      );

      sendFn.mockImplementation(async (records) => cleanResponse(records));
      await buffer.flush();
      expect(sendFn).toHaveBeenLastCalledWith([recordA]);
    });

    it("preserves attempts across re-queues and drops at MAX_ATTEMPTS", async () => {
      const record = makeRecord("persistent-failure");
      buffer.push(record);

      sendFn.mockImplementation(async (records) =>
        failureResponse(records, [
          { record, error: "db write failed", stored: false },
        ]),
      );

      for (let i = 0; i < 4; i++) {
        await buffer.flush();
        expect(buffer.size).toBe(1);
      }

      await buffer.flush();
      expect(buffer.size).toBe(0);
      expect(warnFn).toHaveBeenCalledWith(
        expect.stringContaining("dropped after 5 retries"),
        expect.anything(),
      );
    });

    it("correlates duplicate records one-to-one when only one fails", async () => {
      const record = makeRecord("twin");
      buffer.push(record);
      buffer.push({ ...record });

      sendFn.mockImplementation(async (records) => ({
        processed: records.length,
        successful: 1,
        failed: 1,
        results: {
          success: [
            {
              customerExternalId: record.customerExternalId,
              agentCode: record.agentCode,
              signalName: record.signalName,
              quantity: 1,
              eventId: "evt_twin_ok",
              rawEventId: "raw_twin_ok",
              timestamp: new Date().toISOString(),
            },
          ],
          failed: [{ record, error: "db write failed", stored: false }],
        },
      }));

      await buffer.flush();

      // Exactly ONE of the two identical records re-queues
      expect(buffer.size).toBe(1);
    });

    it("matches records even when the server echo reorders keys", async () => {
      const record = makeRecord("reordered");
      buffer.push(record);

      const reorderedEcho: UsageRecord = {
        modelProvider: "openai",
        model: "gpt-4o",
        signalName: record.signalName,
        agentCode: record.agentCode,
        customerExternalId: record.customerExternalId,
      };

      sendFn.mockImplementation(async (records) =>
        failureResponse(records, [
          { record: reorderedEcho, error: "db write failed", stored: false },
        ]),
      );

      await buffer.flush();

      expect(buffer.size).toBe(1);
      expect(warnFn).not.toHaveBeenCalledWith(
        expect.stringContaining("could not correlate"),
        expect.anything(),
      );
    });

    it("does NOT match when a services array comes back reordered", async () => {
      const multiRecord: UsageRecord = {
        customerExternalId: "cust-multi",
        agentCode: "agent-test",
        signalName: "test-signal",
        services: [
          { model: "gpt-4o", modelProvider: "openai", inputTokens: 10 },
          { model: "claude-sonnet-4-6", modelProvider: "anthropic" },
        ],
      };
      buffer.push(multiRecord);

      const reversedServicesEcho: UsageRecord = {
        customerExternalId: multiRecord.customerExternalId,
        agentCode: multiRecord.agentCode,
        signalName: multiRecord.signalName,
        services: [
          { model: "claude-sonnet-4-6", modelProvider: "anthropic" },
          { model: "gpt-4o", modelProvider: "openai", inputTokens: 10 },
        ],
      };

      sendFn.mockImplementation(async (records) =>
        failureResponse(records, [
          {
            record: reversedServicesEcho,
            error: "db write failed",
            stored: false,
          },
        ]),
      );

      await buffer.flush();

      // Array order is meaning, not noise — a reordered services echo is a
      // different record and must fall to the could-not-correlate path
      expect(warnFn).toHaveBeenCalledWith(
        expect.stringContaining("could not correlate"),
        expect.anything(),
      );
    });

    it("skips a stored:false row that has no record echo", async () => {
      const record = makeRecord("echo-less");
      buffer.push(record);

      sendFn.mockImplementation(async (records) =>
        failureResponse(records, [
          {
            error: "catastrophic",
            stored: false,
          } as unknown as UsageRecordFailure,
        ]),
      );

      await buffer.flush();

      // Nothing to re-queue: never enqueue an undefined record
      expect(buffer.size).toBe(0);
      expect(warnFn).toHaveBeenCalledWith(
        expect.stringContaining("without a record echo"),
        expect.anything(),
      );
    });

    it("enforces the 1,000-event cap when a re-queue meets in-flight pushes", async () => {
      for (let i = 0; i < 1000; i++) {
        buffer.push(makeRecord(`${i}`));
      }
      expect(buffer.size).toBe(1000);

      sendFn.mockImplementation(async () => {
        // Arrives while the flush is in flight, so the failure re-queue
        // concat would overflow the cap without the trim
        for (let i = 0; i < 5; i++) {
          buffer.push(makeRecord(`inflight-${i}`));
        }
        throw new Error("network down");
      });

      await buffer.flush();

      expect(buffer.size).toBe(1000);
      expect(warnFn).toHaveBeenCalledWith(
        expect.stringContaining("dropping oldest event"),
        expect.anything(),
      );
    });

    it("treats a failed row with stored ABSENT as stored — no re-queue", async () => {
      const record = makeRecord("ambiguous");
      buffer.push(record);

      sendFn.mockImplementation(async (records) =>
        failureResponse(records, [{ record, error: "unknown failure shape" }]),
      );

      await buffer.flush();

      // Double-ingest is the worse failure: no stored flag means no retry
      expect(buffer.size).toBe(0);
      expect(warnFn).toHaveBeenCalledWith(
        expect.stringContaining("without a stored flag"),
        expect.objectContaining({ record }),
      );
    });

    it("escalates backoff after a stored:false re-queue, resets after a clean flush", async () => {
      const record = makeRecord("backoff");
      buffer.push(record);

      sendFn.mockImplementation(async (records) =>
        failureResponse(records, [
          { record, error: "db write failed", stored: false },
        ]),
      );

      // First flush fails at the 10s mark and re-queues
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sendFn).toHaveBeenCalledTimes(1);

      // Backoff doubled to 20s: nothing at +10s, retry at +20s
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sendFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sendFn).toHaveBeenCalledTimes(2);

      // A fully-clean flush resets the interval to 10s
      sendFn.mockImplementation(async (records) => cleanResponse(records));
      await vi.advanceTimersByTimeAsync(40_000);
      expect(buffer.size).toBe(0);

      buffer.push(makeRecord("fresh"));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(buffer.size).toBe(0);
    });
  });
});
