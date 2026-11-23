// reader-cap.test.ts: the watcher reads the unsent tail of
// live-otlp.jsonl in bounded chunks. Reading the whole tail at once throws past
// Node's string ceiling, and the watcher would retry that same read every
// second forever while nothing drained.
//
// Every URL here is a stubbed global fetch - nothing reaches the network.

import { test, expect, vi, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readNewCompleteLines,
  readWatchCursor,
  writeWatchCursor,
  watchAndForward,
} from "../src/forwarder";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CAP = 1024;

function withTmp(run: (dir: string, path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ccc-reader-cap-"));
  try {
    run(dir, join(dir, "live-otlp.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function line(i: number, padTo = 90): string {
  const head = `{"n":${i},"pad":"`;
  return head + "x".repeat(Math.max(0, padTo - head.length - 2)) + '"}';
}

function bytesOf(lines: string[]): number {
  return lines.reduce((sum, l) => sum + Buffer.byteLength(l) + 1, 0);
}

test("a 40-line backlog drains across several capped reads, each line once, in order, surviving restarts", () => {
  withTmp((dir, path) => {
    const all = Array.from({ length: 40 }, (_, i) => line(i));
    writeFileSync(path, all.map((l) => l + "\n").join(""));
    const cursorPath = join(dir, "forwarder.cursor");

    const delivered: string[] = [];
    let calls = 0;
    let lastCursor = 0;
    while (calls < 100) {
      // A fresh process each time: the cursor comes back off disk.
      const from = readWatchCursor(cursorPath);
      const { lines, nextCursor } = readNewCompleteLines(path, from, {
        maxBytes: CAP,
      });
      calls++;
      if (lines.length === 0) break;
      expect(nextCursor).toBeGreaterThan(lastCursor);
      lastCursor = nextCursor;
      delivered.push(...lines);
      writeWatchCursor(cursorPath, nextCursor);
    }

    expect(calls).toBeGreaterThan(3);
    expect(delivered).toEqual(all);
    expect(readWatchCursor(cursorPath)).toBe(statSync(path).size);
    const afterRestart = readNewCompleteLines(
      path,
      readWatchCursor(cursorPath),
      { maxBytes: CAP },
    );
    expect(afterRestart.lines).toEqual([]);
  });
});

test("one line longer than the cap is still delivered whole, then the lines after it follow", () => {
  withTmp((_dir, path) => {
    const big = line(0, CAP * 3);
    const small = Array.from({ length: 5 }, (_, i) => line(i + 1));
    writeFileSync(path, [big, ...small].map((l) => l + "\n").join(""));

    const first = readNewCompleteLines(path, 0, { maxBytes: CAP });
    expect(first.lines).toEqual([big]);
    expect(first.nextCursor).toBe(Buffer.byteLength(big) + 1);

    const second = readNewCompleteLines(path, first.nextCursor, {
      maxBytes: CAP,
    });
    expect(second.lines).toEqual(small);
    expect(second.nextCursor).toBe(statSync(path).size);
  });
});

test("a line past the string ceiling is skipped and reported, never wedging the lines after it", () => {
  withTmp((_dir, path) => {
    const huge = line(0, CAP * 4);
    const after = [line(1), line(2)];
    writeFileSync(path, [huge, ...after].map((l) => l + "\n").join(""));

    const first = readNewCompleteLines(path, 0, {
      maxBytes: CAP,
      maxLineBytes: CAP * 2,
    });
    expect(first.lines).toEqual([]);
    expect(first.skippedLineBytes).toBe(Buffer.byteLength(huge) + 1);
    expect(first.nextCursor).toBe(Buffer.byteLength(huge) + 1);

    const second = readNewCompleteLines(path, first.nextCursor, {
      maxBytes: CAP,
      maxLineBytes: CAP * 2,
    });
    expect(second.lines).toEqual(after);
    expect(second.skippedLineBytes ?? 0).toBe(0);
  });
});

test("under the cap, a trailing partial line stays unconsumed until its newline arrives", () => {
  withTmp((_dir, path) => {
    const complete = Array.from({ length: 30 }, (_, i) => line(i));
    const partialHead = '{"n":"tail","pad":"';
    writeFileSync(
      path,
      complete.map((l) => l + "\n").join("") + partialHead,
      "utf8",
    );

    const delivered: string[] = [];
    let cursor = 0;
    for (let i = 0; i < 100; i++) {
      const r = readNewCompleteLines(path, cursor, { maxBytes: CAP });
      expect(bytesOf(r.lines)).toBeLessThanOrEqual(CAP);
      if (r.lines.length === 0) {
        expect(r.nextCursor).toBe(cursor);
        break;
      }
      delivered.push(...r.lines);
      cursor = r.nextCursor;
    }
    expect(delivered).toEqual(complete);
    expect(cursor).toBe(statSync(path).size - partialHead.length);

    // Longer than the cap and still no newline: nothing consumed yet.
    appendFileSync(path, "y".repeat(CAP * 2));
    const stillPartial = readNewCompleteLines(path, cursor, { maxBytes: CAP });
    expect(stillPartial.lines).toEqual([]);
    expect(stillPartial.nextCursor).toBe(cursor);

    appendFileSync(path, '"}\n');
    const done = readNewCompleteLines(path, cursor, { maxBytes: CAP });
    expect(done.lines).toEqual([partialHead + "y".repeat(CAP * 2) + '"}']);
    expect(done.nextCursor).toBe(statSync(path).size);
  });
});

test("a capped read never returns more than the cap, or a single line when one line alone is bigger", () => {
  withTmp((_dir, path) => {
    const lengths = [40, 700, 300, 1500, 90, 90, 90, 1023, 1025, 10, 2048, 5];
    const all = lengths.map((len, i) => line(i, len));
    writeFileSync(path, all.map((l) => l + "\n").join(""));

    const delivered: string[] = [];
    let cursor = 0;
    for (let i = 0; i < 100; i++) {
      const r = readNewCompleteLines(path, cursor, { maxBytes: CAP });
      if (r.lines.length === 0) break;
      if (r.lines.length > 1) {
        expect(bytesOf(r.lines)).toBeLessThanOrEqual(CAP);
      }
      expect(r.nextCursor - cursor).toBe(bytesOf(r.lines));
      delivered.push(...r.lines);
      cursor = r.nextCursor;
    }
    expect(delivered).toEqual(all);
  });
});

function toolLine(tag: string): string {
  const logRecords = [
    {
      attributes: [
        { key: "event.name", value: { stringValue: "tool_result" } },
        { key: "tool_name", value: { stringValue: `mcp__cap__${tag}` } },
        { key: "user.email", value: { stringValue: "dev@example.com" } },
        { key: "session.id", value: { stringValue: "sess-cap" } },
      ],
    },
  ];
  return JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords }] }] });
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

