// finished-work-init.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: counting SPEND stays zero-config. Counting
// what the AI FINISHES is one optional question at the end of `init`, it defaults to
// No, a scripted install never sees it, `done --setup` re-asks it whenever the answer
// changes, `status` says which mode the machine is in, and `uninstall` takes the note
// back out of the assistant's memory file.
//
// The "defaults to No" half is the one worth a test of its own: this question writes
// into a file the customer's assistant reads on every run, and a question like that
// may never be answered by a press of Enter or by a script that never saw it.
// ---------------------------------------------------------------------------

import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  cmdInit,
  cmdStatus,
  cmdUninstall,
  finishedWorkStatusLine,
  FINISHED_WORK_NAMES_QUESTION,
  FINISHED_WORK_QUESTION,
  type InitDeps,
  type StatusDeps,
  type UninstallDeps,
} from "../src/cli";
import { CCC_COMMAND_INVOCATION } from "../src/connector";

const PKG = "@marginfront/code-cost-clarity";

interface InitProbe {
  askedFinishedWork: number;
  askedNames: number;
  namesWritten: string[];
  blocksWritten: string[][];
  blocksRemoved: number;
}

function initRig(overrides: Partial<InitDeps> = {}): {
  deps: InitDeps;
  probe: InitProbe;
  logs: string[];
} {
  const logs: string[] = [];
  const probe: InitProbe = {
    askedFinishedWork: 0,
    askedNames: 0,
    namesWritten: [],
    blocksWritten: [],
    blocksRemoved: 0,
  };
  const deps: InitDeps = {
    platform: () => "darwin",
    ensureConfigFiles: () => {},
    ensureCollectorBinary: () => {},
    stageMeterProgram: () => {},
    writeServerUrl: () => {},
    loadEnv: () => ({
      MARGINFRONT_API_KEY: "mf_sk_saved",
      CCC_CACHE_WRITE_TTL: "1h",
    }),
    isTTY: () => true,
    hasApiKey: () => true,
    promptSecret: async () => "",
    writeApiKey: () => {},
    checkKey: async () => ({
      ok: true,
      organizationName: "Test Org",
      keyType: "secret",
    }),
    clearAuthHold: () => {},
    gitDefaultEmail: () => "dev@example.com",
    promptDeveloperEmail: async () => "dev@example.com",
    writeDeveloperEmail: () => {},
    detectCacheTtl: () => null,
    promptCacheTtl: async () => "3",
    writeCacheTtl: () => {},
    promptConsent: async () => true,
    promptControlConsent: async () => false,
    codexInstalled: () => false,
    claudeInstalled: () => true,
    writeClaudeTelemetry: () => ({
      written: ["CLAUDE_CODE_ENABLE_TELEMETRY"],
      skipped: [],
      backupPath: null,
      changed: true,
    }),
    writeCodexConfig: () => ({ action: "created", backupPath: null }),
    codexHasCccBlock: () => false,
    installDaemon: () => ({ reloaded: false }),
    installControlScript: () => {},
    installControlHook: () => ({ action: "installed" }),
    installCodexControlHook: () => "no-codex",
    syncControl: async () => {},
    resolveCodexTrust: async () => ({
      state: "unknown",
      reason: "check-failed",
    }),
    findZshrcLines: () => ({ found: false, matchedLines: [] }),
    promptRemoveZshrc: async () => false,
    removeZshrcLines: () => {},
    promptFinishedWork: async () => {
      probe.askedFinishedWork += 1;
      return false;
    },
    promptFinishedNames: async () => {
      probe.askedNames += 1;
      return "";
    },
    writeFinishedNames: (value: string) => {
      probe.namesWritten.push(value);
    },
    writeMemoryBlocks: (names: string[]) => {
      probe.blocksWritten.push(names);
      return names.map((_, index) => ({
        path: `/tmp/home/.claude/CLAUDE.md#${index}`,
        action: "written" as const,
      }));
    },
    removeMemoryBlocks: () => {
      probe.blocksRemoved += 1;
      return [];
    },
    log: (message: string) => logs.push(message),
    errorLog: (message: string) => logs.push(message),
    ...overrides,
  };
  return { deps, probe, logs };
}

