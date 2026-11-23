/**
 * This package isn't published to a registry, so checkForUpdate() must report
 * "no update" without touching the network.
 */

import http from "node:http";
import https from "node:https";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { checkForUpdate } from "../update";

const { version: current } = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf8"),
) as { version: string };

describe("checkForUpdate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports no update and makes no network call", async () => {
    const boom = (() => {
      throw new Error("unexpected network call from checkForUpdate");
    }) as never;
    const httpSpy = vi.spyOn(http, "request").mockImplementation(boom);
    const httpsSpy = vi.spyOn(https, "request").mockImplementation(boom);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(boom);

    await expect(checkForUpdate()).resolves.toEqual({
      current,
      latest: null,
      updateAvailable: false,
    });

    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("has no registry address in its source", () => {
    const source = readFileSync(join(__dirname, "../update.ts"), "utf8");
    expect(source).not.toMatch(/registry\.npmjs\.org/);
    expect(source).not.toMatch(/axios/);
  });
});
