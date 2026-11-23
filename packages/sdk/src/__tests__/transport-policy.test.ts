/**
 * The SDK half of the shared transport policy: there is no built-in server,
 * a missing or unsafe address stops client construction, every request is
 * checked against the one configured server, and redirects are refused so the
 * API key header can never follow one.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import axios from "axios";
import { HttpClient } from "../utils/http";
import { MarginFrontClient } from "../client";
import { InitializationError, NetworkError } from "../errors";
import {
  isInsecureHttpOptIn,
  isRequestToServer,
  maskApiKey,
  resolveServerUrl,
} from "../transport-policy";

const KEY = "mf_sk_test_fake";

function constructionMessage(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(InitializationError);
    return (error as Error).message;
  }
  throw new Error("expected construction to throw");
}

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

describe("SDK client construction", () => {
  const saved = {
    url: process.env["MARGINFRONT_API_URL"],
    insecure: process.env["MARGINFRONT_ALLOW_INSECURE_HTTP"],
  };

  beforeEach(() => {
    delete process.env["MARGINFRONT_API_URL"];
    delete process.env["MARGINFRONT_ALLOW_INSECURE_HTTP"];
  });

  afterEach(() => {
    if (saved.url === undefined) delete process.env["MARGINFRONT_API_URL"];
    else process.env["MARGINFRONT_API_URL"] = saved.url;
    if (saved.insecure === undefined)
      delete process.env["MARGINFRONT_ALLOW_INSECURE_HTTP"];
    else process.env["MARGINFRONT_ALLOW_INSECURE_HTTP"] = saved.insecure;
  });

  test("with no server set, construction stops with a message that says what to set", () => {
    const message = constructionMessage(() => new HttpClient({ apiKey: KEY }));
    expect(message).toContain("MARGINFRONT_API_URL");
    expect(message).toContain("baseUrl");
    expect(message).not.toContain("marginfront.com");
    expect(() => new MarginFrontClient({ apiKey: KEY })).toThrow(
      InitializationError,
    );
    expect(() => new MarginFrontClient(KEY)).toThrow(InitializationError);
  });

  test("the deprecated names from older releases are not read", () => {
    process.env["MF_BASE_URL"] = "http://localhost:4000/v1";
    process.env["MF_API_BASE_URL"] = "http://localhost:4000/v1";
    try {
      expect(() => new HttpClient({ apiKey: KEY })).toThrow(
        InitializationError,
      );
    } finally {
      delete process.env["MF_BASE_URL"];
      delete process.env["MF_API_BASE_URL"];
    }
  });

  test("the server can come from the baseUrl option or from MARGINFRONT_API_URL", () => {
    expect(
      () =>
        new HttpClient({
          apiKey: KEY,
          baseUrl: "https://billing.example.com/v1",
        }),
    ).not.toThrow();
    process.env["MARGINFRONT_API_URL"] = "http://localhost:4000/v1";
    expect(() => new HttpClient({ apiKey: KEY })).not.toThrow();
    expect(() => new MarginFrontClient(KEY)).not.toThrow();
  });

  test("a bad MARGINFRONT_API_URL stops construction instead of falling back", () => {
    process.env["MARGINFRONT_API_URL"] = "not a url";
    expect(() => new HttpClient({ apiKey: KEY })).toThrow(InitializationError);
  });

  test("http to another machine is refused, and allowed only by the explicit opt-in", () => {
    const remote = "http://billing.internal:4000/v1";
    const message = constructionMessage(
      () => new HttpClient({ apiKey: KEY, baseUrl: remote }),
    );
    expect(message).toContain("billing.internal");
    expect(message).toContain("MARGINFRONT_ALLOW_INSECURE_HTTP");

    expect(
      () =>
        new HttpClient({
          apiKey: KEY,
          baseUrl: remote,
          allowInsecureHttp: true,
        }),
    ).not.toThrow();

    process.env["MARGINFRONT_ALLOW_INSECURE_HTTP"] = "1";
    expect(
      () => new HttpClient({ apiKey: KEY, baseUrl: remote }),
    ).not.toThrow();
    expect(
      () =>
        new HttpClient({
          apiKey: KEY,
          baseUrl: remote,
          allowInsecureHttp: false,
        }),
    ).toThrow(InitializationError);
  });

  test("malformed addresses and addresses carrying a login are refused", () => {
    expect(() => new HttpClient({ apiKey: KEY, baseUrl: "not a url" })).toThrow(
      InitializationError,
    );
    const message = constructionMessage(
      () =>
        new HttpClient({
          apiKey: KEY,
          baseUrl: "https://someone:hunter2@billing.example.com/v1",
        }),
    );
    expect(message).not.toContain("hunter2");
  });

  test("getMaskedApiKey returns exactly maskApiKey(key) and never leaks the raw key", () => {
    const RAW = "mf_sk_test_abcdefghijklmnop1234";
    const client = new MarginFrontClient({
      apiKey: RAW,
      baseUrl: "http://localhost:4000/v1",
    });
    expect(client.getMaskedApiKey()).toBe(maskApiKey(RAW));
    expect(client.getMaskedApiKey()).not.toContain(RAW);
  });
});

describe("SDK requests stay on the configured server", () => {
  interface Seen {
    url: string;
    apiKey: string | undefined;
  }

  let elsewhere: http.Server;
  let configured: http.Server;
  let seenElsewhere: Seen[];
  let seenConfigured: Seen[];
  let configuredUrl: string;
  let elsewhereUrl: string;

  const listen = (server: http.Server): Promise<number> =>
    new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as AddressInfo).port);
      });
    });

  beforeEach(async () => {
    seenElsewhere = [];
    seenConfigured = [];
    elsewhere = http.createServer((req, res) => {
      seenElsewhere.push({
        url: req.url ?? "",
        apiKey: req.headers["x-api-key"] as string | undefined,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ stolen: true }));
    });
    const elsewherePort = await listen(elsewhere);
    elsewhereUrl = `http://127.0.0.1:${elsewherePort}`;

    configured = http.createServer((req, res) => {
      seenConfigured.push({
        url: req.url ?? "",
        apiKey: req.headers["x-api-key"] as string | undefined,
      });
      if (req.url?.startsWith("/prefix/v1/redirect")) {
        res.writeHead(302, { Location: `${elsewhereUrl}/landed` });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const configuredPort = await listen(configured);
    configuredUrl = `http://127.0.0.1:${configuredPort}/prefix/v1`;
  });

  afterEach(async () => {
    await new Promise((resolve) => elsewhere.close(resolve));
    await new Promise((resolve) => configured.close(resolve));
  });

  test("a redirect is refused and the API key never reaches the second address", async () => {
    const client = new HttpClient({
      apiKey: KEY,
      baseUrl: configuredUrl,
      retries: 0,
    });

    const failure = await client.get("/redirect").catch((error) => error);

    expect(failure).toBeInstanceOf(NetworkError);
    expect((failure as Error).message).toContain("redirect");
    expect((failure as Error).message).toContain("302");
    expect(seenConfigured).toHaveLength(1);
    expect(seenConfigured[0].apiKey).toBe(KEY);
    expect(seenElsewhere).toHaveLength(0);
  });

  test("a redirect is not retried", async () => {
    const client = new HttpClient({
      apiKey: KEY,
      baseUrl: configuredUrl,
      retries: 3,
      retryDelay: 1,
    });
    await client.get("/redirect").catch(() => undefined);
    expect(seenConfigured).toHaveLength(1);
    expect(seenElsewhere).toHaveLength(0);
  });

  test("on the fetch adapter (edge runtimes) a redirect is still refused", async () => {
    const adapterBefore = axios.defaults.adapter;
    axios.defaults.adapter = "fetch";
    try {
      const client = new HttpClient({
        apiKey: KEY,
        baseUrl: configuredUrl,
        retries: 0,
      });

      const failure = await client.get("/redirect").catch((error) => error);

      expect(failure).toBeInstanceOf(NetworkError);
      expect((failure as Error).message).toContain("302");
      expect(seenConfigured).toHaveLength(1);
      expect(seenElsewhere).toHaveLength(0);
    } finally {
      axios.defaults.adapter = adapterBefore;
    }
  });

  test.each(["HTTP_PROXY", "http_proxy", "ALL_PROXY"])(
    "a proxy named in %s never sees the request or the API key",
    async (proxySetting) => {
      const valueBefore = process.env[proxySetting];
      const noProxyBefore = {
        upper: process.env.NO_PROXY,
        lower: process.env.no_proxy,
      };
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;
      process.env[proxySetting] = elsewhereUrl;
      try {
        const client = new HttpClient({
          apiKey: KEY,
          baseUrl: configuredUrl,
          retries: 0,
        });
        await client.get("/verify");
      } finally {
        if (valueBefore === undefined) delete process.env[proxySetting];
        else process.env[proxySetting] = valueBefore;
        if (noProxyBefore.upper !== undefined)
          process.env.NO_PROXY = noProxyBefore.upper;
        if (noProxyBefore.lower !== undefined)
          process.env.no_proxy = noProxyBefore.lower;
      }

      expect(seenElsewhere).toHaveLength(0);
      expect(seenConfigured).toHaveLength(1);
      expect(seenConfigured[0].apiKey).toBe(KEY);
    },
  );

  test("a request built for another host is stopped before anything is sent", async () => {
    const client = new HttpClient({
      apiKey: KEY,
      baseUrl: configuredUrl,
      retries: 0,
    });

    for (const target of [
      `${elsewhereUrl}/landed`,
      `//127.0.0.1:${new URL(elsewhereUrl).port}/landed`,
    ]) {
      const failure = await client.get(target).catch((error) => error);
      expect(failure).toBeInstanceOf(InitializationError);
      expect((failure as Error).message).toContain("Request not sent");
    }
    expect(seenElsewhere).toHaveLength(0);
    expect(seenConfigured).toHaveLength(0);
  });

  test("a path prefix in the server address is kept on every request", async () => {
    const client = new HttpClient({
      apiKey: KEY,
      baseUrl: `${configuredUrl}/`,
      retries: 0,
    });
    await client.get("/verify");
    await client.post("usage/record", {});
    expect(seenConfigured.map((seen) => seen.url)).toEqual([
      "/prefix/v1/verify",
      "/prefix/v1/usage/record",
    ]);
  });
});

test("transport-policy.ts stays byte-identical across all three packages", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const here = read("../transport-policy.ts");
  expect(read("../../../code-cost-clarity/src/transport-policy.ts")).toBe(here);
  expect(read("../../../mcp/src/transport-policy.ts")).toBe(here);
});

test("no SDK source file names a marginfront.com host or the npm registry", () => {
  const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
  const sourceFiles = (
    readdirSync(sourceRoot, { recursive: true }) as string[]
  ).filter((file) => file.endsWith(".ts") && !file.includes("__tests__"));
  expect(sourceFiles.length).toBeGreaterThan(10);
  for (const file of sourceFiles) {
    const source = readFileSync(join(sourceRoot, file), "utf8");
    expect(source, file).not.toMatch(/marginfront\.com/i);
    expect(source, file).not.toMatch(/registry\.npmjs\.org/i);
    expect(source, file).not.toMatch(/@latest/);
    expect(source, file).not.toMatch(/vercel\.app/i);
  }
});
