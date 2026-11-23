/**
 * Import purity
 *
 * The SDK is a library that runs inside a customer's app. Importing it — and
 * constructing a client — must NEVER print or hit the network. Any output or
 * request here is a serious bug, so these spies sit at the ground
 * truth: process streams, the console, node's http(s).request, and global
 * fetch. vi.resetModules() forces a fresh module registry each case so a
 * top-level side effect can't hide behind a warm cache.
 */

import http from "node:http";
import https from "node:https";
import type { MockInstance } from "vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("import purity", () => {
  let stdoutSpy: MockInstance;
  let stderrSpy: MockInstance;
  let logSpy: MockInstance;
  let errorSpy: MockInstance;
  let warnSpy: MockInstance;
  let httpSpy: MockInstance;
  let httpsSpy: MockInstance;
  let fetchSpy: MockInstance | undefined;

  beforeEach(() => {
    vi.resetModules();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const boom = (() => {
      throw new Error("unexpected network call on import/construction");
    }) as never;
    httpSpy = vi.spyOn(http, "request").mockImplementation(boom);
    httpsSpy = vi.spyOn(https, "request").mockImplementation(boom);
    if (typeof (globalThis as { fetch?: unknown }).fetch === "function") {
      fetchSpy = vi.spyOn(globalThis, "fetch");
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function expectSilentAndOffline(): void {
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
    if (fetchSpy) expect(fetchSpy).not.toHaveBeenCalled();
  }

  it("emits nothing and makes no network call when the public entry is imported", async () => {
    await import("../index");
    expectSilentAndOffline();
  });

  it("emits nothing and makes no network call when a client is constructed", async () => {
    const mod = await import("../index");
    new mod.MarginFrontClient({ apiKey: "mf_sk_test" });
    expectSilentAndOffline();
  });

  it("exposes checkForUpdate without invoking it on import", async () => {
    const mod = await import("../index");
    expect(typeof mod.checkForUpdate).toBe("function");
    expectSilentAndOffline();
  });
});
