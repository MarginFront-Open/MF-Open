// transport-policy.test.ts
// ---------------------------------------------------------------------------
// The code-cost-clarity half of the shared transport policy. There is no built-in server:
//   - the address comes from MARGINFRONT_API_URL, read at every send, so the
//     settings file (copied into the environment at startup) decides it;
//   - a missing or unsafe address stops the send instead of falling back;
//   - every request is checked against that one server, with its path prefix kept;
//   - a redirect is refused, so the API key header never follows one;
//   - the watcher logs the loaded key MASKED, never raw.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, test, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile, renderEnvFile } from "../src/connector";
import { syncControlState } from "../src/control";
import {
  checkKeyWithServer,
  postToMarginFront,
  probeKeyIdentity,
  watchAndForward,
} from "../src/forwarder";
import {
  controlBaseUrl,
  keyCheckUrl,
  keyIdentityUrl,
  resolveConfiguredServer,
  sendToServer,
  usageRecordUrl,
} from "../src/server-url";
import {
  isInsecureHttpOptIn,
  isRequestToServer,
  maskApiKey,
  resolveServerUrl,
} from "../src/transport-policy";

const KEY = "mf_sk_test_dummy_key_value_1234";

describe("resolveServerUrl", () => {
  test("a missing, blank or non-string value is a problem, never a default", () => {
    for (const raw of [undefined, null, "", "   "]) {
      const result = resolveServerUrl(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problem).toContain("MARGINFRONT_API_URL");
        expect(result.problem).toContain("no built-in server address");
      }
    }
  });

  test("accepts https anywhere and http only to this machine", () => {
    expect(resolveServerUrl("https://billing.example.com/v1")).toEqual({
      ok: true,
      baseUrl: "https://billing.example.com/v1",
    });
    expect(resolveServerUrl("http://localhost:4000/v1")).toEqual({
      ok: true,
      baseUrl: "http://localhost:4000/v1",
    });
    expect(resolveServerUrl("http://127.0.0.1:4000/v1").ok).toBe(true);
    expect(resolveServerUrl("http://[::1]:4000/v1").ok).toBe(true);
    expect(resolveServerUrl("https://localhost:8443/v1").ok).toBe(true);
  });

  test("refuses http to another machine unless the opt-in is on", () => {
    const refused = resolveServerUrl("http://billing.internal:4000/v1");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.problem).toContain("MARGINFRONT_ALLOW_INSECURE_HTTP=1");
      expect(refused.problem).toContain("billing.internal:4000");
    }
    expect(
      resolveServerUrl("http://billing.internal:4000/v1", {
        allowInsecureHttp: true,
      }),
    ).toEqual({ ok: true, baseUrl: "http://billing.internal:4000/v1" });
    expect(resolveServerUrl("http://localhost.evil.com/v1").ok).toBe(false);
    expect(resolveServerUrl("http://127.0.0.1.evil.com/v1").ok).toBe(false);
  });

  test("the opt-in never unlocks anything but plain http", () => {
    const options = { allowInsecureHttp: true };
    expect(resolveServerUrl("ftp://billing.example.com/v1", options).ok).toBe(
      false,
    );
    expect(resolveServerUrl("not a url", options).ok).toBe(false);
    expect(resolveServerUrl("", options).ok).toBe(false);
  });

  test("refuses malformed addresses, other schemes, logins, queries and fragments", () => {
    expect(resolveServerUrl("not a url").ok).toBe(false);
    expect(resolveServerUrl("billing.example.com/v1").ok).toBe(false);
    expect(resolveServerUrl("localhost:4000/v1").ok).toBe(false);
    expect(resolveServerUrl("file:///etc/passwd").ok).toBe(false);
    expect(resolveServerUrl("https://billing.example.com/v1?x=1").ok).toBe(
      false,
    );
    expect(resolveServerUrl("https://billing.example.com/v1#top").ok).toBe(
      false,
    );
    const withLogin = resolveServerUrl(
      "https://someone:hunter2@billing.example.com/v1",
    );
    expect(withLogin.ok).toBe(false);
    if (!withLogin.ok) {
      expect(withLogin.problem).not.toContain("hunter2");
      expect(withLogin.problem).not.toContain("someone");
    }
  });

  test("keeps a path prefix and drops trailing slashes", () => {
    expect(resolveServerUrl("https://example.com/billing/v1///")).toEqual({
      ok: true,
      baseUrl: "https://example.com/billing/v1",
    });
    expect(resolveServerUrl("https://example.com/")).toEqual({
      ok: true,
      baseUrl: "https://example.com",
    });
  });

  test("isInsecureHttpOptIn is on only for 1 or true", () => {
    expect(isInsecureHttpOptIn("1")).toBe(true);
    expect(isInsecureHttpOptIn("true")).toBe(true);
    expect(isInsecureHttpOptIn(" TRUE ")).toBe(true);
    expect(isInsecureHttpOptIn(undefined)).toBe(false);
    expect(isInsecureHttpOptIn("")).toBe(false);
    expect(isInsecureHttpOptIn("0")).toBe(false);
    expect(isInsecureHttpOptIn("yes")).toBe(false);
  });
});

