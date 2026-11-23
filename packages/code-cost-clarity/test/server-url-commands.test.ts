// server-url-commands.test.ts
// ---------------------------------------------------------------------------
// The commands' side of "there is no built-in server": `init` settles the server
// address before it makes its first request, and stops when it has none; `done`
// refuses to count when there is nowhere to send.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cmdDone, cmdInit, renderHelp, type InitDeps } from "../src/cli";
import {
  CCC_COMMAND_INVOCATION,
  CCC_SOURCE_INIT_COMMAND,
} from "../src/connector";
import { loadEnvFile, renderEnvFile } from "../src/connector";
import type { KeyCheckResult } from "../src/types";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What a fresh install really has on disk: the shipped template, plus a saved key.
function realTemplateSettings(): Record<string, string> {
  const path = join(mkdtempSync(join(tmpdir(), "ccc-template-")), ".env");
  writeFileSync(path, renderEnvFile());
  const valuesBefore = { ...process.env };
  const loaded = loadEnvFile(path);
  for (const name of Object.keys(loaded)) {
    if (valuesBefore[name] === undefined) delete process.env[name];
  }
  return { ...loaded, MARGINFRONT_API_KEY: "mf_sk_saved" };
}

const SETTINGS = [
  "MARGINFRONT_API_URL",
  "MARGINFRONT_ALLOW_INSECURE_HTTP",
  "MARGINFRONT_INGEST_URL",
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const name of SETTINGS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of SETTINGS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

interface Rig {
  deps: InitDeps;
  logs: string[];
  errors: string[];
  savedUrls: string[];
  keyChecks: Array<{ key: string; server: string | undefined }>;
  laterSteps: string[];
}

// Everything after the server step is stubbed to do nothing and record that it ran,
// so "init stopped" and "init went on" are both observable.
function rig(overrides: Partial<InitDeps> = {}): Rig {
  const logs: string[] = [];
  const errors: string[] = [];
  const savedUrls: string[] = [];
  const keyChecks: Rig["keyChecks"] = [];
  const laterSteps: string[] = [];
  const deps: InitDeps = {
    platform: () => "linux",
    ensureConfigFiles: () => {},
    ensureCollectorBinary: () => {},
    stageMeterProgram: () => {},
    loadEnv: () => ({ MARGINFRONT_API_KEY: "mf_sk_saved" }),
    isTTY: () => false,
    writeServerUrl: (value) => {
      savedUrls.push(value);
    },
    checkKey: async (key): Promise<KeyCheckResult> => {
      keyChecks.push({ key, server: process.env.MARGINFRONT_API_URL });
      return { ok: true, organizationName: "Larkspur AI", keyType: "secret" };
    },
    clearAuthHold: () => {},
    codexInstalled: () => false,
    claudeInstalled: () => false,
    detectCacheTtl: () => null,
    promptConsent: async () => {
      laterSteps.push("consent");
      return false;
    },
    installDaemon: () => {
      laterSteps.push("installDaemon");
      return { reloaded: false };
    },
    findZshrcLines: () => ({ found: false, matchedLines: [] }),
    log: (message) => logs.push(message),
    errorLog: (message) => errors.push(message),
    ...overrides,
  };
  return { deps, logs, errors, savedUrls, keyChecks, laterSteps };
}

describe("init settles the server before anything else", () => {
  test("no server anywhere and no terminal: init stops, exit 1, and makes no request", async () => {
    const r = rig();
    expect(await cmdInit(true, false, r.deps)).toBe(1);
    const said = r.errors.join("\n");
    expect(said).toContain("Setup stopped");
    expect(said).toContain("MARGINFRONT_API_URL");
    expect(said).toContain(`${CCC_SOURCE_INIT_COMMAND} --api-url`);
    expect(said).not.toMatch(/marginfront\.com/i);
    expect(r.keyChecks).toEqual([]);
    expect(r.savedUrls).toEqual([]);
    expect(r.laterSteps).toEqual([]);
  });

  test("--api-url is validated, saved, and is what the key check then uses", async () => {
    const r = rig({ apiUrl: "https://billing.example.com/v1/" });
    await cmdInit(true, false, r.deps);
    expect(r.errors).toEqual([]);
    expect(r.savedUrls).toEqual(["https://billing.example.com/v1"]);
    expect(r.keyChecks).toEqual([
      { key: "mf_sk_saved", server: "https://billing.example.com/v1" },
    ]);
  });

  test("a bad --api-url stops init and is never saved", async () => {
    for (const bad of [
      "not a url",
      "http://billing.internal:4000/v1",
      "https://u:p@billing.example.com/v1",
      "",
    ]) {
      const r = rig({ apiUrl: bad });
      expect(await cmdInit(true, false, r.deps)).toBe(1);
      expect(r.errors.join("\n")).toContain("--api-url");
      expect(r.savedUrls).toEqual([]);
      expect(r.keyChecks).toEqual([]);
    }
  });

  test("http to another machine passes --api-url only with the opt-in in the settings file", async () => {
    const r = rig({
      apiUrl: "http://billing.internal:4000/v1",
      loadEnv: () => ({
        MARGINFRONT_API_KEY: "mf_sk_saved",
        MARGINFRONT_ALLOW_INSECURE_HTTP: "1",
      }),
    });
    await cmdInit(true, false, r.deps);
    expect(r.savedUrls).toEqual(["http://billing.internal:4000/v1"]);
  });

  test("an http opt-in set only in the shell stops init, because the background meter would refuse the address", async () => {
    process.env.MARGINFRONT_ALLOW_INSECURE_HTTP = "1";
    for (const overrides of [
      { apiUrl: "http://billing.internal:4000/v1" },
      { shellUrl: "http://billing.internal:4000/v1" },
    ]) {
      if (overrides.shellUrl)
        process.env.MARGINFRONT_API_URL = overrides.shellUrl;
      const r = rig({
        apiUrl: overrides.apiUrl,
        loadEnv: realTemplateSettings,
      });
      expect(await cmdInit(true, false, r.deps)).toBe(1);
      const said = r.errors.join("\n");
      expect(said).toContain("Setup stopped");
      expect(said).toContain("MARGINFRONT_ALLOW_INSECURE_HTTP=1");
      expect(r.savedUrls).toEqual([]);
      expect(r.keyChecks).toEqual([]);
    }
  });

  test("an address already in the settings file is used and not rewritten", async () => {
    const r = rig({
      loadEnv: () => ({
        MARGINFRONT_API_KEY: "mf_sk_saved",
        MARGINFRONT_API_URL: "https://saved.example.com/v1",
      }),
    });
    await cmdInit(true, false, r.deps);
    expect(r.savedUrls).toEqual([]);
    expect(r.keyChecks[0].server).toBe("https://saved.example.com/v1");
  });

  test("an address exported in the shell is saved to the settings file, so the background meter gets it too", async () => {
    process.env.MARGINFRONT_API_URL = "https://shell.example.com/v1";
    const r = rig();
    await cmdInit(true, false, r.deps);
    expect(r.savedUrls).toEqual(["https://shell.example.com/v1"]);
  });

  test("a fresh install's settings template has a blank address line, and the exported address is still saved", async () => {
    expect(realTemplateSettings().MARGINFRONT_API_URL).toBe("");
    process.env.MARGINFRONT_API_URL = "https://shell.example.com/v1";
    const r = rig({ loadEnv: realTemplateSettings });
    await cmdInit(true, false, r.deps);
    expect(r.savedUrls).toEqual(["https://shell.example.com/v1"]);
  });

  test("an exported address that differs from the saved one replaces it", async () => {
    process.env.MARGINFRONT_API_URL = "https://shell.example.com/v1";
    const r = rig({
      loadEnv: () => ({
        MARGINFRONT_API_KEY: "mf_sk_saved",
        MARGINFRONT_API_URL: "https://saved.example.com/v1",
      }),
    });
    await cmdInit(true, false, r.deps);
    expect(r.savedUrls).toEqual(["https://shell.example.com/v1"]);
    expect(r.logs.join("\n")).toContain(
      "https://shell.example.com/v1 (saved to",
    );
  });

  test("an unsupported MARGINFRONT_INGEST_URL is not used, and init says what replaces it", async () => {
    const r = rig({
      loadEnv: () => ({
        MARGINFRONT_API_KEY: "mf_sk_saved",
        MARGINFRONT_INGEST_URL: "http://localhost:4000/v1/sdk/usage/record",
      }),
    });
    expect(await cmdInit(true, false, r.deps)).toBe(1);
    expect(r.errors.join("\n")).toContain("MARGINFRONT_INGEST_URL");
    expect(r.keyChecks).toEqual([]);
  });

  test("in a terminal it asks, re-asks after a bad answer, then saves the good one", async () => {
    const answers = ["billing.example.com", "https://billing.example.com/v1"];
    let asked = 0;
    const r = rig({
      isTTY: () => true,
      promptServerUrl: async () => answers[asked++] ?? "",
      promptDeveloperEmail: async () => "",
      writeDeveloperEmail: () => {},
      promptFinishedWork: async () => false,
    });
    await cmdInit(false, false, r.deps);
    expect(asked).toBe(2);
    expect(r.savedUrls).toEqual(["https://billing.example.com/v1"]);
    const said = r.logs.join("\n");
    expect(said).toContain(
      "which MarginFront server should this machine send to?",
    );
    expect(said).toContain("That address can't be used.");
    expect(said).toContain(
      "Saved. This machine sends to https://billing.example.com/v1.",
    );
    expect(r.keyChecks[0].server).toBe("https://billing.example.com/v1");
  });

  test("pressing Enter at the question stops init with nothing saved", async () => {
    const r = rig({ isTTY: () => true, promptServerUrl: async () => "" });
    expect(await cmdInit(false, false, r.deps)).toBe(1);
    expect(r.savedUrls).toEqual([]);
    expect(r.keyChecks).toEqual([]);
    expect(r.errors.join("\n")).toContain("no server address");
  });

  test("three unusable answers stop init", async () => {
    let asked = 0;
    const r = rig({
      isTTY: () => true,
      promptServerUrl: async () => {
        asked += 1;
        return "http://billing.internal:4000/v1";
      },
    });
    expect(await cmdInit(false, false, r.deps)).toBe(1);
    expect(asked).toBe(3);
    expect(r.savedUrls).toEqual([]);
    expect(r.logs.join("\n")).toContain("MARGINFRONT_ALLOW_INSECURE_HTTP=1");
  });
});

describe("init and an address that is not a MarginFront API", () => {
  const notAnApi = async (): Promise<KeyCheckResult> => ({
    ok: false,
    reason: "wrong-address",
    serverUrl: "https://billing.example.com",
  });

  test("a saved key checked against a 404 address: init stops, un-saves the new address and installs nothing", async () => {
    const r = rig({
      apiUrl: "https://billing.example.com",
      checkKey: notAnApi,
    });
    expect(await cmdInit(true, false, r.deps)).toBe(1);
    expect(r.savedUrls).toEqual(["https://billing.example.com", ""]);
    const said = r.errors.join("\n");
    expect(said).toContain("not a MarginFront API address");
    expect(said).toContain("/v1");
    expect(said).toContain(`${CCC_SOURCE_INIT_COMMAND} --api-url`);
    expect(r.laterSteps).toEqual([]);
  });

  test("the address that was saved before the run is put back", async () => {
    const r = rig({
      apiUrl: "https://billing.example.com",
      checkKey: notAnApi,
      loadEnv: () => ({
        MARGINFRONT_API_KEY: "mf_sk_saved",
        MARGINFRONT_API_URL: "https://saved.example.com/v1",
      }),
    });
    expect(await cmdInit(true, false, r.deps)).toBe(1);
    expect(r.savedUrls).toEqual([
      "https://billing.example.com",
      "https://saved.example.com/v1",
    ]);
  });

  test("a pasted key checked against a 404 address is never saved", async () => {
    const savedKeys: string[] = [];
    const r = rig({
      apiUrl: "https://billing.example.com",
      checkKey: notAnApi,
      loadEnv: () => ({}),
      isTTY: () => true,
      promptSecret: async () => "mf_sk_pasted",
      writeApiKey: (value) => {
        savedKeys.push(value);
      },
    });
    expect(await cmdInit(false, false, r.deps)).toBe(1);
    expect(savedKeys).toEqual([]);
    expect(r.savedUrls).toEqual(["https://billing.example.com", ""]);
    expect(r.errors.join("\n")).toContain("no key was saved");
    expect(r.laterSteps).toEqual([]);
  });
});

describe("done with nowhere to send", () => {
  test("counts nothing, posts nothing, and says what to set", async () => {
    const errors: string[] = [];
    let posted = 0;
    const code = await cmdDone(["contract summarized", "--agent", "claude-code"], {
      loadEnv: () => ({
        CCC_DEVELOPER_EMAIL: "sam@example.com",
        MARGINFRONT_API_KEY: "mf_sk_saved",
      }),
      post: async () => {
        posted += 1;
        return { ok: true, parsed: null, body: "" };
      },
      log: () => {},
      errorLog: (message) => errors.push(message),
    });
    expect(code).toBe(2);
    expect(posted).toBe(0);
    expect(errors.join("\n")).toContain("MARGINFRONT_API_URL");
    expect(errors.join("\n")).toContain("Nothing was counted");
  });
});

describe("how the commands are spelled", () => {
  test("help shows the from-source first run and the installed copy, and no registry command", () => {
    const help = renderHelp(() => "darwin");
    expect(help).toContain(CCC_SOURCE_INIT_COMMAND);
    expect(help).toContain(`${CCC_COMMAND_INVOCATION} <command>`);
    expect(help).toContain("--api-url <address>");
    expect(help).not.toMatch(/npx|@latest|marginfront\.com/);
  });
});
