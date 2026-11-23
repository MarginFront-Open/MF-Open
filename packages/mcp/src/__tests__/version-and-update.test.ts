/**
 * Unit tests for the dynamic MCP version resolver (version.ts), plus the pin
 * that this server never checks a package registry for a newer version.
 *
 * Run: npx vitest run src/__tests__/version-and-update.test.ts
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MCP_VERSION, resolveMcpVersion } from "../version.js";

const packageJsonUrl = new URL("../../package.json", import.meta.url);
const packageVersion = (
  JSON.parse(readFileSync(fileURLToPath(packageJsonUrl), "utf8")) as {
    version: string;
  }
).version;

describe("MCP wire version", () => {
  it("MCP_VERSION equals the version in package.json read at test time", () => {
    expect(MCP_VERSION).toBe(packageVersion);
  });

  it("resolveMcpVersion reads the real package.json version", () => {
    expect(resolveMcpVersion(packageJsonUrl)).toBe(packageVersion);
  });
});

describe("resolveMcpVersion fallback chain (never throws)", () => {
  it("returns 0.0.0-unknown when package.json is missing", () => {
    const missing = new URL("./does-not-exist-package.json", import.meta.url);
    expect(() => resolveMcpVersion(missing)).not.toThrow();
    expect(resolveMcpVersion(missing)).toBe("0.0.0-unknown");
  });

  it("returns 0.0.0-unknown when package.json is malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-version-"));
    const badPath = join(dir, "package.json");
    writeFileSync(badPath, "{ not valid json ");
    const badUrl = pathToFileURL(badPath);
    expect(() => resolveMcpVersion(badUrl)).not.toThrow();
    expect(resolveMcpVersion(badUrl)).toBe("0.0.0-unknown");
  });

  it("returns 0.0.0-unknown when the version field is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-version-"));
    const noVersionPath = join(dir, "package.json");
    writeFileSync(noVersionPath, JSON.stringify({ name: "x" }));
    const noVersionUrl = pathToFileURL(noVersionPath);
    expect(() => resolveMcpVersion(noVersionUrl)).not.toThrow();
    expect(resolveMcpVersion(noVersionUrl)).toBe("0.0.0-unknown");
  });
});

describe("no registry update check", () => {
  const sourceOf = (file: string): string =>
    readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

  it("has no update-check module and index.ts never calls one", () => {
    expect(
      existsSync(fileURLToPath(new URL("../update-check.ts", import.meta.url))),
    ).toBe(false);
    expect(sourceOf("../index.ts")).not.toMatch(/checkForUpdate|update-check/);
  });

  it("no source file names the npm registry or an @latest install", () => {
    for (const file of [
      "../index.ts",
      "../api-client.ts",
      "../version.ts",
      "../server-config.ts",
      "../transport-policy.ts",
    ]) {
      const source = sourceOf(file);
      expect(source, file).not.toMatch(/registry\.npmjs\.org/);
      expect(source, file).not.toMatch(/@latest/);
    }
  });
});