describe("isRequestToServer", () => {
  const server = "https://example.com/billing/v1";

  test("allows only addresses on the configured server and under its path", () => {
    expect(isRequestToServer(`${server}/verify`, server)).toBe(true);
    expect(isRequestToServer(server, server)).toBe(true);
    expect(isRequestToServer(`${server}/usage?x=1`, server)).toBe(true);
    expect(isRequestToServer("https://example.com/other/v1/x", server)).toBe(
      false,
    );
    expect(isRequestToServer("https://example.com/billing/v10", server)).toBe(
      false,
    );
    expect(
      isRequestToServer("https://example.com/billing/v1/../../x", server),
    ).toBe(false);
    expect(isRequestToServer("https://evil.com/billing/v1/x", server)).toBe(
      false,
    );
    expect(isRequestToServer("http://example.com/billing/v1/x", server)).toBe(
      false,
    );
    expect(
      isRequestToServer("https://example.com:8443/billing/v1/x", server),
    ).toBe(false);
    expect(
      isRequestToServer("https://example.com.evil.com/billing/v1/x", server),
    ).toBe(false);
    expect(
      isRequestToServer("https://u:p@example.com/billing/v1/x", server),
    ).toBe(false);
    expect(isRequestToServer("not a url", server)).toBe(false);
  });
});

test("maskApiKey masks long keys with prefix + last-4 and short keys prefix-only", () => {
  const longKey = "mf_sk_test_fakefakefakefake0000";
  expect(maskApiKey(longKey)).toBe("mf_sk_test_fakef...0000");
  expect(maskApiKey("mf_sk_short")).toBe("mf_sk_sh...");
  expect(maskApiKey(longKey)).not.toContain(longKey);
});

// Every test below owns the three variables that decide where things are sent.
const SETTINGS = [
  "MARGINFRONT_API_URL",
  "MARGINFRONT_ALLOW_INSECURE_HTTP",
  "MARGINFRONT_INGEST_URL",
  "MARGINFRONT_API_KEY",
] as const;
let savedSettings: Record<string, string | undefined>;