describe("init asks once, at the end, and takes No for an answer", () => {
  test("the question is asked as a numbered step", async () => {
    const rig = initRig();
    expect(await cmdInit(false, false, rig.deps)).toBe(0);
    expect(rig.probe.askedFinishedWork).toBe(1);
    // The step plan's total counts it, so the last step is not "Step 4 of 3".
    const plan = rig.logs.find((line) => line.includes("steps."));
    expect(plan).toBeDefined();
    const headers = rig.logs.filter((line) => /Step \d+ of \d+:/.test(line));
    const totals = new Set(
      headers.map((line) => /Step \d+ of (\d+):/.exec(line)?.[1]),
    );
    expect(totals.size).toBe(1);
    expect(Number([...totals][0])).toBe(headers.length);
  });

  test("the question wording is pinned, and it defaults to No", () => {
    expect(FINISHED_WORK_QUESTION).toContain(
      "Want to count finished work too, not only spend?",
    );
    expect(FINISHED_WORK_QUESTION).toContain("(y/N)");
  });

  // A first init answering No must leave the settings file alone. Writing a blank
  // line for an answer that changes nothing is how a fresh install ends up editing a
  // file it never needed to touch, and on a machine where init has not created the
  // config dir yet, it throws.
  test("No on a machine that was already off writes nothing at all", async () => {
    const rig = initRig();
    await cmdInit(false, false, rig.deps);
    expect(rig.probe.askedNames).toBe(0);
    expect(rig.probe.namesWritten).toEqual([]);
    expect(rig.probe.blocksWritten).toEqual([]);
    expect(rig.probe.blocksRemoved).toBe(0);
  });

  test("No on a machine that had it on really turns it off", async () => {
    const rig = initRig({
      currentFinishedNames: () => "contract summarized",
    });
    await cmdInit(false, false, rig.deps);
    expect(rig.probe.namesWritten).toEqual([""]);
    expect(rig.probe.blocksRemoved).toBe(1);
  });

  test("Yes asks for the names, saves them, and writes the note", async () => {
    const rig = initRig({
      promptFinishedWork: async () => true,
      promptFinishedNames: async () => "contract summarized, slide deck",
    });
    await cmdInit(false, false, rig.deps);
    expect(rig.probe.namesWritten).toEqual(["contract summarized, slide deck"]);
    expect(rig.probe.blocksWritten).toEqual([["contract summarized", "slide deck"]]);
  });

  test("Yes with no names stays off rather than writing a note nobody can act on", async () => {
    const rig = initRig({
      promptFinishedWork: async () => true,
      promptFinishedNames: async () => "   ",
    });
    await cmdInit(false, false, rig.deps);
    expect(rig.probe.namesWritten).toEqual([]);
    expect(rig.probe.blocksWritten).toEqual([]);
  });
});

describe("a scripted install never sees the question", () => {
  test("--no-prompt does not ask and writes nothing into any memory file", async () => {
    const rig = initRig();
    expect(await cmdInit(true, false, rig.deps)).toBe(0);
    expect(rig.probe.askedFinishedWork).toBe(0);
    expect(rig.probe.askedNames).toBe(0);
    expect(rig.probe.namesWritten).toEqual([]);
    expect(rig.probe.blocksWritten).toEqual([]);
    expect(rig.probe.blocksRemoved).toBe(0);
  });

  test("a non-TTY run does not ask either", async () => {
    const rig = initRig({ isTTY: () => false });
    await cmdInit(false, false, rig.deps);
    expect(rig.probe.askedFinishedWork).toBe(0);
    expect(rig.probe.namesWritten).toEqual([]);
  });
});

describe("status says which mode this machine is in", () => {
  test("on, with the names", () => {
    const line = finishedWorkStatusLine(["contract summarized", "slide deck"]);
    expect(line).toContain(
      "Finished work: on, 2 names (contract summarized, slide deck)",
    );
    expect(line).toContain(`${CCC_COMMAND_INVOCATION} done`);
  });

  test("one name reads as one name, not one names", () => {
    expect(finishedWorkStatusLine(["contract summarized"])).toContain("1 name (");
  });

  test("off, with the way to turn it on and what turning it on gets you", () => {
    expect(finishedWorkStatusLine([])).toBe(
      `Finished work: off. Run ${CCC_COMMAND_INVOCATION} done --setup to turn it on. On your MarginFront dashboard, open ROI in the left menu (ask whoever owns your MarginFront account if you don't see it), then the Finished work tab, to see what each finished thing cost in AI once it is on.`,
    );
  });

  test("status prints it next to the work-item line", async () => {
    const logs: string[] = [];
    const deps: StatusDeps = {
      platform: () => "darwin",
      queryStatus: () => ({
        loaded: true,
        running: true,
        pid: 1,
        lastExitCode: 0,
      }),
      readOutputLog: () => [],
      readErrorLog: () => [],
      hasApiKey: () => true,
      authHold: () => null,
      queueDepth: () => 0,
      capsSpentMtimeMs: () => null,
      errorLogMtimeMs: () => null,
      now: () => Date.now(),
      workId: () => ({ value: undefined }),
      finishedWorkNames: () => "contract summarized",
      log: (message: string) => logs.push(message),
    };
    await cmdStatus(deps);

    const joined = logs.join("\n");
    expect(joined).toContain("Finished work: on, 1 name (contract summarized)");
    const workItemLine = logs.findIndex((line) =>
      line.startsWith("Work item:"),
    );
    const finishedLine = logs.findIndex((line) =>
      line.startsWith("Finished work:"),
    );
    expect(workItemLine).toBeGreaterThan(-1);
    // The ignore-repos line sits between the two. All three say what the
    // settings file will make the NEXT record carry, so they print as one block.
    expect(logs[workItemLine + 1]).toMatch(/^Ignoring: /);
    expect(finishedLine).toBe(workItemLine + 2);
  });
});

