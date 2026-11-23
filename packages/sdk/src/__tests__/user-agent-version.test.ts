/**
 * User-Agent Version Tests
 *
 * The User-Agent must always carry the real package.json version; a hardcoded
 * literal drifts. Every assertion here reads package.json
 * at test time so these tests can never pin a stale version themselves.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { HttpClient, resolveSdkVersion } from "../utils/http";

const { version: packageJsonVersion } = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf8"),
) as { version: string };

function builtUserAgent(): string | undefined {
  const client = new HttpClient({ apiKey: "mf_sk_test" });
  const axiosDefaults = (
    client as unknown as {
      client: { defaults: { headers: Record<string, unknown> } };
    }
  ).client.defaults.headers;
  return axiosDefaults["User-Agent"] as string | undefined;
}

describe("User-Agent version", () => {
  it("reports the version from package.json, not a hardcoded literal", () => {
    expect(builtUserAgent()).toBe(`marginfront-sdk/${packageJsonVersion}`);
  });

  it("keeps the marginfront-sdk/ slug api-nest's detectSource() matches on", () => {
    expect(builtUserAgent()).toMatch(/^marginfront-sdk\//);
  });
});

describe("resolveSdkVersion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers the build-time injected constant when present", () => {
    vi.stubGlobal("__SDK_VERSION__", "9.9.9-injected");
    expect(resolveSdkVersion("1.2.3")).toBe("9.9.9-injected");
  });

  it("falls back to the package.json version when no constant is injected", () => {
    expect(resolveSdkVersion()).toBe(packageJsonVersion);
  });

  it("returns 0.0.0-unknown instead of throwing when the version is missing", () => {
    expect(() => resolveSdkVersion(null)).not.toThrow();
    expect(resolveSdkVersion(null)).toBe("0.0.0-unknown");
  });

  it("returns 0.0.0-unknown for a non-string version", () => {
    expect(resolveSdkVersion(42)).toBe("0.0.0-unknown");
  });

  it("returns 0.0.0-unknown for an empty-string version", () => {
    expect(resolveSdkVersion("")).toBe("0.0.0-unknown");
  });
});
