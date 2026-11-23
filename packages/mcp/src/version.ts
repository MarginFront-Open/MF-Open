/**
 * Single source of truth for the MCP package's version string.
 * Feeds the User-Agent header (`marginfront-mcp/<version>`) in api-client.ts —
 * api-nest's detectSource() matches on it to tag events with `source: mcp` —
 * and the server-info version in the MCP initialize handshake (index.ts).
 *
 * Resolved at runtime from package.json. This package builds with tsc, which
 * has no build-time constant injection like the tsup `define` the SDK and code-cost-clarity use, so a
 * runtime read is the only way a package.json bump alone updates the wire
 * version. Never throws: an unreadable or malformed package.json degrades to
 * `0.0.0-unknown`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function resolveMcpVersion(packageJsonUrl: URL): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(fileURLToPath(packageJsonUrl), "utf8"),
    ) as { version?: unknown };
    if (
      typeof packageJson.version === "string" &&
      packageJson.version.length > 0
    ) {
      return packageJson.version;
    }
  } catch {
    // Unreadable or malformed package.json — fall through to the sentinel.
  }
  return "0.0.0-unknown";
}

export const MCP_VERSION = resolveMcpVersion(
  new URL("../package.json", import.meta.url),
);
