// finished-work-queue-drain.test.ts
//
// WHAT THIS FILE PROVES: the durable outbox keeps the promise `code-cost-clarity done`
// prints when a send fails - "it's saved on this machine and the meter sends it
// when sending recovers."
//
// `code-cost-clarity done` writes to the queue file from another process while the daemon may
// be running, so the daemon can't hold its own in-memory idea of the queue and
// rewrite the whole file after a drain. Two rules follow:
//
//   1. a record appended while the daemon is already running has to be noticed
//      (the daemon polls; it does not restart), and
//   2. a record appended in the middle of a drain has to survive the rewrite that
//      ends that drain.
//
// Every fetch here is a stubbed global; nothing reaches a real network.

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countQueueRecords, watchAndForward } from "../src/forwarder";
import type { UsageRecord } from "../src/types";

const TEST_KEY = "mf_sk_test_queue_drain";

// The exact record cmdDone builds and hands to appendToQueue: an outcome record,
// no tokens, no cost. Its signalName is the needle every assertion looks for.
function doneRecord(name: string): UsageRecord {
  return {
    customerExternalId: "dev@example.com",
    agentCode: "claude-code",
    signalName: name,
    model: "work-item",
    modelProvider: "outcome",
    quantity: 1,
    environment: "development",
    metadata: { source: "outcome", doneAt: "2026-09-21T12:00:00.000Z" },
  } as unknown as UsageRecord;
}

