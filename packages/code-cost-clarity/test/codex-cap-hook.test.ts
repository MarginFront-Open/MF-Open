// codex-cap-hook.test.ts: the Codex arm of the cap check.
//
// WHAT THIS FILE PROVES, and why none of it is trivially green:
//
//   THE TRAP. `python3 <a file that isn't there>`
//   exits 2, and Codex reads exit 2 as "stop this tool call". So a hook command that
//   ran python3 directly would turn an uninstalled (or unreadable) cap script into a
//   machine where EVERY tool call is stopped, forever, with no message. Every case
//   below runs the wrapper for REAL against a REAL broken file - renamed, chmod 000,
//   crashing, a directory, no interpreter on PATH - and demands exit 0.
//
//   THE POISON FIELDS. Codex rejects Claude Code's JSON reply format. If any of it
//   reached Codex the run would be marked failed and the tool call would go ahead
//   anyway. So the wrapper's own stdout must be empty on every path. There is a
//   negative control below that proves that assertion can actually fail.
//
//   THE ONE LEGITIMATE STOP. Over cap, enforce mode, all-providers, fresh state:
//   exit 2, nothing on stdout, and the deny message Codex relays.
//
// Everything runs in temp dirs. Nothing here touches a real ~/.codex or ~/.claude.
//
// POSIX ONLY, and not as a dodge. Neither check-cap.py nor codex-cap-hook.sh is
// written to a Windows machine - it gets check-cap.mjs run through node instead,
// because `python3` there is normally the Microsoft Store stub that exits without
// running anything. The same contract is proved for that artifact, branch for
// branch, in windows-cap-hook.test.ts - and most of that file runs on THIS platform
// too, so a break in the shared decision logic surfaces on both lanes.

import { test, expect, describe } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  renameSync,
  chmodSync,
  mkdirSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeControlScript,
  writeCodexCapHookWrapper,
  codexControlHookCommand,
  CODEX_CAP_HOOK_WRAPPER,
  CAP_CHECK_SCRIPT,
} from "../src/control";

// A representative PreToolUse event, the shape Codex writes to the hook's stdin.
const PRE_TOOL_USE_EVENT = JSON.stringify({
  session_id: "019faa02-0638-7233-bf4a-aba7639aff68",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "printf 'ok\\n' > sentinel.txt" },
  cwd: "/tmp/workspace",
});

const onPosix = process.platform !== "win32";

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ccc-codexhook-"));
}