describe("uninstall takes the note back out", () => {
  test("it removes the block from both memory files", async () => {
    const removeMemoryBlocks = vi.fn(() => [
      { path: "/tmp/home/.claude/CLAUDE.md", action: "removed" as const },
      { path: "/tmp/home/.codex/AGENTS.md", action: "missing" as const },
    ]);
    const deps: UninstallDeps = {
      uninstallDaemon: () => {},
      stopCollector: () => {},
      readForwarderPid: () => null,
      isForwarderAlive: () => false,
      signalForwarder: () => {},
      sleep: async () => {},
      now: () => Date.now(),
      removeClaudeTelemetry: () => ({
        removed: ["CLAUDE_CODE_ENABLE_TELEMETRY"],
        kept: [],
        backupPath: null,
      }),
      removeCodexConfig: () => ({ action: "removed", backupPath: null }),
      removeControlHook: () => {},
      removeCodexControlHook: () => {},
      removeRuntimeFile: () => {},
      removeControlStateDir: () => {},
      purgeConfigDir: () => {},
      findZshrcLines: () => ({ found: false, matchedLines: [] }),
      unsetDesktopEnv: () => {},
      removeMemoryBlocks,
      log: () => {},
    };

    expect(await cmdUninstall(false, deps)).toBe(0);
    expect(removeMemoryBlocks).toHaveBeenCalledTimes(1);
  });
});

// The note the assistant reads and every printed command are built from this one
// constant. It is the copy `init` installs, never a registry download.
describe("the invocation is spelled one way", () => {
  test("the connector's constant runs the installed copy with node", () => {
    expect(CCC_COMMAND_INVOCATION).toBe("node ~/.marginfront-ccc/cli.js");
    expect(CCC_COMMAND_INVOCATION).not.toContain("npx");
    expect(CCC_COMMAND_INVOCATION).not.toContain(PKG);
  });
});

// The upgrade path is "stop, then init", and a customer upgrading presses
// Enter through every question. These leave the prompt seams unset so init runs its
// own wiring into the real prompts, with a fake keyboard that types the next answer
// each time a prompt starts listening.
describe("re-running init on a machine that already counts finished work", () => {
  function keyboard(...answers: string[]) {
    const input = new PassThrough();
    const output = new PassThrough();
    let screen = "";
    output.on("data", (chunk: Buffer) => {
      screen += chunk.toString();
    });
    const queue = [...answers];
    input.on("newListener", (event) => {
      if (event !== "keypress") return;
      const next = queue.shift();
      if (next !== undefined) setImmediate(() => input.write(next));
    });
    return {
      overrides: {
        promptFinishedWork: undefined,
        promptFinishedNames: undefined,
        promptIO: { input, output, terminal: true },
      } as Partial<InitDeps>,
      screen: () => screen,
    };
  }

  const askedNamesQuestion = (screen: string) =>
    screen.includes(FINISHED_WORK_NAMES_QUESTION);

  test("a bare Enter keeps it on and leaves the note in place", async () => {
    const keys = keyboard("\n", "\n");
    const rig = initRig({
      currentFinishedNames: () => "contract summarized, slide deck",
      ...keys.overrides,
    });
    await cmdInit(false, false, rig.deps);
    expect(askedNamesQuestion(keys.screen())).toBe(true);
    expect(rig.probe.blocksRemoved).toBe(0);
    expect(rig.probe.namesWritten).toEqual(["contract summarized, slide deck"]);
    expect(rig.probe.blocksWritten).toEqual([["contract summarized", "slide deck"]]);
  });

  test("a deliberate n still turns it off and takes the note out", async () => {
    const keys = keyboard("n\n");
    const rig = initRig({
      currentFinishedNames: () => "contract summarized",
      ...keys.overrides,
    });
    await cmdInit(false, false, rig.deps);
    expect(askedNamesQuestion(keys.screen())).toBe(false);
    expect(rig.probe.namesWritten).toEqual([""]);
    expect(rig.probe.blocksRemoved).toBe(1);
  });

  test("on a fresh machine a bare Enter still means No", async () => {
    const keys = keyboard("\n");
    const rig = initRig({ ...keys.overrides });
    await cmdInit(false, false, rig.deps);
    expect(keys.screen()).toContain(FINISHED_WORK_QUESTION.trim());
    expect(askedNamesQuestion(keys.screen())).toBe(false);
    expect(rig.probe.namesWritten).toEqual([]);
    expect(rig.probe.blocksWritten).toEqual([]);
    expect(rig.probe.blocksRemoved).toBe(0);
  });

  test("the question says what is being counted now and defaults to Yes", async () => {
    const keys = keyboard("\n", "\n");
    const rig = initRig({
      currentFinishedNames: () => "contract summarized, slide deck",
      ...keys.overrides,
    });
    await cmdInit(false, false, rig.deps);
    expect(keys.screen()).toContain(
      "You count finished work now: contract summarized, slide deck. Keep counting it? (Y/n)",
    );
    expect(keys.screen()).not.toContain(FINISHED_WORK_QUESTION.trim());
  });
});