test("the watcher drains a backlog bigger than its per-tick cap and says so once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-reader-cap-watch-"));
  const livePath = join(dir, "live.jsonl");
  const cursorPath = join(dir, "cursor");
  const tags = Array.from({ length: 6 }, (_, i) => `t${i}`);
  const lines = tags.map(toolLine);
  writeFileSync(livePath, lines.map((l) => l + "\n").join(""));
  const perTick = Buffer.byteLength(lines[0]) * 2 + 2;

  const sentTools: string[] = [];
  vi.stubGlobal(
    "fetch",
    async (_url: unknown, init?: RequestInit): Promise<Response> => {
      if (init?.method === "POST" && typeof init.body === "string") {
        const body = JSON.parse(init.body) as {
          records?: Array<{ model?: string }>;
        };
        for (const r of body.records ?? []) sentTools.push(String(r.model));
      }
      return new Response(JSON.stringify({ results: { success: [] } }), {
        status: 200,
      });
    },
  );
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  });
  const savedKey = process.env.MARGINFRONT_API_KEY;
  process.env.MARGINFRONT_API_KEY = "mf_sk_reader_cap_0123456789abcdef0123456789";

  let stop: (() => void) | null = null;
  try {
    stop = watchAndForward(livePath, {
      cursorPath,
      maxTailBytesPerTick: perTick,
      gitCoordinatesResolver: () => null,
      codexTrustDeps: {
        resolveStatus: async () => ({ state: "unknown", reason: "stubbed" }),
        readCache: () => null,
        writeCache: (status) => ({
          state: status.state,
          reason: status.reason ?? null,
          resolvedAt: new Date(0).toISOString(),
          ccc: "0.0.0-test",
        }),
      },
    });

    const size = statSync(livePath).size;
    expect(
      await waitFor(() => readWatchCursor(cursorPath) === size, 8_000),
    ).toBe(true);
    expect(sentTools.filter((m) => m.startsWith("mcp__cap__")).length).toBe(6);
    const catchUpLines = output.filter((l) => l.includes("catching up"));
    expect(catchUpLines.length).toBe(1);
    expect(catchUpLines[0]).not.toContain("—");
  } finally {
    if (stop) stop();
    process.env.MARGINFRONT_API_KEY = savedKey;
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
