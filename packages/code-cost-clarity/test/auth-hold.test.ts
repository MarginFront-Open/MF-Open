// auth-hold.test.ts: init validates the key, a rejected key puts the meter on an
// auth HOLD instead of dropping data, and status reports it honestly.
//
// WHAT THIS FILE PROVES:
//
//   init validates keys against the SERVER, not a prefix: a 401 re-prompts, a
//   publishable key is rejected even though /v1/verify answers 200 for it (the
//   write guard blocks POSTs only - a single verify call would certify the most
//   common wrong-key paste), success echoes the org name, and an unreachable
//   server saves the key with an honest line instead of dead-ending setup.
//
//   a 401/403 from ingest parks the batch in the durable queue BEFORE the cursor
//   advances (nothing destroyed), sends zero further ingest POSTs, keeps local
//   capture alive, never exits the daemon, and persists the hold so a launchd
//   respawn resumes holding instead of hammering.
//
//   recovery is gated on the probe's BODY, not its status: a publishable key
//   answers 200 on GET /v1/me/key, and an ok-only probe would thrash
//   hold->drain->403->hold forever.
//
//   the probe cadence is bounded (12 probes per hour, not 3600), single-flight,
//   and armed BEFORE the await so a throwing probe still waits a full window.
//
// Every URL in this file is either a stubbed global fetch or an injected
// fetchImpl - nothing reaches any real network.

import { test, expect, describe, vi, afterEach } from "vitest";
import { keyCheckUrl, keyIdentityUrl } from "../src/server-url";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  existsSync,
  statSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  checkKeyWithServer,
  probeKeyIdentity,
  authHoldRecovers,
  maybeProbeAuthRecovery,
  isAuthFailurePostResult,
  isRetryablePostResult,
  readAuthHold,
  writeAuthHold,
  clearAuthHold,
  keyFingerprint,
  countQueueRecords,
  watchAndForward,
  type AuthRecoveryProbeDeps,
} from "../src/forwarder";
import { cmdInit, cmdStatus, type InitDeps, type StatusDeps } from "../src/cli";
import type {
  AuthHoldState,
  AuthProbeResult,
  KeyCheckResult,
  UsageRecord,
} from "../src/types";
import { CONTROL_HOOK_OWNERSHIP_PATH } from "../src/control";
import { CCC_OWNED_TELEMETRY_KEYS } from "../src/connector";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

const SERVER = "https://billing.example.com/v1";
// Where the watcher posts when it reads the suite-wide MARGINFRONT_API_URL.
const INGEST = "http://localhost:4000/v1/sdk/usage/record";

// A long key so maskApiKey's visible prefix+suffix can never equal the whole
// string - the "raw key never printed" assertions depend on that.
const TEST_KEY = "mf_sk_hold_regression_0123456789abcdef0123456789abcdef";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

// One collector logs line carrying n tool_result events -> n usage records.
function toolLine(n: number, tag: string): string {
  const logRecords = Array.from({ length: n }, (_, i) => ({
    attributes: [
      { key: "event.name", value: { stringValue: "tool_result" } },
      { key: "tool_name", value: { stringValue: `mcp__hold__${tag}${i}` } },
      { key: "user.email", value: { stringValue: "dev@example.com" } },
      { key: "session.id", value: { stringValue: `sess-${tag}` } },
    ],
  }));
  return JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords }] }] });
}

function fakeQueueRecord(i: number): UsageRecord {
  return {
    customerExternalId: "dev@example.com",
    agentCode: "claude-code",
    signalName: "claude-code-tool",
    model: `queued-${i}`,
    modelProvider: "tool",
    quantity: 1,
    environment: "development",
    metadata: { source: "tool" },
  } as unknown as UsageRecord;
}

function seedQueue(queuePath: string, count: number): void {
  const lines = Array.from(
    { length: count },
    (_, i) => JSON.stringify(fakeQueueRecord(i)) + "\n",
  );
  writeFileSync(queuePath, lines.join(""));
}

