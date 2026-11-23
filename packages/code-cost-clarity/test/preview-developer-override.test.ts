// preview-developer-override.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: `preview` tells the TRUTH about who the
// spend gets attributed to. The live watcher resolves CCC_DEVELOPER_EMAIL into a
// per-developer override before it forwards; preview must do the SAME thing so the
// record a user inspects matches the record that actually gets sent.
//
// WHAT EACH CASE CATCHES: if cmdPreview skips the saved settings or never passes a
// developerOverride, it prints the shared login email (user.email from the capture)
// EVEN WHEN CCC_DEVELOPER_EMAIL is set, and the "with override" case fails on
// "login@example.com". The "no override" case guards the default: with the var
// unset, the login email must stand, unchanged.
//
// HOW WE TEST IT WITHOUT TOUCHING THE REAL MACHINE: we run the REAL CLI source as a
// child process via the same TS import hook cli-commands.test.ts uses, with a TEMP
// HOME so loadEnvFile() reads a non-existent ~/.marginfront-ccc/.env (returns {}),
// and NO MARGINFRONT_API_KEY - proving preview still needs no key. The only thing the
// "with override" case changes is the CCC_DEVELOPER_EMAIL env var. We assert the exact
// customerExternalId on the printed record - the real artifact, not a spy.
// ---------------------------------------------------------------------------

import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const CLI_SOURCE = join(PACKAGE_ROOT, "src", "cli.ts");
const TS_HOOK_URL = pathToFileURL(
  join(HERE, "helpers", "ts-import-hook.mjs"),
).href;
const FIXTURE = join(HERE, "fixtures", "claude-with-email.otlp.json");

// Run `node --import <hook> src/cli.ts preview <fixture>` with a controlled env.
// `developerEmail` undefined = the var is NOT set (the default case). A fresh
// temp HOME isolates loadEnvFile() from any real ~/.marginfront-ccc/.env on this box.
function runPreview(developerEmail?: string): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const home = mkdtempSync(join(tmpdir(), "ccc-preview-home-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  // No key configured: preview must work without one.
  delete env.MARGINFRONT_API_KEY;
  // Start from a clean slate, then set the override only when asked.
  delete env.CCC_DEVELOPER_EMAIL;
  if (developerEmail !== undefined) env.CCC_DEVELOPER_EMAIL = developerEmail;
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", TS_HOOK_URL, CLI_SOURCE, "preview", FIXTURE],
      { encoding: "utf8", env, timeout: 30_000 },
    );
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Pull the first top-level JSON object out of mixed stdout (preview prints the JSON
// record, then sometimes a trailing plain-English hint).
function firstJsonObject(text: string): { records: Array<Record<string, unknown>> } {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON object found in CLI output");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0)
        return JSON.parse(text.slice(start, i + 1)) as {
          records: Array<Record<string, unknown>>;
        };
    }
  }
  throw new Error("unbalanced JSON object in CLI output");
}

test("preview WITH CCC_DEVELOPER_EMAIL: the override becomes customerExternalId (the spend lands on the developer, not the shared login)", () => {
  const { stdout, stderr, status } = runPreview("dev@example.com");

  expect(status).toBe(0);
  // No "missing key" complaint - preview must work entirely without a key.
  expect(stderr).not.toMatch(/MARGINFRONT_API_KEY|no.*key/i);

  const body = firstJsonObject(stdout);
  expect(body.records.length).toBeGreaterThan(0);
  // EVERY record is re-attributed to the override (not the capture's login email).
  for (const record of body.records) {
    expect(record.customerExternalId).toBe("dev@example.com");
  }
});

test("preview WITHOUT the override (regression): the capture's login email stands unchanged", () => {
  const { stdout, stderr, status } = runPreview(undefined);

  expect(status).toBe(0);
  expect(stderr).not.toMatch(/MARGINFRONT_API_KEY|no.*key/i);

  const body = firstJsonObject(stdout);
  expect(body.records.length).toBeGreaterThan(0);
  for (const record of body.records) {
    expect(record.customerExternalId).toBe("login@example.com");
  }
});
