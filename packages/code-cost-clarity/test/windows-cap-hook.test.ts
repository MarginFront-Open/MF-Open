// windows-cap-hook.test.ts: the Windows arm of the cap check.
//
// WHAT THIS FILE PROVES, and why none of it is trivially green:
//
//   THE WHOLE FEATURE IS THE EXIT CODE. Both agents read exit 2 as "stop this tool
//   call" and everything else as "go ahead". If a cap fails to produce a 2, the
//   user has a spending ceiling that is decorative, the one failure this
//   product cannot ship. So every scenario below runs the REAL installed script and
//   asserts the real exit code, per branch: the one that must block, and each of the
//   many that must not.
//
//   THE TRAP THE UNIX SIDE NEEDS A WRAPPER FOR. `python3 <a file that isn't there>`
//   exits 2, which is why check-cap.py is fronted by codex-cap-hook.sh. Node returns
//   1 there instead - and 1 for a syntax error, an uncaught throw, and a directory.
//   The cases below run node against each of those REAL broken states and demand a
//   code that is not 2, because that claim is the entire reason Windows ships no
//   wrapper. If node ever started exiting 2 on its own, these go red.
//
//   IT RUNS ON EVERY PLATFORM ON PURPOSE. The script is node, so macOS and Linux can
//   execute it too. Running the table everywhere means a break in the decision logic
//   surfaces on the fast green lane instead of waiting for the Windows runner. The
//   handful of cases that can only be true on Windows - the installed command string
//   surviving the Windows shell, a path with a space in it - are marked runIf.
//
// Everything runs in temp dirs. Nothing here touches a real ~/.codex or ~/.claude.

import { test, expect, describe } from "vitest";
import { spawnSync, exec } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  mkdirSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeControlScript,
  controlHookCommand,
  codexControlHookCommand,
} from "../src/control";
import { WINDOWS_CAP_SCRIPT_FILENAME } from "../src/windows-control";

const execAsync = promisify(exec);

// A representative PreToolUse event, the shape both agents write to the hook's stdin.
const PRE_TOOL_USE_EVENT = JSON.stringify({
  session_id: "019faa02-0638-7233-bf4a-aba7639aff68",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "echo ok > sentinel.txt" },
  cwd: "C:\\workspace",
});

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
const onWindows = process.platform === "win32";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function tmp(prefix = "ccc-wincap-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function capScript(dir: string): string {
  return join(dir, WINDOWS_CAP_SCRIPT_FILENAME);
}

// Build a control dir holding the Windows cap script + its state files.
function setupWindowsControlDir(
  opts: {
    spentUsd?: number | string | null;
    amountUsd?: number | string;
    mode?: string;
    providerScope?: string;
    scope?: string;
    period?: string;
    // The bucket the meter actually wrote, when a test needs it to NOT match the
    // period the cap names.
    spentPeriod?: string;
    spentAgeSeconds?: number;
    writePolicy?: boolean;
    writeSpent?: boolean;
    corruptPolicy?: boolean;
    whyNote?: string;
    coolOffHours?: number;
  } = {},
  dir: string = tmp(),
): string {
  writeControlScript(capScript(dir), "win32");
  if (opts.writePolicy !== false) {
    const policy = {
      caps: [
        {
          id: "cap-1",
          scope: opts.scope ?? "org",
          providerScope: opts.providerScope ?? "all",
          mode: opts.mode ?? "enforce",
          amountUsd: opts.amountUsd ?? 200,
          period: opts.period ?? "week",
          coolOffHours: opts.coolOffHours ?? null,
          ...(opts.whyNote ? { whyNote: opts.whyNote } : {}),
        },
      ],
    };
    writeFileSync(
      join(dir, "policy.json"),
      opts.corruptPolicy ? "{ not json" : JSON.stringify(policy),
    );
  }
  if (opts.writeSpent !== false) {
    const spentPath = join(dir, "spent.json");
    writeFileSync(
      spentPath,
      JSON.stringify({
        asOf: new Date().toISOString(),
        byPeriod: {
          [opts.spentPeriod ?? opts.period ?? "week"]: {
            windowEndEpoch: FAR_FUTURE,
            [opts.scope ?? "org"]: {
              spentUsd: opts.spentUsd === undefined ? 0 : opts.spentUsd,
            },
          },
        },
      }),
    );
    if (opts.spentAgeSeconds) {
      const when = Date.now() / 1000 - opts.spentAgeSeconds;
      utimesSync(spentPath, when, when);
    }
  }
  return dir;
}