async function waitFor(
  cond: () => boolean,
  timeoutMs = 4_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Printed lines avoid "just", em dashes and exclamation points.
function expectCleanCopy(lines: string[]): void {
  const offenders = lines.filter(
    (line) =>
      /\bjust\b/i.test(line) || line.includes("—") || line.includes("!"),
  );
  expect(offenders, `copy gate offenders:\n${offenders.join("\n")}`).toEqual(
    [],
  );
}

// One rig for the e2e watcher tests: temp paths, captured console, counted
// fetches, an env key, and guaranteed teardown.
interface WatchRig {
  dir: string;
  livePath: string;
  cursorPath: string;
  queuePath: string;
  holdPath: string;
  ingestPosts: () => number;
  fetchCalls: Array<{ url: string; method: string }>;
  output: string[];
  cursorBytes: () => number;
}

async function withWatchRig(
  opts: {
    respond: (url: string, init?: RequestInit) => Response | Promise<Response>;
    seedHold?: AuthHoldState;
    seedQueueCount?: number;
    seedLive?: string[];
    probeDeps?: {
      probe?: () => Promise<AuthProbeResult>;
      intervalMs?: number;
    };
  },
  run: (rig: WatchRig) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ccc-auth-hold-"));
  const livePath = join(dir, "live.jsonl");
  const cursorPath = join(dir, "cursor");
  const queuePath = join(dir, "queue.jsonl");
  const holdPath = join(dir, "hold.json");

  if (opts.seedHold) writeAuthHold(holdPath, opts.seedHold);
  if (opts.seedQueueCount) seedQueue(queuePath, opts.seedQueueCount);
  writeFileSync(
    livePath,
    (opts.seedLive ?? []).map((line) => line + "\n").join(""),
  );

  const fetchCalls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    async (url: unknown, init?: RequestInit): Promise<Response> => {
      fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
      return opts.respond(String(url), init);
    },
  );

  const output: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });
  const errSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`process.exit(${code}) must never fire on the auth path`);
  }) as never);

  const savedKey = process.env.MARGINFRONT_API_KEY;
  process.env.MARGINFRONT_API_KEY = TEST_KEY;

  const rig: WatchRig = {
    dir,
    livePath,
    cursorPath,
    queuePath,
    holdPath,
    fetchCalls,
    output,
    ingestPosts: () =>
      fetchCalls.filter((c) => c.url === INGEST && c.method === "POST").length,
    cursorBytes: () => {
      try {
        return parseInt(readFileSync(cursorPath, "utf8").trim(), 10);
      } catch {
        return 0;
      }
    },
  };

  let stop: (() => void) | null = null;
  try {
    stop = watchAndForward(livePath, {
      cursorPath,
      queuePath,
      authHoldPath: holdPath,
      authProbeDeps: {
        // Default probe fails closed so no test recovers by accident; recovery
        // tests inject their own.
        probe:
          opts.probeDeps?.probe ??
          (async () => ({ ok: false, reason: "network" }) as AuthProbeResult),
        intervalMs: opts.probeDeps?.intervalMs ?? 60 * 60 * 1000,
      },
      // Stubbed inert because the real resolveStatus SPAWNS the Codex app-server
      // (which initializes a full ~/.codex) and the real writeCache writes
      // ~/.marginfront-ccc/control/codex-trust.json - these tests are about the
      // auth hold, never about Codex trust.
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
    await run(rig);
  } finally {
    if (stop) stop();
    process.env.MARGINFRONT_API_KEY = savedKey;
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  }
}

function heldState(overrides: Partial<AuthHoldState> = {}): AuthHoldState {
  return {
    since: "2026-08-26T14:03:22.123Z",
    lastStatus: 401,
    keyFingerprint: keyFingerprint(TEST_KEY),
    lastProbeAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// URL derivation
// ---------------------------------------------------------------------------

describe("key-check URL derivation", () => {
  test("adds /verify and /me/key to the configured server address", () => {
    expect(keyCheckUrl(SERVER)).toBe("https://billing.example.com/v1/verify");
    expect(keyIdentityUrl(SERVER)).toBe(
      "https://billing.example.com/v1/me/key",
    );
  });

  test("a path prefix in front of /v1 is kept on both", () => {
    const prefixed = "https://example.com/billing/v1";
    expect(keyCheckUrl(prefixed)).toBe("https://example.com/billing/v1/verify");
    expect(keyIdentityUrl(prefixed)).toBe(
      "https://example.com/billing/v1/me/key",
    );
  });
});

// ---------------------------------------------------------------------------
// checkKeyWithServer - init's gate (pure half)
// ---------------------------------------------------------------------------

describe("checkKeyWithServer", () => {
  test("a 401 from /v1/verify is an authoritative rejection", async () => {
    const result = await checkKeyWithServer({
      apiKey: "wrong-vendor-key",
      serverUrl: SERVER,
      fetchImpl: async () => jsonResponse(401, { message: "Unauthorized" }),
    });
    expect(result).toEqual({ ok: false, reason: "rejected", status: 401 });
  });

  test("a valid secret key returns ok with the org name", async () => {
    const result = await checkKeyWithServer({
      apiKey: "mf_sk_good",
      serverUrl: SERVER,
      fetchImpl: async (url) =>
        String(url).endsWith("/v1/verify")
          ? jsonResponse(200, {
              organization: { id: "org_1", name: "Larkspur AI" },
              verified: true,
            })
          : jsonResponse(200, { role: "ingest", keyType: "secret" }),
    });
    expect(result).toEqual({
      ok: true,
      organizationName: "Larkspur AI",
      keyType: "secret",
    });
  });

  // THE VERIFY TRAP: /v1/verify is a GET and the publishable-key write guard
  // blocks POSTs only, so verify alone answers 200 for an mf_pk_ key. This test
  // is red against a one-call implementation - which is the whole point of it.
  test("a publishable key is rejected even though /v1/verify answers 200", async () => {
    const result = await checkKeyWithServer({
      apiKey: "mf_pk_wrong_half",
      serverUrl: SERVER,
      fetchImpl: async (url) =>
        String(url).endsWith("/v1/verify")
          ? jsonResponse(200, {
              organization: { id: "org_1", name: "Larkspur AI" },
              verified: true,
            })
          : jsonResponse(200, { role: "publishable", keyType: "publishable" }),
    });
    expect(result).toEqual({
      ok: false,
      reason: "publishable",
      organizationName: "Larkspur AI",
    });
  });

  test("garbage and foreign keys all 401 and all reject - the server call is the gate", async () => {
    for (const garbage of [
      "a-pasted-anthropic-shaped-key",
      "a-pasted-openai-shaped-key",
      "mf_sk_truncated_pas",
    ]) {
      const result = await checkKeyWithServer({
        apiKey: garbage,
        serverUrl: SERVER,
        fetchImpl: async () => jsonResponse(401, {}),
      });
      expect(result).toEqual({ ok: false, reason: "rejected", status: 401 });
    }
  });

  test("HTTP 404 from /verify means the address is not a MarginFront API, and names the address", async () => {
    const result = await checkKeyWithServer({
      apiKey: "mf_sk_fine",
      serverUrl: SERVER,
      fetchImpl: async () => jsonResponse(404, {}),
    });
    expect(result).toEqual({
      ok: false,
      reason: "wrong-address",
      serverUrl: SERVER,
    });
  });

  // Only 401/403, a 404 and a publishable answer stop init. A 5xx is "could
  // not check": an infrastructure problem, never a bad key.
  test.each([[500], [502], [503]])(
    "HTTP %i from /v1/verify is unreachable, never a rejection",
    async (status) => {
      const result = await checkKeyWithServer({
        apiKey: "mf_sk_fine",
        serverUrl: SERVER,
        fetchImpl: async () => jsonResponse(status, {}),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unreachable");
    },
  );

  test("a network throw is unreachable, never a rejection", async () => {
    const result = await checkKeyWithServer({
      apiKey: "mf_sk_fine",
      serverUrl: SERVER,
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unreachable");
  });

  test("a 200 with an unreadable body is unreachable, not a verdict", async () => {
    const result = await checkKeyWithServer({
      apiKey: "mf_sk_fine",
      serverUrl: SERVER,
      fetchImpl: async () => new Response("<html>proxy error</html>"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unreachable");
  });

  // The fetch carries an explicit timeout. A stub that only resolves on
  // abort proves the AbortSignal is really wired through - without it this test
  // hangs to its own timeout and fails.
  test("a server that never answers aborts into unreachable", async () => {
    const result = await checkKeyWithServer({
      apiKey: "mf_sk_fine",
      serverUrl: SERVER,
      timeoutMs: 30,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("This operation was aborted")),
          );
        }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unreachable");
  });

  test("verify 200 but /v1/me/key unreadable still returns ok with a null keyType", async () => {
    const result = await checkKeyWithServer({
      apiKey: "mf_sk_good",
      serverUrl: SERVER,
      fetchImpl: async (url) =>
        String(url).endsWith("/v1/verify")
          ? jsonResponse(200, {
              organization: { id: "o", name: "Larkspur AI" },
            })
          : jsonResponse(500, {}),
    });
    expect(result).toEqual({
      ok: true,
      organizationName: "Larkspur AI",
      keyType: null,
    });
  });

  test("sends the key in x-api-key on both calls, never in the URL", async () => {
    const seen: Array<{ url: string; key: string | undefined }> = [];
    await checkKeyWithServer({
      apiKey: "mf_sk_headers",
      serverUrl: SERVER,
      fetchImpl: async (url, init) => {
        const headers = new Headers(
          init?.headers as Record<string, string> | undefined,
        );
        seen.push({
          url: String(url),
          key: headers.get("x-api-key") ?? undefined,
        });
        return String(url).endsWith("/v1/verify")
          ? jsonResponse(200, { organization: { id: "o", name: "Org" } })
          : jsonResponse(200, { keyType: "secret", role: "ingest" });
      },
    });
    expect(seen.map((s) => s.url)).toEqual([
      "https://billing.example.com/v1/verify",
      "https://billing.example.com/v1/me/key",
    ]);
    for (const call of seen) {
      expect(call.key).toBe("mf_sk_headers");
      expect(call.url).not.toContain("mf_sk_headers");
    }
  });
});

// ---------------------------------------------------------------------------
// probeKeyIdentity + authHoldRecovers (pure half)
// ---------------------------------------------------------------------------

describe("probeKeyIdentity", () => {
  test("reads keyType and role from a 200", async () => {
    const result = await probeKeyIdentity({
      apiKey: "mf_sk_x",
      serverUrl: SERVER,
      fetchImpl: async () =>
        jsonResponse(200, { role: "ingest", keyType: "secret" }),
    });
    expect(result).toEqual({ ok: true, keyType: "secret", role: "ingest" });
  });

  test("a 200 with an unreadable body is still ok - the route requires auth", async () => {
    const result = await probeKeyIdentity({
      apiKey: "mf_sk_x",
      serverUrl: SERVER,
      fetchImpl: async () => new Response("not json"),
    });
    expect(result).toEqual({ ok: true, keyType: null, role: null });
  });

  test("a 401 is an http failure with its status", async () => {
    const result = await probeKeyIdentity({
      apiKey: "mf_sk_dead",
      serverUrl: SERVER,
      fetchImpl: async () => jsonResponse(401, {}),
    });
    expect(result).toEqual({ ok: false, reason: "http", status: 401 });
  });

  test("a network throw is a network failure", async () => {
    const result = await probeKeyIdentity({
      apiKey: "mf_sk_x",
      serverUrl: SERVER,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result).toEqual({ ok: false, reason: "network" });
  });
});

describe("authHoldRecovers truth table", () => {
  test.each<[AuthProbeResult, boolean, string]>([
    [{ ok: true, keyType: "secret", role: "ingest" }, true, "200 + secret"],
    // THE PROBE TRAP: a publishable key answers 200 on GETs, so an ok-only
    // probe would clear the hold, drain, 403, and re-enter it every cycle.
    [
      { ok: true, keyType: "publishable", role: "publishable" },
      false,
      "200 + publishable must NOT recover",
    ],
    [{ ok: false, reason: "http", status: 401 }, false, "401 stays held"],
    [{ ok: false, reason: "network" }, false, "network stays held"],
    [
      { ok: true, keyType: null, role: null },
      true,
      "200 with no keyType (older server) must not deadlock a valid key",
    ],
  ])("%j -> %s (%s)", (result, expected) => {
    expect(authHoldRecovers(result)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// post-result classification
// ---------------------------------------------------------------------------

describe("isAuthFailurePostResult", () => {
  test("401 and 403 are auth failures; nothing else is", () => {
    const http = (status: number) =>
      ({ ok: false, reason: "http", status, body: "" }) as const;
    expect(isAuthFailurePostResult(http(401))).toBe(true);
    expect(isAuthFailurePostResult(http(403))).toBe(true);
    expect(isAuthFailurePostResult(http(400))).toBe(false);
    expect(isAuthFailurePostResult(http(429))).toBe(false);
    expect(isAuthFailurePostResult(http(500))).toBe(false);
    expect(
      isAuthFailurePostResult({ ok: false, reason: "network", message: "x" }),
    ).toBe(false);
    expect(isAuthFailurePostResult({ ok: true, parsed: null, body: "" })).toBe(
      false,
    );
  });

  test("the retry classifier is untouched: 401/403 are still not retryable", () => {
    expect(
      isRetryablePostResult({
        ok: false,
        reason: "http",
        status: 401,
        body: "",
      }),
    ).toBe(false);
    expect(
      isRetryablePostResult({
        ok: false,
        reason: "http",
        status: 403,
        body: "",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hold-file persistence (pure half)
// ---------------------------------------------------------------------------

describe("auth-hold state file", () => {
  test("write/read roundtrip, clear removes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-holdfile-"));
    const path = join(dir, "hold.json");
    try {
      const state = heldState();
      writeAuthHold(path, state);
      expect(readAuthHold(path)).toEqual(state);
      clearAuthHold(path);
      expect(readAuthHold(path)).toBeNull();
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing file reads as not held", () => {
    expect(readAuthHold(join(tmpdir(), "ccc-nope", "hold.json"))).toBeNull();
    expect(readAuthHold(undefined)).toBeNull();
  });

  test("a corrupt or truncated file reads as not held, never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-holdfile-"));
    const path = join(dir, "hold.json");
    try {
      writeFileSync(path, '{"since": "2026-08-2');
      expect(readAuthHold(path)).toBeNull();
      writeFileSync(path, JSON.stringify({ since: "x", lastStatus: 401 }));
      expect(readAuthHold(path)).toBeNull(); // missing keyFingerprint
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the fingerprint is non-reversible and never a substring of the key", () => {
    const fp = keyFingerprint(TEST_KEY);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(TEST_KEY).not.toContain(fp);
    // Stable: the daemon compares the stored value against a recomputation.
    expect(keyFingerprint(TEST_KEY)).toBe(fp);
    expect(keyFingerprint("mf_sk_other")).not.toBe(fp);
  });
});

describe("countQueueRecords", () => {
  test("counts non-empty lines without parsing; 0 for a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-depth-"));
    const path = join(dir, "queue.jsonl");
    try {
      expect(countQueueRecords(path)).toBe(0);
      expect(countQueueRecords(undefined)).toBe(0);
      writeFileSync(path, '{"a":1}\n\n{"b":2}\nnot-even-json\n');
      expect(countQueueRecords(path)).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// probe cadence - pure, driven on a fake monotonic clock
// ---------------------------------------------------------------------------

interface CadenceRig {
  deps: AuthRecoveryProbeDeps;
  probes: () => number;
  recovered: () => number;
  setNow: (ms: number) => void;
}

function cadenceRig(probe: () => Promise<AuthProbeResult>): CadenceRig {
  let now = 0;
  let inFlight = false;
  let probes = 0;
  let recovered = 0;
  const deps: AuthRecoveryProbeDeps = {
    probe: () => {
      probes += 1;
      return probe();
    },
    onRecovered: () => {
      recovered += 1;
    },
    onStillHeld: () => {},
    monotonicNow: () => now,
    isInFlight: () => inFlight,
    setInFlight: (v) => {
      inFlight = v;
    },
  };
  return {
    deps,
    probes: () => probes,
    recovered: () => recovered,
    setNow: (ms) => {
      now = ms;
    },
  };
}

// Give the probe promise chain (then/catch/finally) room to settle.
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("probe cadence is bounded and single-flight", () => {
  const FIVE_MIN = 5 * 60 * 1000;

  test("an hour of 1-second ticks probes 12 times, not 3600", async () => {
    const rig = cadenceRig(async () => ({ ok: false, reason: "network" }));
    let next = 0;
    for (let tick = 0; tick < 3600; tick++) {
      rig.setNow(tick * 1000);
      next = maybeProbeAuthRecovery(rig.deps, next, FIVE_MIN);
      await drainMicrotasks();
    }
    expect(rig.probes()).toBe(12);
  });

  test("a probe that never resolves is not re-issued (single-flight)", async () => {
    const rig = cadenceRig(() => new Promise<AuthProbeResult>(() => {}));
    let next = 0;
    for (let tick = 0; tick < 20; tick++) {
      rig.setNow(tick * FIVE_MIN); // every tick is a whole window later
      next = maybeProbeAuthRecovery(rig.deps, next, FIVE_MIN);
      await drainMicrotasks();
    }
    expect(rig.probes()).toBe(1);
  });

  test("a probe that throws still arms the next window - no immediate retry", async () => {
    const rig = cadenceRig(async () => {
      throw new Error("boom");
    });
    let next = 0;
    rig.setNow(0);
    next = maybeProbeAuthRecovery(rig.deps, next, FIVE_MIN);
    await drainMicrotasks();
    expect(rig.probes()).toBe(1);

    // One tick later: inside the window, no probe.
    rig.setNow(1000);
    next = maybeProbeAuthRecovery(rig.deps, next, FIVE_MIN);
    await drainMicrotasks();
    expect(rig.probes()).toBe(1);

    // One millisecond short of the window: still nothing.
    rig.setNow(FIVE_MIN - 1);
    next = maybeProbeAuthRecovery(rig.deps, next, FIVE_MIN);
    await drainMicrotasks();
    expect(rig.probes()).toBe(1);

    // The full window elapsed: exactly one more.
    rig.setNow(FIVE_MIN);
    next = maybeProbeAuthRecovery(rig.deps, next, FIVE_MIN);
    await drainMicrotasks();
    expect(rig.probes()).toBe(2);
  });

  test("the throttle never consults the wall clock", async () => {
    const dateSpy = vi.spyOn(Date, "now");
    const rig = cadenceRig(async () => ({ ok: false, reason: "network" }));
    let next = 0;
    for (let tick = 0; tick < 5; tick++) {
      rig.setNow(tick * 1000);
      next = maybeProbeAuthRecovery(rig.deps, next, FIVE_MIN);
      await drainMicrotasks();
    }
    expect(dateSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// the watcher end to end
// ---------------------------------------------------------------------------

describe("watchAndForward under auth failure", () => {
  test("a 401 mid-life parks the batch, persists the hold, advances the cursor, and sends nothing more", async () => {
    await withWatchRig(
      {
        respond: () => jsonResponse(401, { message: "Unauthorized" }),
        seedLive: [toolLine(3, "a")],
      },
      async (rig) => {
        // The first (and only) POST 401s and the hold lands on disk.
        expect(await waitFor(() => readAuthHold(rig.holdPath) !== null)).toBe(
          true,
        );
        const hold = readAuthHold(rig.holdPath);
        expect(hold?.lastStatus).toBe(401);
        expect(hold?.keyFingerprint).toBe(keyFingerprint(TEST_KEY));
        expect(rig.ingestPosts()).toBe(1);

        // No data destroyed: all 3 records parked, cursor advanced past them so
        // a restart re-reads nothing (the queue, not a re-read, owns recovery).
        expect(
          await waitFor(() => countQueueRecords(rig.queuePath) === 3),
        ).toBe(true);
        expect(rig.cursorBytes()).toBe(statSync(rig.livePath).size);

        // New telemetry during the hold parks too - and still zero further POSTs.
        appendFileSync(rig.livePath, toolLine(2, "b") + "\n");
        expect(
          await waitFor(() => countQueueRecords(rig.queuePath) === 5),
        ).toBe(true);
        await sleep(1100); // one more full poll tick
        expect(rig.ingestPosts()).toBe(1);
        expect(rig.cursorBytes()).toBe(statSync(rig.livePath).size);

        // Parking is not enqueueFailed: no false "send failed - queued" line and
        // no backoff chatter; the hold explains itself in its own words.
        const out = rig.output.join("\n");
        expect(out).toContain(
          "MarginFront rejected this machine's key (HTTP 401)",
        );
        expect(out).toContain("key on hold - parked");
        expect(out).not.toContain("send failed - queued");

        // The raw key never reaches a log line or the hold file's bytes.
        expect(out).not.toContain(TEST_KEY);
        expect(readFileSync(rig.holdPath, "utf8")).not.toContain(TEST_KEY);

        // Local capture keeps running: the collector self-heal still fires
        // during the hold (its binary is absent here, so the revive attempt
        // logs and fails, which is proof enough that it ran).
        expect(out).toContain("collector was down, restarted it");

        // And the new copy clears the copy gates.
        expectCleanCopy(
          rig.output.filter(
            (line) =>
              line.includes("hold") ||
              line.includes("rejected") ||
              line.includes("paused"),
          ),
        );
      },
    );
  });

  test("a 403 on the drain path enters the hold and leaves the queued batch on disk", async () => {
    await withWatchRig(
      {
        respond: () => jsonResponse(403, { message: "Forbidden" }),
        seedQueueCount: 2,
      },
      async (rig) => {
        expect(await waitFor(() => readAuthHold(rig.holdPath) !== null)).toBe(
          true,
        );
        expect(readAuthHold(rig.holdPath)?.lastStatus).toBe(403);
        // The drop-loudly terminal branch must NOT have fired.
        expect(countQueueRecords(rig.queuePath)).toBe(2);
        expect(rig.output.join("\n")).not.toContain("dropping");
        // Exactly the one drain attempt; the held drain returns before POSTing.
        expect(rig.ingestPosts()).toBe(1);
        await sleep(1100);
        expect(rig.ingestPosts()).toBe(1);
      },
    );
  });

  test("a respawn into a persisted hold starts held: zero POSTs, records park, and the startup log says why", async () => {
    await withWatchRig(
      {
        respond: () => jsonResponse(200, { results: { success: [] } }),
        seedHold: heldState(),
        seedLive: [toolLine(2, "seeded")],
      },
      async (rig) => {
        expect(
          await waitFor(() => countQueueRecords(rig.queuePath) === 2),
        ).toBe(true);
        expect(rig.ingestPosts()).toBe(0);
        expect(readAuthHold(rig.holdPath)).not.toBeNull();
        const out = rig.output.join("\n");
        expect(out).toContain("sending is still paused from a previous run");
        expect(out).toContain("HTTP 401");
      },
    );
  });

  test("recovery: a working probe clears the hold and the queue drains", async () => {
    await withWatchRig(
      {
        respond: () => jsonResponse(200, { results: { success: [] } }),
        seedHold: heldState(),
        seedQueueCount: 3,
        probeDeps: {
          intervalMs: 50,
          probe: async () => ({ ok: true, keyType: "secret", role: "ingest" }),
        },
      },
      async (rig) => {
        expect(
          await waitFor(
            () =>
              readAuthHold(rig.holdPath) === null &&
              !existsSync(rig.queuePath) &&
              rig.ingestPosts() >= 1,
          ),
        ).toBe(true);
        expect(rig.output.join("\n")).toContain(
          "the MarginFront key works again",
        );
      },
    );
  });

  // THE PROBE TRAP, end to end: a publishable key answers 200 on the probe.
  test("a publishable probe answer does NOT clear the hold - no thrash, no POSTs", async () => {
    await withWatchRig(
      {
        respond: () => jsonResponse(200, { results: { success: [] } }),
        seedHold: heldState({ lastStatus: 403 }),
        seedQueueCount: 2,
        probeDeps: {
          intervalMs: 50,
          probe: async () => ({
            ok: true,
            keyType: "publishable",
            role: "publishable",
          }),
        },
      },
      async (rig) => {
        // Give it several probe windows and poll ticks to (wrongly) recover.
        await sleep(1600);
        expect(readAuthHold(rig.holdPath)).not.toBeNull();
        expect(countQueueRecords(rig.queuePath)).toBe(2);
        expect(rig.ingestPosts()).toBe(0);
      },
    );
  });

  test("a hold written for a DIFFERENT key dies at startup and sending resumes", async () => {
    await withWatchRig(
      {
        respond: () => jsonResponse(200, { results: { success: [] } }),
        seedHold: heldState({ keyFingerprint: "deadbeef" }),
        seedQueueCount: 1,
      },
      async (rig) => {
        expect(
          await waitFor(
            () => rig.ingestPosts() >= 1 && !existsSync(rig.queuePath),
          ),
        ).toBe(true);
        expect(readAuthHold(rig.holdPath)).toBeNull();
        expect(rig.output.join("\n")).toContain(
          "key changed since the last run",
        );
      },
    );
  });

  test("the control-state sync is paused while held - not even a caps read goes out", async () => {
    // isControlArmed reads the real receipt path (module-load homedir, which the
    // suite guard guarantees is a throwaway HOME) - create it, then sweep it.
    mkdirSync(join(CONTROL_HOOK_OWNERSHIP_PATH, ".."), { recursive: true });
    writeFileSync(CONTROL_HOOK_OWNERSHIP_PATH, '{"command":"test"}');
    try {
      await withWatchRig(
        {
          respond: () => jsonResponse(200, {}),
          seedHold: heldState(),
        },
        async (rig) => {
          await sleep(1600); // past the first timer tick, where the sync fires
          expect(
            rig.fetchCalls.filter((c) => c.url.includes("/v1/control/")),
          ).toEqual([]);
          expect(rig.ingestPosts()).toBe(0);
        },
      );
    } finally {
      rmSync(CONTROL_HOOK_OWNERSHIP_PATH, { force: true });
      // Sweep the dir the mkdir above created too: the no-real-home guard treats
      // a bare ~/.marginfront-ccc as a live install, so leaving even an empty one
      // kills every test file loaded after this one. rmdirSync refuses non-empty
      // dirs, so a home with a real install in there is left alone.
      try {
        rmdirSync(dirname(CONTROL_HOOK_OWNERSHIP_PATH));
      } catch {
        // Not empty or already gone - either way, leave it.
      }
    }
  });

  // Queue-cap pressure during a long hold keeps the OLDEST
  // records - the front of the queue survives, the newest overflow is shed with
  // a loud log that names the key, not connectivity.
  test("at the 10k cap the oldest records survive and the shed is loud", async () => {
    await withWatchRig(
      {
        respond: () => jsonResponse(200, {}),
        seedHold: heldState(),
        seedQueueCount: 9_999,
        seedLive: [toolLine(3, "overflow")],
      },
      async (rig) => {
        expect(
          await waitFor(() => countQueueRecords(rig.queuePath) === 10_000),
        ).toBe(true);
        await sleep(200);
        // Exactly one of the three fit; the other two shed.
        expect(countQueueRecords(rig.queuePath)).toBe(10_000);
        const firstLine = readFileSync(rig.queuePath, "utf8").split("\n")[0];
        expect(firstLine).toContain('"queued-0"'); // oldest still first
        const out = rig.output.join("\n");
        expect(out).toContain("QUEUE FULL");
        expect(out).toContain("the key wasn't working");
        expect(out).not.toContain("check connectivity");
      },
    );
  });
});

// ---------------------------------------------------------------------------
// cmdInit key validation (orchestration half)
// ---------------------------------------------------------------------------

interface InitKeyRig {
  deps: InitDeps;
  logs: string[];
  prompts: string[];
  savedKeys: string[];
  checkedKeys: string[];
  holdClears: () => number;
}

function initKeyRig(opts: {
  savedKey?: string;
  pastes?: string[];
  verdict: (key: string) => KeyCheckResult;
}): InitKeyRig {
  const logs: string[] = [];
  const prompts: string[] = [];
  const savedKeys: string[] = [];
  const checkedKeys: string[] = [];
  const pastes = [...(opts.pastes ?? [])];
  let holdClears = 0;
  const deps: InitDeps = {
    ensureConfigFiles: () => {},
    ensureCollectorBinary: () => {},
    stageMeterProgram: () => {},
    writeServerUrl: () => {},
    isTTY: () => true,
    loadEnv: () => ({
      ...(opts.savedKey ? { MARGINFRONT_API_KEY: opts.savedKey } : {}),
      CCC_CACHE_WRITE_TTL: "1h",
    }),
    promptSecret: async (promptText: string) => {
      prompts.push(promptText);
      return pastes.shift() ?? "";
    },
    writeApiKey: (value: string) => {
      savedKeys.push(value);
    },
    checkKey: async (key: string) => {
      checkedKeys.push(key);
      return opts.verdict(key);
    },
    clearAuthHold: () => {
      holdClears += 1;
    },
    gitDefaultEmail: () => "",
    promptDeveloperEmail: async () => "",
    writeDeveloperEmail: () => {},
    detectCacheTtl: () => null,
    promptCacheTtl: async () => "3",
    writeCacheTtl: () => {},
    hasApiKey: () => savedKeys.length > 0 || Boolean(opts.savedKey),
    codexInstalled: () => false,
    claudeInstalled: () => true,
    // Decline the wiring consent so each test ends right after the questions -
    // these tests are about the key step, not the writers.
    promptConsent: async () => false,
    // The decline above is not enough: --no-prompt auto-consents past it, and an
    // unstubbed writer then falls through to the REAL dep - writing this
    // machine's $HOME (settings.json, config.toml), registering the real
    // scheduled task, or spawning the real Codex app-server. Every writer stays
    // stubbed inert.
    writeClaudeTelemetry: () => ({
      written: [...CCC_OWNED_TELEMETRY_KEYS],
      skipped: [],
      backupPath: null,
    }),
    writeCodexConfig: () => ({ action: "created", backupPath: null }),
    codexHasCccBlock: () => true,
    installDaemon: () => {},
    resolveCodexTrust: async () => ({ state: "armed" }),
    promptControlConsent: async () => false,
    installControlScript: () => {},
    installControlHook: () => {},
    installCodexControlHook: () => "wired",
    syncControl: async () => {},
    findZshrcLines: () => ({ found: false, matchedLines: [] }),
    log: (m) => logs.push(m),
    errorLog: (m) => logs.push(m),
  };
  return {
    deps,
    logs,
    prompts,
    savedKeys,
    checkedKeys,
    holdClears: () => holdClears,
  };
}

const OK_LARKSPUR: KeyCheckResult = {
  ok: true,
  organizationName: "Larkspur AI",
  keyType: "secret",
};

describe("cmdInit validates the pasted key", () => {
  test("a 401'd paste is rejected in plain English, re-prompted, and NEVER saved", async () => {
    const rig = initKeyRig({
      pastes: ["wrong-vendor-key", "wrong-vendor-key", "wrong-vendor-key"],
      verdict: () => ({ ok: false, reason: "rejected", status: 401 }),
    });
    const code = await cmdInit(false, false, rig.deps);
    expect(code).toBe(0);
    expect(rig.savedKeys).toEqual([]);
    expect(rig.prompts.length).toBe(3); // capped at three attempts
    const out = rig.logs.join("\n");
    expect(out).toContain(
      "That key didn't work: MarginFront rejected it (HTTP 401)",
    );
    expect(out).toContain("Nothing was saved after 3 tries");
    expectCleanCopy(out.split("\n"));
  });

  test("success echoes the org name and clears any stale hold", async () => {
    const rig = initKeyRig({
      pastes: ["mf_sk_good"],
      verdict: () => OK_LARKSPUR,
    });
    await cmdInit(false, false, rig.deps);
    expect(rig.savedKeys).toEqual(["mf_sk_good"]);
    expect(rig.holdClears()).toBe(1);
    expect(rig.logs.join("\n")).toContain("Saved. Connected to Larkspur AI.");
  });

  test("a publishable key is refused with the fix, not saved", async () => {
    const rig = initKeyRig({
      pastes: ["mf_pk_wrong_half"],
      verdict: () => ({
        ok: false,
        reason: "publishable",
        organizationName: "Larkspur AI",
      }),
    });
    await cmdInit(false, false, rig.deps);
    expect(rig.savedKeys).toEqual([]);
    const out = rig.logs.join("\n");
    expect(out).toContain("PUBLISHABLE key (mf_pk_*) for Larkspur AI");
    expect(out).toContain("Paste the SECRET key");
  });

  test("a valid key for the WRONG org echoes that org's name so a human catches it", async () => {
    const rig = initKeyRig({
      pastes: ["mf_sk_of_other_org"],
      verdict: () => ({
        ok: true,
        organizationName: "Someone Else Entirely",
        keyType: "secret",
      }),
    });
    await cmdInit(false, false, rig.deps);
    expect(rig.logs.join("\n")).toContain(
      "Saved. Connected to Someone Else Entirely.",
    );
  });

  // With a key on disk the key step is skipped at plan time, so validation
  // must run BEFORE the plan. Red against in-step-only validation.
  test("re-init over a saved-but-dead key re-opens the key step", async () => {
    const rig = initKeyRig({
      savedKey: "mf_sk_dead",
      pastes: ["mf_sk_new"],
      verdict: (key) =>
        key === "mf_sk_dead"
          ? { ok: false, reason: "rejected", status: 401 }
          : OK_LARKSPUR,
    });
    await cmdInit(false, false, rig.deps);
    expect(rig.checkedKeys[0]).toBe("mf_sk_dead");
    expect(rig.prompts.length).toBe(1); // the key step ran despite the saved key
    expect(rig.savedKeys).toEqual(["mf_sk_new"]);
    const out = rig.logs.join("\n");
    expect(out).toContain("PROBLEM: your saved MarginFront key isn't working");
    expect(out).toContain("The key step below asks for a working one.");
  });

  test("re-init over a WORKING saved key changes nothing", async () => {
    const rig = initKeyRig({
      savedKey: "mf_sk_fine",
      verdict: () => OK_LARKSPUR,
    });
    await cmdInit(false, false, rig.deps);
    expect(rig.prompts).toEqual([]); // key step still skipped
    expect(rig.logs.join("\n")).not.toContain("PROBLEM");
  });

  // Offline init: a network failure must never block setup.
  test("an unreachable server saves the key with an honest line, exit 0", async () => {
    const rig = initKeyRig({
      pastes: ["mf_sk_plane_wifi"],
      verdict: () => ({
        ok: false,
        reason: "unreachable",
        message: "getaddrinfo ENOTFOUND",
      }),
    });
    const code = await cmdInit(false, false, rig.deps);
    expect(code).toBe(0);
    expect(rig.savedKeys).toEqual(["mf_sk_plane_wifi"]);
    expect(rig.holdClears()).toBe(1);
    expect(rig.logs.join("\n")).toContain(
      "couldn't reach MarginFront to check the key",
    );
  });

  // When the server can't answer, the prefix warning is the only guard - it
  // fires ONLY on the could-not-check path.
  test("offline + a publishable-LOOKING paste falls back to the prefix warning", async () => {
    const rig = initKeyRig({
      pastes: ["mf_pk_looks_wrong", ""],
      verdict: () => ({
        ok: false,
        reason: "unreachable",
        message: "ECONNREFUSED",
      }),
    });
    await cmdInit(false, false, rig.deps);
    const out = rig.logs.join("\n");
    expect(out).toContain("Heads up: that looks like a PUBLISHABLE key");
    // Kept what was typed (Enter on the retry prompt), saved with the honest line.
    expect(rig.savedKeys).toEqual(["mf_pk_looks_wrong"]);
  });

  test("--no-prompt with a dead saved key warns and still exits 0", async () => {
    const rig = initKeyRig({
      savedKey: "mf_sk_dead",
      verdict: () => ({ ok: false, reason: "rejected", status: 401 }),
    });
    const code = await cmdInit(true, false, rig.deps);
    expect(code).toBe(0);
    expect(rig.prompts).toEqual([]); // no TTY questions in no-prompt mode
    const out = rig.logs.join("\n");
    expect(out).toContain("PROBLEM: your saved MarginFront key isn't working");
    expect(out).toContain("paste a working SECRET key");
  });

  test("--no-prompt with no key at all makes zero validation calls", async () => {
    const rig = initKeyRig({
      verdict: () => OK_LARKSPUR,
    });
    const code = await cmdInit(true, false, rig.deps);
    expect(code).toBe(0);
    expect(rig.checkedKeys).toEqual([]);
  });

  test("skipping the paste (Enter) still saves nothing and moves on", async () => {
    const rig = initKeyRig({
      pastes: [""],
      verdict: () => OK_LARKSPUR,
    });
    await cmdInit(false, false, rig.deps);
    expect(rig.savedKeys).toEqual([]);
    expect(rig.checkedKeys).toEqual([]);
    expect(rig.logs.join("\n")).toContain("No key saved.");
  });
});

// ---------------------------------------------------------------------------
// cmdStatus honesty
// ---------------------------------------------------------------------------

function statusRig(overrides: Partial<StatusDeps> = {}): {
  deps: StatusDeps;
  logs: string[];
} {
  const logs: string[] = [];
  const deps: StatusDeps = {
    log: (m) => logs.push(m),
    queryStatus: () => ({
      loaded: true,
      running: true,
      pid: 4242,
      lastExitCode: 0,
    }),
    readOutputLog: () => [],
    readErrorLog: () => [],
    hasApiKey: () => true,
    errorLogMtimeMs: () => null,
    now: () => 10_000_000_000,
    claudeTelemetryOn: () => true,
    codexInstalled: () => true,
    claudeInstalled: () => true,
    codexCaptureWired: () => true,
    controlIsArmed: () => false,
    // Pinned so a controlIsArmed override can never spawn the real Codex
    // app-server (the seam exists for exactly that reason).
    codexControlStatus: async () => ({ state: "armed" }),
    authHold: () => null,
    queueDepth: () => 0,
    capsSpentMtimeMs: () => null,
    ...overrides,
  };
  return { deps, logs };
}

describe("cmdStatus during an auth hold", () => {
  const HOLD = heldState();

  test("the Key row goes red with the hold start time and the fix", async () => {
    const { deps, logs } = statusRig({ authHold: () => HOLD });
    await cmdStatus(deps);
    const out = logs.join("\n");
    expect(out).toContain(
      "  Key:         PROBLEM. Your last send was rejected: this key isn't working, and nothing's been sent since 2026-08-26 14:03 UTC.",
    );
    expect(out).toContain("paste a working secret key");
    expect(out).not.toContain("Key:         OK.");
  });

  test("the Meter row stops claiming capture while held", async () => {
    const { deps, logs } = statusRig({ authHold: () => HOLD });
    await cmdStatus(deps);
    const out = logs.join("\n");
    expect(out).toContain(
      "  Meter:       Running, and still recording your spend locally, but nothing's being sent. See the Key line above.",
    );
    expect(out).not.toContain("Your spend is being captured");
  });

  test("no hold = the green rows, byte-identical to before", async () => {
    const { deps, logs } = statusRig();
    await cmdStatus(deps);
    const out = logs.join("\n");
    expect(out).toContain(
      "  Meter:       OK. The background meter is running. Your spend is being captured.",
    );
    expect(out).toContain("  Key:         OK. Saved in");
    expect(out).not.toContain("Queue:");
  });

  test("a parked queue gets its own row; an empty one gets none", async () => {
    const withQueue = statusRig({
      authHold: () => HOLD,
      queueDepth: () => 7,
    });
    await cmdStatus(withQueue.deps);
    expect(withQueue.logs.join("\n")).toContain(
      "  Queue:       7 record(s) waiting to send: turns, and anything you counted with done. They're saved on disk and will go out once the key works.",
    );

    const noQueue = statusRig({ authHold: () => HOLD, queueDepth: () => 0 });
    await cmdStatus(noQueue.deps);
    expect(noQueue.logs.join("\n")).not.toContain("Queue:");
  });

  test("a network-outage queue (no hold) words the row cause-neutrally", async () => {
    const { deps, logs } = statusRig({ queueDepth: () => 3 });
    await cmdStatus(deps);
    expect(logs.join("\n")).toContain(
      "  Queue:       3 record(s) waiting to send: turns, and anything you counted with done. They're saved on disk and will go out when sending recovers.",
    );
  });

  test("armed caps with hour-stale spend numbers warn; fresh numbers stay quiet", async () => {
    const NOW = 10_000_000_000;
    const stale = statusRig({
      controlIsArmed: () => true,
      capsSpentMtimeMs: () => NOW - 3601 * 1000,
    });
    await cmdStatus(stale.deps);
    expect(stale.logs.join("\n")).toContain(
      "your spend caps aren't being enforced right now",
    );

    const fresh = statusRig({
      controlIsArmed: () => true,
      capsSpentMtimeMs: () => NOW - 60 * 1000,
    });
    await cmdStatus(fresh.deps);
    expect(fresh.logs.join("\n")).not.toContain("spend caps aren't being");

    const unarmed = statusRig({
      controlIsArmed: () => false,
      capsSpentMtimeMs: () => NOW - 3601 * 1000,
    });
    await cmdStatus(unarmed.deps);
    expect(unarmed.logs.join("\n")).not.toContain("spend caps are not being");
  });

  test("layout holds: the Key row is still the first non-empty line, all rows at column 15", async () => {
    const { deps, logs } = statusRig({
      authHold: () => HOLD,
      queueDepth: () => 2,
    });
    await cmdStatus(deps);
    const out = logs.join("\n");
    const firstLine = out.split("\n").find((line) => line.trim().length > 0);
    expect(firstLine).toMatch(/^ {2}Key: {9}/);
    expect(out).toMatch(/^ {2}Meter: {7}\S/m);
    expect(out).toMatch(/^ {2}Claude Code: \S/m);
    expect(out).toMatch(/^ {2}Codex: {7}\S/m);
    expect(out).toMatch(/^ {2}Queue: {7}\S/m);
    expectCleanCopy(out.split("\n"));
  });
});
