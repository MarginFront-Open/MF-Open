/**
 * The MCP half of the shared transport policy. There is no built-in server:
 * a missing or unsafe MARGINFRONT_API_URL makes the server exit non-zero at
 * startup, every request is checked against the one configured server, and
 * redirects are refused so the API key header can never follow one.
 *
 * The startup and redirect cases run the built dist/index.js as a child
 * process, the same way an MCP client starts it (run `npm run build` first).
 *
 * Run: npx vitest run src/__tests__/transport-policy.test.ts
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ApiClient, ApiError } from "../api-client.js";
import { resolveStartupServer } from "../server-config.js";
import {
  isInsecureHttpOptIn,
  isRequestToServer,
  maskApiKey,
  resolveServerUrl,
} from "../transport-policy.js";

const KEY = "mf_sk_test_fake";
const DIST_DIR = fileURLToPath(new URL("../../dist", import.meta.url));
const SERVER_ENTRY = join(DIST_DIR, "index.js");

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

test("maskApiKey masks long keys prefix + last-4, short keys prefix-only", () => {
  expect(maskApiKey("mf_sk_test_abcdefghijklmnop1234")).toBe(
    "mf_sk_test_abcde...1234",
  );
  expect(maskApiKey("mf_sk_short")).toBe("mf_sk_sh...");
});

describe("resolveStartupServer", () => {
  test("a missing MARGINFRONT_API_URL is a problem, never a default", () => {
    const result = resolveStartupServer({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain("MARGINFRONT_API_URL");
  });

  test("MF_API_BASE_URL is not read, and the message says to rename it", () => {
    const result = resolveStartupServer({
      MF_API_BASE_URL: "http://localhost:4000/v1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toContain("MF_API_BASE_URL");
      expect(result.problem).toContain("rename it to MARGINFRONT_API_URL");
    }
  });

  test("the opt-in comes from MARGINFRONT_ALLOW_INSECURE_HTTP and is off by default", () => {
    const remote = "http://billing.internal:4000/v1";
    expect(resolveStartupServer({ MARGINFRONT_API_URL: remote }).ok).toBe(
      false,
    );
    expect(
      resolveStartupServer({
        MARGINFRONT_API_URL: remote,
        MARGINFRONT_ALLOW_INSECURE_HTTP: "0",
      }).ok,
    ).toBe(false);
    expect(
      resolveStartupServer({
        MARGINFRONT_API_URL: remote,
        MARGINFRONT_ALLOW_INSECURE_HTTP: "1",
      }),
    ).toEqual({ ok: true, baseUrl: remote });
  });
});

function startAndCapture(env: Record<string, string>): {
  status: number | null;
  stderr: string;
} {
  const result = spawnSync("node", [SERVER_ENTRY], {
    env: { PATH: process.env.PATH ?? "", ...env },
    input: "",
    encoding: "utf8",
    timeout: 10_000,
  });
  return { status: result.status, stderr: result.stderr };
}

describe("startup (built server)", () => {
  test("with no MARGINFRONT_API_URL the server exits non-zero and says what to set", () => {
    const { status, stderr } = startAndCapture({ MF_API_SECRET_KEY: KEY });
    expect(status).toBe(1);
    expect(stderr).toContain("did not start");
    expect(stderr).toContain("MARGINFRONT_API_URL");
    expect(stderr).toContain(
      'export MARGINFRONT_API_URL="http://localhost:4000/v1"',
    );
    expect(stderr).toContain(
      '$env:MARGINFRONT_API_URL = "http://localhost:4000/v1"',
    );
    expect(stderr).not.toContain("marginfront.com");
    expect(stderr).not.toContain(KEY);
  });

  test("a bad address exits non-zero instead of falling back", () => {
    for (const value of ["not a url", "https://u:p@billing.example.com/v1"]) {
      const { status, stderr } = startAndCapture({
        MF_API_SECRET_KEY: KEY,
        MARGINFRONT_API_URL: value,
      });
      expect(status).toBe(1);
      expect(stderr).toContain("did not start");
    }
  });

  test("http to another machine is refused at startup", () => {
    const { status, stderr } = startAndCapture({
      MF_API_SECRET_KEY: KEY,
      MARGINFRONT_API_URL: "http://billing.internal:4000/v1",
    });
    expect(status).toBe(1);
    expect(stderr).toContain("billing.internal");
    expect(stderr).toContain("MARGINFRONT_ALLOW_INSECURE_HTTP=1");
  });

  test("the explicit opt-in lets a private http server start", () => {
    const { status, stderr } = startAndCapture({
      MF_API_SECRET_KEY: KEY,
      MARGINFRONT_API_URL: "http://billing.internal:4000/v1",
      MARGINFRONT_ALLOW_INSECURE_HTTP: "1",
    });
    expect(status).toBe(0);
    expect(stderr).toContain("API: http://billing.internal:4000/v1");
    expect(stderr).not.toContain("did not start");
  });

  test("the missing-key error still shows both shells and never the bare-$ form", () => {
    const { status, stderr } = startAndCapture({
      MARGINFRONT_API_URL: "http://localhost:4000/v1",
    });
    expect(status).toBe(1);
    expect(stderr).toContain('export MF_API_SECRET_KEY="mf_sk_test_your_key');
    expect(stderr).toContain(
      '$env:MF_API_SECRET_KEY = "mf_sk_test_your_key_here"',
    );
    expect(stderr).toContain("Windows PowerShell");
    expect(stderr).not.toMatch(/[^:]\$MF_API_SECRET_KEY/);
  });

  test("logs the API key masked at startup and never prints it raw", () => {
    const RAW = "mf_sk_test_abcdefghijklmnop1234";
    const { stderr } = startAndCapture({
      MF_API_SECRET_KEY: RAW,
      MARGINFRONT_API_URL: "http://localhost:4000/v1",
    });
    expect(stderr).toContain(`Key: ${maskApiKey(RAW)}`);
    expect(stderr).not.toContain(RAW);
  });
});

interface Seen {
  url: string;
  apiKey: string | undefined;
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({
      url: req.url ?? "",
      apiKey: req.headers["x-api-key"] as string | undefined,
    });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}`, seen };
}

describe("requests stay on the configured server", () => {
  const servers: Server[] = [];

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

  async function redirectingPair() {
    const elsewhere = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ stolen: true }));
    });
    const configured = await listen((_req, res) => {
      res.writeHead(302, { Location: `${elsewhere.origin}/landed` });
      res.end();
    });
    servers.push(elsewhere.server, configured.server);
    return { elsewhere, configured };
  }

  test("ApiClient refuses a redirect and the key never reaches the second address", async () => {
    const { elsewhere, configured } = await redirectingPair();
    const api = new ApiClient(KEY, `${configured.origin}/prefix/v1`);

    const failure = await api.get("/verify").catch((error) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(302);
    expect((failure as Error).message).toContain("redirect");
    expect(configured.seen).toEqual([
      { url: "/prefix/v1/verify", apiKey: KEY },
    ]);
    expect(elsewhere.seen).toHaveLength(0);
  });

  test("the built server refuses a redirect during a real tool call", async () => {
    const { elsewhere, configured } = await redirectingPair();
    const transport = new StdioClientTransport({
      command: "node",
      args: [SERVER_ENTRY],
      env: {
        PATH: process.env.PATH ?? "",
        MF_API_SECRET_KEY: KEY,
        MARGINFRONT_API_URL: `${configured.origin}/v1`,
      },
    });
    const client = new Client({ name: "redirect-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "verify", arguments: {} });
      const text = (result.content as Array<{ text: string }>)
        .map((part) => part.text)
        .join("\n");
      expect(result.isError).toBe(true);
      expect(text).toContain("redirect");
    } finally {
      await client.close();
    }
    expect(configured.seen).toHaveLength(1);
    expect(elsewhere.seen).toHaveLength(0);
  });

  test("a path prefix in the server address is kept on every request", async () => {
    const configured = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    servers.push(configured.server);
    const api = new ApiClient(KEY, `${configured.origin}/prefix/v1/`);

    await api.get("/verify", { page: 2 });
    await api.post("/usage/record", {});

    expect(configured.seen.map((seen) => seen.url)).toEqual([
      "/prefix/v1/verify?page=2",
      "/prefix/v1/usage/record",
    ]);
  });

  test("a request built for another host is stopped before anything is sent", async () => {
    const elsewhere = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    servers.push(elsewhere.server);
    const api = new ApiClient(KEY, "http://localhost:4000/v1");
    const escape = `@127.0.0.1:${new URL(elsewhere.origin).port}/landed`;

    const failure = await api.get(escape).catch((error) => error);

    expect((failure as Error).message).toContain("Request not sent");
    expect(elsewhere.seen).toHaveLength(0);
  });
});

test("transport-policy.ts stays byte-identical across all three packages", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const here = read("../transport-policy.ts");
  expect(read("../../../code-cost-clarity/src/transport-policy.ts")).toBe(here);
  expect(read("../../../sdk/src/transport-policy.ts")).toBe(here);
});

test("the built server contains no marginfront.com host and no registry address", () => {
  const built = readdirSync(DIST_DIR).filter((file) => file.endsWith(".js"));
  expect(built).toContain("index.js");
  for (const file of built) {
    const output = readFileSync(join(DIST_DIR, file), "utf8");
    expect(output, file).not.toMatch(/marginfront\.com/i);
    expect(output, file).not.toMatch(/registry\.npmjs\.org/i);
    expect(output, file).not.toMatch(/@latest/);
  }
});