// Build a control dir holding the wrapper + the cap script + state files.
function setupCodexControlDir(opts: {
  spentUsd?: number | null;
  amountUsd?: number;
  mode?: string;
  providerScope?: string;
  spentAgeSeconds?: number;
  writePolicy?: boolean;
  writeSpent?: boolean;
  corruptPolicy?: boolean;
  whyNote?: string;
}): string {
  const dir = tmp();
  writeControlScript(join(dir, "check-cap.py"));
  writeCodexCapHookWrapper(join(dir, "codex-cap-hook.sh"));
  if (opts.writePolicy !== false) {
    const policy = {
      caps: [
        {
          id: "cap-1",
          scope: "org",
          providerScope: opts.providerScope ?? "all",
          mode: opts.mode ?? "enforce",
          amountUsd: opts.amountUsd ?? 200,
          period: "week",
          coolOffHours: null,
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
          week: {
            windowEndEpoch: FAR_FUTURE,
            org: { spentUsd: opts.spentUsd ?? 0 },
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

// Run the wrapper the way Codex runs it: a shell command line, our event on stdin.
function runWrapper(dir: string, env: Record<string, string> = {}): RunResult {
  const res = spawnSync(
    "/bin/sh",
    ["-c", codexControlHookCommand(join(dir, "codex-cap-hook.sh"))],
    {
      input: PRE_TOOL_USE_EVENT,
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

// Run the cap script directly in Codex mode (what the wrapper sees).
function runCore(dir: string): RunResult {
  const res = spawnSync(
    "python3",
    [join(dir, "check-cap.py"), "--surface", "codex"],
    { input: PRE_TOOL_USE_EVENT, encoding: "utf8" },
  );
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

// Overwrite the cap script with a stand-in that behaves however a test needs.
function replaceCore(dir: string, python: string): void {
  writeFileSync(join(dir, "check-cap.py"), python);
}

// ---------------------------------------------------------------------------
// the cap script in --surface codex mode
// ---------------------------------------------------------------------------

describe.runIf(onPosix)("check-cap.py --surface codex", () => {
  test("over cap, enforce, all providers, fresh -> exit 2 with the marker then the message", () => {
    const dir = setupCodexControlDir({ spentUsd: 250, amountUsd: 200 });
    const { code, stdout, stderr } = runCore(dir);
    expect(code).toBe(2);
    expect(stderr).toBe("");
    const [marker, ...rest] = stdout.split("\n");
    expect(marker).toBe("MF_CCC_CODEX_STOP_V1");
    // The wording Codex relays on a deny.
    const message = rest.join("\n");
    expect(message).toContain(
      "Code Cost Control: your team's week spend cap of $200 is reached (about $250 spent so far).",
    );
    expect(message).toContain("contact your admin to raise or reset it");
    expect(message).toContain("not the AI declining");
  });

  test("under cap -> exit 0, nothing on stdout, nothing on stderr", () => {
    const dir = setupCodexControlDir({ spentUsd: 10, amountUsd: 200 });
    expect(runCore(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("stale spend -> exit 0 even though it is over cap", () => {
    const dir = setupCodexControlDir({
      spentUsd: 999,
      amountUsd: 200,
      spentAgeSeconds: 7200,
    });
    expect(runCore(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("missing policy -> exit 0", () => {
    const dir = setupCodexControlDir({ spentUsd: 999, writePolicy: false });
    expect(runCore(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("corrupt policy -> exit 0", () => {
    const dir = setupCodexControlDir({ spentUsd: 999, corruptPolicy: true });
    expect(runCore(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("missing spend file -> exit 0", () => {
    const dir = setupCodexControlDir({ amountUsd: 200, writeSpent: false });
    expect(runCore(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("track mode over cap -> exit 0", () => {
    const dir = setupCodexControlDir({
      spentUsd: 999,
      amountUsd: 200,
      mode: "track",
    });
    expect(runCore(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("provider-scoped cap over its limit -> exit 0", () => {
    const dir = setupCodexControlDir({
      spentUsd: 999,
      amountUsd: 200,
      providerScope: "openai",
    });
    expect(runCore(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("honest null spend -> exit 0 (never a coerced zero)", () => {
    const dir = setupCodexControlDir({ spentUsd: null, amountUsd: 200 });
    expect(runCore(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("the claude surface is unchanged: message on stderr, nothing on stdout", () => {
    const dir = setupCodexControlDir({ spentUsd: 250, amountUsd: 200 });
    const res = spawnSync("python3", [join(dir, "check-cap.py")], {
      encoding: "utf8",
    });
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Code Cost Control:");
    expect(res.stderr).not.toContain("MF_CCC_CODEX_STOP_V1");
  });
});

// ---------------------------------------------------------------------------
// THE WRAPPER FAILURE MATRIX - every one of these must exit 0
// ---------------------------------------------------------------------------

describe.runIf(onPosix)(
  "codex-cap-hook.sh: only a real over-cap decision exits 2",
  () => {
    test("healthy, under cap -> exit 0, empty stdout, empty stderr", () => {
      const dir = setupCodexControlDir({ spentUsd: 10, amountUsd: 200 });
      expect(runWrapper(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
    });

    test("healthy, over cap -> exit 2, EMPTY stdout, message on stderr", () => {
      const dir = setupCodexControlDir({ spentUsd: 250, amountUsd: 200 });
      const { code, stdout, stderr } = runWrapper(dir);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toBe(
        "Code Cost Control: your team's week spend cap of $200 is reached (about $250 spent so far).\n" +
          "Your team's admin set this cap; to keep going, contact your admin to raise or reset it.\n" +
          "This is your team's spend cap, not the AI declining - the model itself did not refuse this.\n",
      );
      // The marker is our own plumbing and must never reach Codex.
      expect(stderr).not.toContain("MF_CCC_CODEX_STOP_V1");
    });

    test("an admin why-note survives the trip through the wrapper", () => {
      const dir = setupCodexControlDir({
        spentUsd: 250,
        amountUsd: 200,
        whyNote: "Q3 budget - ask me",
      });
      const { code, stderr } = runWrapper(dir);
      expect(code).toBe(2);
      expect(stderr).toContain("Note from your admin: Q3 budget - ask me");
      // Multi-line messages must not lose their tail when the wrapper splits on the
      // first newline.
      expect(stderr).toContain("not the AI declining");
    });

    test("THE TRAP: cap script renamed away, over cap -> exit 0", () => {
      const dir = setupCodexControlDir({ spentUsd: 250, amountUsd: 200 });
      renameSync(join(dir, "check-cap.py"), join(dir, "check-cap.py.gone"));
      // Proof the trap is real: python3 against the missing file exits 2 by itself.
      const bare = spawnSync("python3", [join(dir, "check-cap.py")], {
        encoding: "utf8",
      });
      expect(bare.status).toBe(2);
      // The wrapper absorbs it.
      expect(runWrapper(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
    });

    test("THE TRAP: cap script unreadable (chmod 000), over cap -> exit 0", () => {
      const dir = setupCodexControlDir({ spentUsd: 250, amountUsd: 200 });
      chmodSync(join(dir, "check-cap.py"), 0o000);
      const bare = spawnSync("python3", [join(dir, "check-cap.py")], {
        encoding: "utf8",
      });
      expect(bare.status).toBe(2);
      expect(runWrapper(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
      chmodSync(join(dir, "check-cap.py"), 0o644);
    });

    test("cap script is a directory -> exit 0", () => {
      const dir = setupCodexControlDir({ spentUsd: 250, amountUsd: 200 });
      rmSync(join(dir, "check-cap.py"));
      mkdirSync(join(dir, "check-cap.py"));
      expect(runWrapper(dir).code).toBe(0);
    });

    test("cap script has a syntax error -> exit 0", () => {
      const dir = setupCodexControlDir({ spentUsd: 250, amountUsd: 200 });
      replaceCore(dir, "def broken(:\n");
      expect(runWrapper(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
    });

    test("cap script raises an uncaught exception -> exit 0", () => {
      const dir = setupCodexControlDir({ spentUsd: 250, amountUsd: 200 });
      replaceCore(dir, "raise RuntimeError('boom')\n");
      expect(runWrapper(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
    });

    test("cap script exits 127 -> exit 0", () => {
      const dir = setupCodexControlDir({ spentUsd: 250, amountUsd: 200 });
      replaceCore(dir, "import sys\nsys.exit(127)\n");
      expect(runWrapper(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
    });

    test("a rogue exit 2 with NO marker -> exit 0", () => {
      const dir = setupCodexControlDir({ spentUsd: 10, amountUsd: 200 });
      replaceCore(
        dir,
        "import sys\nsys.stdout.write('stop everything\\nreason\\n')\nsys.exit(2)\n",
      );
      expect(runWrapper(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
    });

    test("a rogue exit 2 with the WRONG marker -> exit 0", () => {
      const dir = setupCodexControlDir({ spentUsd: 10, amountUsd: 200 });
      replaceCore(
        dir,
        "import sys\nsys.stdout.write('MF_CCC_CODEX_STOP_V0\\nreason\\n')\nsys.exit(2)\n",
      );
      expect(runWrapper(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
    });

    test("the right marker but NO message after it -> exit 0", () => {
      const dir = setupCodexControlDir({ spentUsd: 10, amountUsd: 200 });
      replaceCore(
        dir,
        "import sys\nsys.stdout.write('MF_CCC_CODEX_STOP_V1')\nsys.exit(2)\n",
      );
      expect(runWrapper(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
    });

    test("no python3 on PATH, over cap -> exit 0", () => {
      const dir = setupCodexControlDir({ spentUsd: 250, amountUsd: 200 });
      const emptyPath = mkdtempSync(join(tmpdir(), "ccc-nopath-"));
      const { code, stdout } = runWrapper(dir, { PATH: emptyPath });
      expect(code).toBe(0);
      expect(stdout).toBe("");
    });

    test("state directory emptied out, over cap in a stale copy -> exit 0", () => {
      const dir = setupCodexControlDir({ spentUsd: 250, amountUsd: 200 });
      rmSync(join(dir, "policy.json"));
      rmSync(join(dir, "spent.json"));
      expect(runWrapper(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
    });

    test("the wrapper is valid shell (a syntax error in it would exit 2 and stop everything)", () => {
      const dir = tmp();
      const wrapperPath = join(dir, "codex-cap-hook.sh");
      writeCodexCapHookWrapper(wrapperPath);
      const res = spawnSync("/bin/sh", ["-n", wrapperPath], {
        encoding: "utf8",
      });
      expect(res.status).toBe(0);
      expect(res.stderr).toBe("");
    });

    test("the wrapper finds its cap script by its own path, not the caller's cwd", () => {
      const dir = setupCodexControlDir({ spentUsd: 250, amountUsd: 200 });
      const elsewhere = mkdtempSync(join(tmpdir(), "ccc-elsewhere-"));
      const res = spawnSync(
        "/bin/sh",
        ["-c", codexControlHookCommand(join(dir, "codex-cap-hook.sh"))],
        { input: PRE_TOOL_USE_EVENT, encoding: "utf8", cwd: elsewhere },
      );
      expect(res.status).toBe(2);
      expect(res.stdout).toBe("");
    });
  },
);

// ---------------------------------------------------------------------------
// POISON FIELDS - Claude Code's reply format must never reach Codex
// ---------------------------------------------------------------------------

// Codex names these fields in its own "unsupported" errors. Emitting any of them
// makes Codex mark the hook run failed and run the tool call anyway.
const POISON_FIELDS = [
  "continue",
  "stopReason",
  "suppressOutput",
  "permissionDecision",
  "permissionDecisionReason",
  "hookSpecificOutput",
];

function expectNoPoisonFields(text: string): void {
  for (const field of POISON_FIELDS) {
    if (text.includes(`"${field}"`)) {
      throw new Error(`poison field "${field}" reached Codex: ${text}`);
    }
  }
}

describe.runIf(onPosix)("poison fields never reach Codex", () => {
  test("NEGATIVE CONTROL: the guard itself catches a Claude-style reply", () => {
    // If this ever stops throwing, every assertion below is worthless.
    expect(() =>
      expectNoPoisonFields(
        '{"continue": false, "stopReason": "over cap", "suppressOutput": true}',
      ),
    ).toThrow(/poison field "continue"/);
    expect(() => expectNoPoisonFields("")).not.toThrow();
  });

  test("a cap script that emits a Claude-style reply gets swallowed by the wrapper", () => {
    const dir = setupCodexControlDir({ spentUsd: 250, amountUsd: 200 });
    const claudeStyleReply = JSON.stringify({
      continue: false,
      stopReason: "Code Cost Control: cap reached",
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "cap reached",
      },
    });
    replaceCore(
      dir,
      `import sys\nsys.stdout.write(${JSON.stringify(claudeStyleReply)})\nsys.exit(2)\n`,
    );

    // The fixture really does emit the poison - otherwise this test proves nothing.
    const direct = spawnSync("python3", [join(dir, "check-cap.py")], {
      encoding: "utf8",
    });
    expect(() => expectNoPoisonFields(direct.stdout)).toThrow();

    // Through the wrapper: nothing on stdout, and the bogus exit 2 is downgraded.
    const { code, stdout, stderr } = runWrapper(dir);
    expect(stdout).toBe("");
    expectNoPoisonFields(stdout);
    expectNoPoisonFields(stderr);
    expect(code).toBe(0);
  });

  test("the real over-cap stop carries no poison fields on either stream", () => {
    const dir = setupCodexControlDir({ spentUsd: 250, amountUsd: 200 });
    const { code, stdout, stderr } = runWrapper(dir);
    expect(code).toBe(2);
    expectNoPoisonFields(stdout);
    expectNoPoisonFields(stderr);
  });

  test("neither shipped file mentions a Claude-style reply field", () => {
    expectNoPoisonFields(CODEX_CAP_HOOK_WRAPPER);
    expectNoPoisonFields(CAP_CHECK_SCRIPT);
  });
});

// ---------------------------------------------------------------------------
// shipped-bytes invariants
// ---------------------------------------------------------------------------

describe.runIf(onPosix)("shipped wrapper invariants", () => {
  test("nothing is templated into the wrapper (a stray quote in a path would be a syntax error)", () => {
    const dir = tmp();
    const a = join(dir, "a", "codex-cap-hook.sh");
    const b = join(dir, "b", "codex-cap-hook.sh");
    writeCodexCapHookWrapper(a);
    writeCodexCapHookWrapper(b);
    expect(readFileSync(a, "utf8")).toBe(readFileSync(b, "utf8"));
    expect(readFileSync(a, "utf8")).toBe(CODEX_CAP_HOOK_WRAPPER);
    expect(CODEX_CAP_HOOK_WRAPPER).not.toContain(tmpdir());
  });

  test("the wrapper runs /bin/sh, never python3 directly", () => {
    expect(CODEX_CAP_HOOK_WRAPPER.startsWith("#!/bin/sh")).toBe(true);
    expect(codexControlHookCommand("/x/codex-cap-hook.sh")).toBe(
      '/bin/sh "/x/codex-cap-hook.sh"',
    );
    expect(codexControlHookCommand("/x/codex-cap-hook.sh")).not.toContain(
      "python3",
    );
  });

  test("the wrapper has exactly one `exit 2` statement, and it sits behind the marker check", () => {
    const codeLines = CODEX_CAP_HOOK_WRAPPER.split("\n").filter(
      (line) => !line.trimStart().startsWith("#"),
    );
    const exitTwoLines = codeLines.filter(
      (line) => line.trim() === "exit 2",
    ).length;
    expect(exitTwoLines).toBe(1);
    const markerCheck = codeLines.findIndex((line) =>
      line.includes('"$MF_CCC_STOP_MARKER"'),
    );
    const exitTwo = codeLines.findIndex((line) => line.trim() === "exit 2");
    expect(markerCheck).toBeGreaterThan(-1);
    expect(exitTwo).toBeGreaterThan(markerCheck);
  });

  test("the wrapper is installed executable", () => {
    const dir = tmp();
    const wrapperPath = join(dir, "codex-cap-hook.sh");
    writeCodexCapHookWrapper(wrapperPath);
    const res = spawnSync(wrapperPath, [], {
      input: PRE_TOOL_USE_EVENT,
      encoding: "utf8",
    });
    // No cap script beside it -> the "we can't read the core" branch -> allow.
    expect(res.status).toBe(0);
  });
});