// Run the cap script the way the hook command runs it: node, our event on stdin.
function runCap(dir: string, nodeBin: string = process.execPath): RunResult {
  const res = spawnSync(nodeBin, [capScript(dir)], {
    input: PRE_TOOL_USE_EVENT,
    encoding: "utf8",
  });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

function replaceCap(dir: string, source: string): void {
  writeFileSync(capScript(dir), source);
}

// ---------------------------------------------------------------------------
// the one legitimate stop
// ---------------------------------------------------------------------------

describe("check-cap.mjs: the block path", () => {
  test("over cap, enforce, all providers, fresh -> exit 2, reason on stderr, EMPTY stdout", () => {
    const dir = setupWindowsControlDir({ spentUsd: 250, amountUsd: 200 });
    const { code, stdout, stderr } = runCap(dir);
    expect(code).toBe(2);
    // stdout must stay empty on every path: Codex rejects anything that looks like
    // Claude Code's JSON reply and marks the run failed, letting the call through.
    expect(stdout).toBe("");
    // The same wording check-cap.py produces, so a developer who moves between a Mac
    // and a Windows box reads the identical sentence.
    expect(stderr).toContain(
      "Code Cost Control: your team's week spend cap of $200 is reached (about $250 spent so far).",
    );
    expect(stderr).toContain("contact your admin to raise or reset it");
    expect(stderr).toContain("not the AI declining");
    rmSync(dir, { recursive: true, force: true });
  });

  test("exactly AT the cap blocks - the limit is a ceiling, not a threshold to pass", () => {
    const dir = setupWindowsControlDir({ spentUsd: 200, amountUsd: 200 });
    expect(runCap(dir).code).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an admin why-note reaches the developer", () => {
    const dir = setupWindowsControlDir({
      spentUsd: 250,
      amountUsd: 200,
      whyNote: "Q3 budget is frozen until the 14th",
    });
    const { code, stderr } = runCap(dir);
    expect(code).toBe(2);
    expect(stderr).toContain(
      "Note from your admin: Q3 budget is frozen until the 14th",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("a tripped cool-off keeps braking after spend drops back under the cap", () => {
    const dir = setupWindowsControlDir({
      spentUsd: 250,
      amountUsd: 200,
      coolOffHours: 4,
    });
    expect(runCap(dir).code).toBe(2);

    const tripPath = join(dir, "trip.json");
    expect(existsSync(tripPath)).toBe(true);
    expect(JSON.parse(readFileSync(tripPath, "utf8"))["cap-1"]).toMatchObject({
      coolOffHours: 4,
    });

    // Spend is back under the cap; the cool-off window is what still holds.
    setupWindowsControlDir(
      { spentUsd: 10, amountUsd: 200, coolOffHours: 4 },
      dir,
    );
    const second = runCap(dir);
    expect(second.code).toBe(2);
    expect(second.stderr).toContain("cool-off window");
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// every other branch passes - the fail-open promise
// ---------------------------------------------------------------------------

describe("check-cap.mjs: only a real over-cap decision exits 2", () => {
  const passes: [string, () => string][] = [
    ["under cap", () => setupWindowsControlDir({ spentUsd: 10 })],
    [
      "stale spend, over cap",
      () => setupWindowsControlDir({ spentUsd: 999, spentAgeSeconds: 7200 }),
    ],
    [
      "missing policy",
      () => setupWindowsControlDir({ spentUsd: 999, writePolicy: false }),
    ],
    [
      "corrupt policy",
      () => setupWindowsControlDir({ spentUsd: 999, corruptPolicy: true }),
    ],
    ["missing spend file", () => setupWindowsControlDir({ writeSpent: false })],
    [
      "track-mode cap, over its number",
      () => setupWindowsControlDir({ spentUsd: 999, mode: "track" }),
    ],
    [
      "provider-scoped cap, over its number",
      () =>
        setupWindowsControlDir({ spentUsd: 999, providerScope: "anthropic" }),
    ],
    [
      "honest null spend",
      () => setupWindowsControlDir({ spentUsd: null, amountUsd: 200 }),
    ],
    [
      "the period the cap names has no spend bucket",
      () =>
        setupWindowsControlDir({
          spentUsd: 999,
          period: "day",
          spentPeriod: "week",
        }),
    ],
  ];

  for (const [name, build] of passes) {
    test(`${name} -> exit 0, nothing on either stream`, () => {
      const dir = build();
      expect(runCap(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
      rmSync(dir, { recursive: true, force: true });
    });
  }

  // THE COERCION TRAP, and the reason check-cap.mjs is stricter than check-cap.py.
  // Python raises on "300" >= 200 and lands in its fail-open catch. JavaScript would
  // quietly coerce the string and BLOCK. A malformed file must let you work.
  test("spend recorded as a string, well over the cap -> exit 0, not a block", () => {
    const dir = setupWindowsControlDir({ spentUsd: "300", amountUsd: 200 });
    expect(runCap(dir).code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("cap amount recorded as a string -> exit 0, not a block", () => {
    const dir = setupWindowsControlDir({ spentUsd: 300, amountUsd: "200" });
    expect(runCap(dir).code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// THE TRAPS: a broken install must never exit 2
// ---------------------------------------------------------------------------
//
// This is the block the /bin/sh wrapper exists to cover on Unix, where
// `python3 <missing>` exits 2. The claim here is that node makes the wrapper
// unnecessary, so each case runs the interpreter against a REAL broken state and
// demands a code that is not 2.

describe("check-cap.mjs: a broken install lets the tool call through", () => {
  test("cap script renamed away, over cap -> not 2", () => {
    const dir = setupWindowsControlDir({ spentUsd: 999 });
    renameSync(capScript(dir), join(dir, "moved-away.mjs"));
    expect(runCap(dir).code).not.toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("cap script is a directory, over cap -> not 2", () => {
    const dir = setupWindowsControlDir({ spentUsd: 999 });
    rmSync(capScript(dir), { force: true });
    mkdirSync(capScript(dir));
    expect(runCap(dir).code).not.toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("cap script has a syntax error, over cap -> not 2", () => {
    const dir = setupWindowsControlDir({ spentUsd: 999 });
    replaceCap(dir, "this is ( not javascript\n");
    expect(runCap(dir).code).not.toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("cap script throws while loading, over cap -> not 2", () => {
    const dir = setupWindowsControlDir({ spentUsd: 999 });
    replaceCap(dir, 'throw new Error("boom");\n');
    expect(runCap(dir).code).not.toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no interpreter on PATH, over cap -> not 2", () => {
    const dir = setupWindowsControlDir({ spentUsd: 999 });
    // A node that isn't there is what a stripped PATH looks like to the agent.
    expect(runCap(dir, join(dir, "no-such-node")).code).not.toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("state directory emptied out, over cap in a stale copy -> exit 0", () => {
    const dir = setupWindowsControlDir({ spentUsd: 999 });
    rmSync(join(dir, "policy.json"), { force: true });
    rmSync(join(dir, "spent.json"), { force: true });
    expect(runCap(dir).code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  // NEGATIVE CONTROL. Every assertion above is "not 2", which a script that could
  // never exit 2 would satisfy by accident. This proves the harness can see a 2.
  test("the harness can actually observe an exit 2", () => {
    const dir = setupWindowsControlDir({ spentUsd: 999 });
    replaceCap(dir, "process.exit(2);\n");
    expect(runCap(dir).code).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the script finds its state by its own path, not the caller's cwd", () => {
    const overCap = setupWindowsControlDir({ spentUsd: 999 });
    const elsewhere = tmp("ccc-wincap-cwd-");
    const res = spawnSync(process.execPath, [capScript(overCap)], {
      input: PRE_TOOL_USE_EVENT,
      encoding: "utf8",
      cwd: elsewhere,
    });
    expect(res.status).toBe(2);
    rmSync(overCap, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// the installed command string, run the way an agent runs it
// ---------------------------------------------------------------------------
//
// Everything above spawns the interpreter directly. These run the exact string we
// write into ~/.claude/settings.json and ~/.codex/hooks.json, through a shell, which
// is the only thing that proves the quoting we ship survives contact with Windows.

describe("the hook command string an agent actually executes", () => {
  test("Claude and Codex are handed the same Windows command, and it names the cap script", () => {
    const dir = "/anything/control";
    const claude = controlHookCommand(join(dir, "check-cap.mjs"), "win32");
    const codex = codexControlHookCommand(
      join(dir, "codex-cap-hook.sh"),
      "win32",
    );
    expect(claude).toContain(WINDOWS_CAP_SCRIPT_FILENAME);
    // Codex's command is derived from where the Unix wrapper would have gone, so it
    // lands on the same script rather than on a wrapper Windows never installs.
    expect(codex).toBe(claude);
    expect(codex).not.toContain("codex-cap-hook.sh");
    expect(codex).not.toContain("/bin/sh");
  });

  test.runIf(onWindows)(
    "over cap, run through the Windows shell -> exit 2 with the reason",
    async () => {
      const dir = setupWindowsControlDir({ spentUsd: 250, amountUsd: 200 });
      const command = controlHookCommand(capScript(dir), "win32");
      let code = 0;
      let stderr = "";
      let stdout = "";
      try {
        const done = await execAsync(command);
        stdout = done.stdout;
        stderr = done.stderr;
      } catch (error) {
        const failed = error as {
          code: number;
          stdout: string;
          stderr: string;
        };
        code = failed.code;
        stdout = failed.stdout;
        stderr = failed.stderr;
      }
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain("Code Cost Control:");
      rmSync(dir, { recursive: true, force: true });
    },
  );

  test.runIf(onWindows)(
    "under cap, run through the Windows shell -> exit 0",
    async () => {
      const dir = setupWindowsControlDir({ spentUsd: 10, amountUsd: 200 });
      const command = controlHookCommand(capScript(dir), "win32");
      const done = await execAsync(command);
      expect(done.stdout).toBe("");
      rmSync(dir, { recursive: true, force: true });
    },
  );

  test.runIf(onWindows)(
    "a space in the path still blocks - quoting survives the shell",
    () => {
      // "C:\Users\Jordan Lee\..." is an ordinary Windows home, and an unquoted
      // command would split it and silently stop enforcing.
      const parent = tmp("ccc wincap spaced ");
      const dir = join(parent, "control dir");
      mkdirSync(dir, { recursive: true });
      setupWindowsControlDir({ spentUsd: 250, amountUsd: 200 }, dir);
      const command = controlHookCommand(capScript(dir), "win32");
      const res = spawnSync(command, {
        shell: true,
        input: PRE_TOOL_USE_EVENT,
        encoding: "utf8",
      });
      expect(res.status).toBe(2);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("Code Cost Control:");
      rmSync(parent, { recursive: true, force: true });
    },
  );
});
