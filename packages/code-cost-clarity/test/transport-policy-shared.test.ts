// transport-policy-shared.test.ts
// ---------------------------------------------------------------------------
// Guards that reach across the three packages on purpose:
//
//   1. The shared transport-policy.ts is copied byte-for-byte (no drift). The
//      packages are built separately and cannot import each other, so this test
//      is what keeps the three copies honest.
//   2. No package source names a marginfront.com host, the npm registry, or an
//      @latest install: there is no built-in server and nothing self-updates.
// ---------------------------------------------------------------------------

import { test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_TRANSPORT_TARGETS,
  INSECURE_HTTP_SETTING,
  SERVER_URL_SETTING,
} from "../src/transport-policy";

const CCC_POLICY = new URL("../src/transport-policy.ts", import.meta.url);
const SDK_POLICY = new URL(
  "../../sdk/src/transport-policy.ts",
  import.meta.url,
);
const MCP_POLICY = new URL(
  "../../mcp/src/transport-policy.ts",
  import.meta.url,
);

test("the shared transport-policy.ts is byte-identical across CCC, SDK, and MCP", () => {
  const ccc = readFileSync(CCC_POLICY, "utf8");
  expect(readFileSync(SDK_POLICY, "utf8")).toBe(ccc);
  expect(readFileSync(MCP_POLICY, "utf8")).toBe(ccc);
});

test("the three packages share one setting name and advertise no host", () => {
  expect(SERVER_URL_SETTING).toBe("MARGINFRONT_API_URL");
  expect(INSECURE_HTTP_SETTING).toBe("MARGINFRONT_ALLOW_INSECURE_HTTP");
  expect(ALLOWED_TRANSPORT_TARGETS).toContain("MARGINFRONT_API_URL");
  expect(ALLOWED_TRANSPORT_TARGETS).not.toMatch(/marginfront\.com/i);
});

function sourceFilesOf(packageDir: string): string[] {
  const root = fileURLToPath(
    new URL(`../../${packageDir}/src`, import.meta.url),
  );
  return (readdirSync(root, { recursive: true }) as string[])
    .filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.includes("__tests__") &&
        !file.endsWith(".test.ts"),
    )
    .map((file) => join(root, file));
}

test("no source file in any of the three packages names a marginfront.com host, the npm registry or an @latest install", () => {
  const files = [
    ...sourceFilesOf("code-cost-clarity"),
    ...sourceFilesOf("sdk"),
    ...sourceFilesOf("mcp"),
  ];
  expect(files.length).toBeGreaterThan(30);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toMatch(/marginfront\.com/i);
    expect(source, file).not.toMatch(/registry\.npmjs\.org|npmjs\.com/i);
    expect(source, file).not.toMatch(/@latest/);
  }
});

test("the only npx command left in CCC source is the two markers older installs wrote, kept so uninstall can find them", () => {
  const hits: string[] = [];
  for (const file of sourceFilesOf("code-cost-clarity")) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.includes("npx @marginfront/")) hits.push(line.trim());
    }
  }
  expect(hits).toHaveLength(2);
  expect(hits.every((line) => line.includes("removes this block >>>"))).toBe(
    true,
  );
});