beforeEach(() => {
  savedSettings = {};
  for (const name of SETTINGS) {
    savedSettings[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of SETTINGS) {
    if (savedSettings[name] === undefined) delete process.env[name];
    else process.env[name] = savedSettings[name];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function recordingFetch(status = 200, body: unknown = {}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("resolveConfiguredServer", () => {
  test("nothing set is a problem, never a default", () => {
    const result = resolveConfiguredServer({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain("MARGINFRONT_API_URL");
  });

  test("an unsupported MARGINFRONT_INGEST_URL is not read, and the message says what replaces it", () => {
    const result = resolveConfiguredServer({
      MARGINFRONT_INGEST_URL: "http://localhost:4000/v1/sdk/usage/record",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toContain("MARGINFRONT_INGEST_URL");
      expect(result.problem).toContain("replace it with MARGINFRONT_API_URL");
    }
  });

  test("the opt-in comes from MARGINFRONT_ALLOW_INSECURE_HTTP and is off by default", () => {
    const remote = "http://billing.internal:4000/v1";
    expect(resolveConfiguredServer({ MARGINFRONT_API_URL: remote }).ok).toBe(
      false,
    );
    expect(
      resolveConfiguredServer({
        MARGINFRONT_API_URL: remote,
        MARGINFRONT_ALLOW_INSECURE_HTTP: "1",
      }),
    ).toEqual({ ok: true, baseUrl: remote });
  });

  test("an explicit address replaces the saved one but passes the same checks", () => {
    const env = { MARGINFRONT_API_URL: "https://old.example.com/v1" };
    expect(resolveConfiguredServer(env, "https://new.example.com/v1")).toEqual({
      ok: true,
      baseUrl: "https://new.example.com/v1",
    });
    expect(resolveConfiguredServer(env, "http://new.example.com/v1").ok).toBe(
      false,
    );
    expect(resolveConfiguredServer(env, "").ok).toBe(false);
  });
});

describe("every endpoint keeps the server's path prefix", () => {
  const server = "https://example.com/billing/v1";

  test("the four endpoint builders add to the configured path", () => {
    expect(usageRecordUrl(server)).toBe(
      "https://example.com/billing/v1/sdk/usage/record",
    );
    expect(keyCheckUrl(server)).toBe("https://example.com/billing/v1/verify");
    expect(keyIdentityUrl(server)).toBe(
      "https://example.com/billing/v1/me/key",
    );
    expect(controlBaseUrl(server)).toBe(
      "https://example.com/billing/v1/control",
    );
  });

  test("the usage send, the key check and the cap sync all request under the prefix", async () => {
    process.env.MARGINFRONT_API_KEY = KEY;
    const dir = mkdtempSync(join(tmpdir(), "ccc-prefix-"));
    try {
      const post = recordingFetch(200, { results: { success: [] } });
      vi.stubGlobal("fetch", post.fetchImpl);
      await postToMarginFront({ records: [] }, server);

      const check = recordingFetch(200, {
        organization: { name: "Larkspur AI" },
        keyType: "secret",
      });
      await checkKeyWithServer({
        apiKey: KEY,
        serverUrl: server,
        fetchImpl: check.fetchImpl,
      });

      const ownershipPath = join(dir, "ownership.json");
      writeFileSync(ownershipPath, JSON.stringify({ armed: true }));
      const caps = recordingFetch(200, [
        {
          id: "cap_1",
          scope: "org",
          scopeValue: null,
          providerScope: "all",
          mode: "enforce",
          amountUsd: 10,
          period: "week",
          coolOffHours: null,
        },
      ]);
      const synced = await syncControlState({
        apiKey: KEY,
        serverUrl: server,
        fetchImpl: caps.fetchImpl,
        ownershipPath,
        policyPath: join(dir, "policy.json"),
        spentPath: join(dir, "spent.json"),
      });

      expect(post.calls.map((call) => call.url)).toEqual([
        "https://example.com/billing/v1/sdk/usage/record",
      ]);
      expect(check.calls.map((call) => call.url)).toEqual([
        "https://example.com/billing/v1/verify",
        "https://example.com/billing/v1/me/key",
      ]);
      if (synced.reason !== "not-armed") {
        expect(caps.calls[0].url).toBe(
          "https://example.com/billing/v1/control/caps",
        );
        expect(
          caps.calls
            .slice(1)
            .every((call) =>
              call.url.startsWith(
                "https://example.com/billing/v1/control/spend?",
              ),
            ),
        ).toBe(true);
      }
      for (const call of [...post.calls, ...check.calls, ...caps.calls]) {
        expect(call.init?.redirect).toBe("manual");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("postToMarginFront", () => {
  test("with no server set, nothing is sent and the message says what to set", async () => {
    const { calls, fetchImpl } = recordingFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    process.env.MARGINFRONT_API_KEY = KEY;

    const result = await postToMarginFront({ records: [] });

    expect(result).toEqual({ ok: false, reason: "blocked-url" });
    expect(calls).toHaveLength(0);
    expect(errors.join("\n")).toContain("MARGINFRONT_API_URL");
    expect(errors.join("\n")).not.toContain("marginfront.com");
    expect(errors.join("\n")).not.toContain(KEY);
  });

  test("a bad address stops the send instead of falling back anywhere", async () => {
    const { calls, fetchImpl } = recordingFetch();
    vi.stubGlobal("fetch", fetchImpl);
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.MARGINFRONT_API_KEY = KEY;

    for (const bad of [
      "not a url",
      "http://billing.internal:4000/v1",
      "https://u:p@billing.example.com/v1",
      "ftp://billing.example.com/v1",
    ]) {
      process.env.MARGINFRONT_API_URL = bad;
      const result = await postToMarginFront({ records: [] });
      expect(result).toEqual({ ok: false, reason: "blocked-url" });
    }
    expect(calls).toHaveLength(0);
  });

  test("http to another machine goes through only with the explicit opt-in", async () => {
    const { calls, fetchImpl } = recordingFetch(200, {
      results: { success: [] },
    });
    vi.stubGlobal("fetch", fetchImpl);
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.MARGINFRONT_API_KEY = KEY;
    process.env.MARGINFRONT_API_URL = "http://billing.internal:4000/v1";

    expect((await postToMarginFront({ records: [] })).ok).toBe(false);
    expect(calls).toHaveLength(0);

    process.env.MARGINFRONT_ALLOW_INSECURE_HTTP = "1";
    expect((await postToMarginFront({ records: [] })).ok).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      "http://billing.internal:4000/v1/sdk/usage/record",
    ]);
  });

  test("the address is read at send time, so a settings file loaded after import decides it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-settings-"));
    const settingsPath = join(dir, ".env");
    writeFileSync(
      settingsPath,
      [
        "MARGINFRONT_API_URL=https://from-the-settings-file.example.com/prefix/v1",
        `MARGINFRONT_API_KEY=${KEY}`,
        "",
      ].join("\n"),
    );
    const { calls, fetchImpl } = recordingFetch(200, {
      results: { success: [] },
    });
    vi.stubGlobal("fetch", fetchImpl);
    try {
      loadEnvFile(settingsPath);
      const result = await postToMarginFront({ records: [] });
      expect(result.ok).toBe(true);
      expect(calls.map((call) => call.url)).toEqual([
        "https://from-the-settings-file.example.com/prefix/v1/sdk/usage/record",
      ]);
      expect(
        (calls[0].init?.headers as Record<string, string>)["x-api-key"],
      ).toBe(KEY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a value exported in the shell still wins over the settings file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-settings-"));
    const settingsPath = join(dir, ".env");
    writeFileSync(
      settingsPath,
      "MARGINFRONT_API_URL=https://file.example.com/v1\n",
    );
    process.env.MARGINFRONT_API_URL = "https://shell.example.com/v1";
    try {
      loadEnvFile(settingsPath);
      expect(resolveConfiguredServer()).toEqual({
        ok: true,
        baseUrl: "https://shell.example.com/v1",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the key check and the cap sync without a usable server", () => {
  test("neither makes a request", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const check = await checkKeyWithServer({ apiKey: KEY, fetchImpl });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("unreachable");

    const probe = await probeKeyIdentity({ apiKey: KEY, fetchImpl });
    expect(probe).toEqual({ ok: false, reason: "network" });

    const dir = mkdtempSync(join(tmpdir(), "ccc-noserver-"));
    try {
      const ownershipPath = join(dir, "ownership.json");
      writeFileSync(ownershipPath, JSON.stringify({ armed: true }));
      const synced = await syncControlState({
        apiKey: KEY,
        fetchImpl,
        ownershipPath,
        policyPath: join(dir, "policy.json"),
        spentPath: join(dir, "spent.json"),
      });
      expect(synced.synced).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("sendToServer", () => {
  test("a request built for another host is stopped before anything is sent", async () => {
    const { calls, fetchImpl } = recordingFetch();
    for (const target of [
      "https://evil.example.com/v1/verify",
      "https://billing.example.com.evil.example.com/v1/verify",
      "http://billing.example.com/v1/verify",
      "https://billing.example.com/other/verify",
    ]) {
      await expect(
        sendToServer("https://billing.example.com/v1", target, {}, fetchImpl),
      ).rejects.toThrow("request not sent");
    }
    expect(calls).toHaveLength(0);
  });

  test("always asks fetch not to follow redirects", async () => {
    const { calls, fetchImpl } = recordingFetch();
    await sendToServer(
      "https://billing.example.com/v1",
      "https://billing.example.com/v1/verify",
      { redirect: "follow" },
      fetchImpl,
    );
    expect(calls[0].init?.redirect).toBe("manual");
  });
});

describe("redirects, against real local servers", () => {
  interface Seen {
    url: string;
    apiKey: string | undefined;
  }
  const servers: Server[] = [];

  async function listen(
    respond: (res: import("node:http").ServerResponse) => void,
  ): Promise<{ origin: string; seen: Seen[] }> {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
      seen.push({
        url: req.url ?? "",
        apiKey: req.headers["x-api-key"] as string | undefined,
      });
      req.resume();
      respond(res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    return { origin: `http://127.0.0.1:${port}`, seen };
  }

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    );
  });

  test("the usage send, the key check and the key probe all refuse a redirect, and the key never reaches the second address", async () => {
    const elsewhere = await listen((res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ organization: { name: "Thief" } }));
    });
    const configured = await listen((res) => {
      res.writeHead(307, { Location: `${elsewhere.origin}/landed` });
      res.end();
    });
    const serverUrl = `${configured.origin}/prefix/v1`;
    process.env.MARGINFRONT_API_KEY = KEY;

    const post = await postToMarginFront({ records: [] }, serverUrl);
    expect(post.ok).toBe(false);
    if (!post.ok && post.reason === "network") {
      expect(post.message).toContain("redirect");
    } else {
      throw new Error(
        `expected a network failure, got ${JSON.stringify(post)}`,
      );
    }

    const check = await checkKeyWithServer({ apiKey: KEY, serverUrl });
    expect(check.ok).toBe(false);
    if (!check.ok && check.reason === "unreachable") {
      expect(check.message).toContain("redirect");
    } else {
      throw new Error(`expected unreachable, got ${JSON.stringify(check)}`);
    }

    expect(await probeKeyIdentity({ apiKey: KEY, serverUrl })).toEqual({
      ok: false,
      reason: "network",
    });

    expect(configured.seen.map((seen) => seen.url)).toEqual([
      "/prefix/v1/sdk/usage/record",
      "/prefix/v1/verify",
      "/prefix/v1/me/key",
    ]);
    expect(configured.seen.every((seen) => seen.apiKey === KEY)).toBe(true);
    expect(elsewhere.seen).toHaveLength(0);
  });
});

describe("the settings template", () => {
  test("has the server line, blank, with no built-in address", () => {
    const template = renderEnvFile();
    expect(template).toMatch(/^MARGINFRONT_API_URL=$/m);
    expect(template).toMatch(/^MARGINFRONT_ALLOW_INSECURE_HTTP=$/m);
    expect(template).not.toMatch(/marginfront\.com/i);
    expect(template).not.toContain("npx ");
  });
});

// ---------------------------------------------------------------------------
// The watcher startup log - masked key present, raw key absent.
// ---------------------------------------------------------------------------
test("watchAndForward logs the loaded API key masked, never raw", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-mask-"));
  const jsonlPath = join(dir, "live.jsonl");
  writeFileSync(jsonlPath, "");

  const RAW_KEY = "mf_sk_test_fakefakefakefake0000";
  process.env.MARGINFRONT_API_KEY = RAW_KEY;
  process.env.MARGINFRONT_API_URL = "http://localhost:4000/v1";

  const logLines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  });

  let stop: (() => void) | undefined;
  try {
    stop = watchAndForward(jsonlPath, {});
    const output = logLines.join("\n");
    expect(output).not.toContain(RAW_KEY);
    expect(output).toContain(maskApiKey(RAW_KEY));
  } finally {
    if (stop) stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