// What `code-cost-clarity done` does from its own process: one appended JSON line, nothing else.
function appendFromAnotherProcess(queuePath: string, name: string): void {
  appendFileSync(queuePath, JSON.stringify(doneRecord(name)) + "\n");
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 6_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

interface DrainRig {
  queuePath: string;
  postedBodies: string[];
  postedNames: () => string[];
  queueDepth: () => number;
}

async function withDrainRig(
  options: {
    seedQueue?: string[];
    // Lets a test hold a drain POST open and act while the daemon is awaiting it.
    respond?: (body: string) => Promise<Response>;
  },
  run: (rig: DrainRig) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ccc-queue-drain-"));
  const livePath = join(dir, "live.jsonl");
  const queuePath = join(dir, "queue.jsonl");
  writeFileSync(livePath, "");
  if (options.seedQueue?.length) {
    writeFileSync(
      queuePath,
      options.seedQueue.map((n) => JSON.stringify(doneRecord(n)) + "\n").join(""),
    );
  }

  const postedBodies: string[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    if (init?.method !== "POST") {
      return new Response("{}", { status: 200 });
    }
    const body = String(init.body);
    postedBodies.push(body);
    if (options.respond) return options.respond(body);
    return new Response(JSON.stringify({ results: { success: [] } }), {
      status: 200,
    });
  });

  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const savedKey = process.env.MARGINFRONT_API_KEY;
  process.env.MARGINFRONT_API_KEY = TEST_KEY;

  const rig: DrainRig = {
    queuePath,
    postedBodies,
    postedNames: () =>
      postedBodies.flatMap((body) => {
        const parsed = JSON.parse(body) as {
          records?: Array<{ signalName?: string }>;
        };
        return (parsed.records ?? []).map((r) => r.signalName ?? "");
      }),
    queueDepth: () => countQueueRecords(queuePath),
  };

  let stop: (() => void) | null = null;
  try {
    stop = watchAndForward(livePath, {
      cursorPath: join(dir, "cursor"),
      queuePath,
      authHoldPath: join(dir, "hold.json"),
      // The real resolveStatus spawns the Codex app-server and the real writeCache
      // writes into the runner's own config dir. Neither has anything to do with
      // draining a queue.
      codexTrustDeps: {
        resolveStatus: async () => ({ state: "unknown", reason: "stubbed" }),
        readCache: () => null,
        writeCache: () => ({
          state: "unknown",
          reason: null,
          resolvedAt: new Date(0).toISOString(),
          ccc: "0.0.0-test",
        }),
      } as never,
    });
    await run(rig);
  } finally {
    if (stop) stop();
    process.env.MARGINFRONT_API_KEY = savedKey;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a record another process parked in the queue", () => {
  test("CONTROL: one already on disk when the daemon starts goes out", async () => {
    await withDrainRig({ seedQueue: ["contract summarized"] }, async (rig) => {
      expect(
        await waitFor(() => rig.postedNames().includes("contract summarized")),
      ).toBe(true);
      expect(await waitFor(() => rig.queueDepth() === 0)).toBe(true);
    });
  }, 20_000);

  test("one appended while the daemon is RUNNING goes out without a restart", async () => {
    await withDrainRig({}, async (rig) => {
      // Let the daemon settle into its poll loop with an empty queue first, so
      // this is the cross-process case and not the startup case above.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(rig.postedNames()).toEqual([]);

      appendFromAnotherProcess(rig.queuePath, "contract summarized");

      expect(
        await waitFor(() => rig.postedNames().includes("contract summarized")),
      ).toBe(true);
      expect(await waitFor(() => rig.queueDepth() === 0)).toBe(true);
    });
  }, 20_000);

  test("one appended DURING a drain survives the rewrite that ends it", async () => {
    let releaseFirstPost: (() => void) | null = null;
    const firstPostHeld = new Promise<void>((resolve) => {
      releaseFirstPost = resolve;
    });
    let firstPostSeen = false;

    await withDrainRig(
      {
        seedQueue: ["turn record"],
        respond: async (body) => {
          if (!firstPostSeen && body.includes("turn record")) {
            firstPostSeen = true;
            await firstPostHeld;
          }
          return new Response(JSON.stringify({ results: { success: [] } }), {
            status: 200,
          });
        },
      },
      async (rig) => {
        expect(await waitFor(() => firstPostSeen)).toBe(true);

        // The window: the daemon has read the whole queue and is awaiting its POST.
        // `code-cost-clarity done` lands here.
        appendFromAnotherProcess(rig.queuePath, "contract summarized");
        releaseFirstPost?.();

        expect(
          await waitFor(() => rig.postedNames().includes("contract summarized")),
        ).toBe(true);
        expect(await waitFor(() => rig.queueDepth() === 0)).toBe(true);
      },
    );
  }, 20_000);

  test("a partial drain leaves the untouched records and the late arrival on disk", async () => {
    // Two seeded records, the server takes the batch, and a third lands mid-flight.
    // Nothing may be lost and nothing may be sent twice.
    let releaseFirstPost: (() => void) | null = null;
    const firstPostHeld = new Promise<void>((resolve) => {
      releaseFirstPost = resolve;
    });
    let firstPostSeen = false;

    await withDrainRig(
      {
        seedQueue: ["turn one", "turn two"],
        respond: async (body) => {
          if (!firstPostSeen && body.includes("turn one")) {
            firstPostSeen = true;
            await firstPostHeld;
          }
          return new Response(JSON.stringify({ results: { success: [] } }), {
            status: 200,
          });
        },
      },
      async (rig) => {
        expect(await waitFor(() => firstPostSeen)).toBe(true);
        appendFromAnotherProcess(rig.queuePath, "contract summarized");
        releaseFirstPost?.();

        expect(
          await waitFor(() => rig.postedNames().includes("contract summarized")),
        ).toBe(true);
        const names = rig.postedNames();
        expect(names.filter((n) => n === "turn one")).toHaveLength(1);
        expect(names.filter((n) => n === "turn two")).toHaveLength(1);
        expect(names.filter((n) => n === "contract summarized")).toHaveLength(1);
        expect(await waitFor(() => rig.queueDepth() === 0)).toBe(true);
      },
    );
  }, 20_000);

  test("the queue file is gone once everything has landed, so the next poll costs one stat", async () => {
    await withDrainRig({ seedQueue: ["contract summarized"] }, async (rig) => {
      expect(await waitFor(() => rig.queueDepth() === 0)).toBe(true);
      expect(() => readFileSync(rig.queuePath, "utf8")).toThrow();
    });
  }, 20_000);
});
