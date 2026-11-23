// codex-hooks-json.test.ts: wiring the cap check into Codex.
//
// WHAT THIS FILE PROVES:
//
//   THE WRITE. hooks.json gets exactly one entry, in the strict-minimal shape Codex
//   accepts, and nothing the developer already wrote is disturbed. Running init twice
//   leaves one entry, not two. The command string is pinned, because Codex hashes the
//   hook entry to remember that the developer trusted it - one changed byte silently
//   un-trusts the hook and it stops running with no warning.
//
//   THE UNDO. Only our entry leaves. Their hooks come back byte-identical. The file
//   itself goes only when our entry was the only thing in it.
//
//   THE SELF-HEAL. If a future Codex release stops understanding the hooks file,
//   Codex refuses the WHOLE file - including their hooks - and says so in a warning.
//   We pull ours out so theirs work again.
//
//   THE REAL CLI. When Codex is installed, one test writes our file into a THROWAWAY
//   CODEX_HOME and asks the real app-server what it registered. That is the only way
//   to know the schema is right; a hand-written expectation would just be a guess.
//
// Every path here is a temp path. Nothing touches the real ~/.codex.

import { test, expect, describe } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  writeCodexControlHook,
  removeCodexControlHook,
  writeCodexCapHookWrapper,
  healCodexControlState,
  isCodexInstalled,
  isCodexControlArmed,
  codexControlHookCommand,
  CODEX_HOOK_TIMEOUT_SECONDS,
  CODEX_HOOK_STATUS_MESSAGE,
} from "../src/control";
import { codexHooksList, codexDoctorConfigLoad } from "../src/codex-app-server";
import { cmdInit, cmdUninstall, type InitDeps } from "../src/cli";

const QUIET = { log: () => {} };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ccc-codexhooks-"));
}

interface Seat {
  dir: string;
  hooksPath: string;
  ownershipPath: string;
  wrapperPath: string;
}

// A throwaway seat: a fake ~/.codex, a fake receipt path, a real wrapper on disk.
function seat(): Seat {
  const dir = tmp();
  const codexDir = join(dir, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const wrapperPath = join(dir, "control", "codex-cap-hook.sh");
  // The writer makes this directory on POSIX as a side effect of writing the
  // wrapper into it. On Windows there IS no wrapper, so the seat has to make it.
  mkdirSync(dirname(wrapperPath), { recursive: true });
  writeCodexCapHookWrapper(wrapperPath);
  return {
    dir,
    hooksPath: join(codexDir, "hooks.json"),
    ownershipPath: join(dir, "codex-control-hook-owned.json"),
    wrapperPath,
  };
}

function install(s: Seat) {
  return writeCodexControlHook({
    hooksPath: s.hooksPath,
    ownershipPath: s.ownershipPath,
    wrapperPath: s.wrapperPath,
    ...QUIET,
  });
}

function uninstall(s: Seat) {
  return removeCodexControlHook({
    hooksPath: s.hooksPath,
    ownershipPath: s.ownershipPath,
    wrapperPath: s.wrapperPath,
    ...QUIET,
  });
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

// A hook the developer wrote themselves. Uninstall must give this back untouched.
const THEIR_HOOK = {
  matcher: "Bash",
  hooks: [{ type: "command", command: "/usr/local/bin/my-audit-log" }],
};

// ---------------------------------------------------------------------------
// the write
// ---------------------------------------------------------------------------

describe("writeCodexControlHook", () => {
  test("writes exactly the strict-minimal entry Codex accepts, and nothing else", () => {
    const s = seat();
    expect(install(s).action).toBe("added");
    expect(readJson(s.hooksPath)).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: codexControlHookCommand(s.wrapperPath),
                timeout: CODEX_HOOK_TIMEOUT_SECONDS,
                statusMessage: CODEX_HOOK_STATUS_MESSAGE,
              },
            ],
          },
        ],
      },
    });
  });

  test("no stray fields sneak in (older Codex builds refuse a file with fields they don't know)", () => {
    const s = seat();
    install(s);
    const root = readJson(s.hooksPath);
    expect(Object.keys(root)).toEqual(["hooks"]);
    const groups = (root.hooks as Record<string, unknown>).PreToolUse as Record<
      string,
      unknown
    >[];
    expect(Object.keys(groups[0]).sort()).toEqual(["hooks", "matcher"]);
    const handler = (groups[0].hooks as Record<string, unknown>[])[0];
    expect(Object.keys(handler).sort()).toEqual([
      "command",
      "statusMessage",
      "timeout",
      "type",
    ]);
    expect(JSON.stringify(root)).not.toContain("description");
  });

  test("running init twice leaves exactly ONE entry", () => {
    const s = seat();
    install(s);
    const afterFirst = readFileSync(s.hooksPath, "utf8");
    expect(install(s).action).toBe("already-present");
    expect(readFileSync(s.hooksPath, "utf8")).toBe(afterFirst);
    const groups = (readJson(s.hooksPath).hooks as Record<string, unknown>)
      .PreToolUse as unknown[];
    expect(groups.length).toBe(1);
  });

  test("merges into a hooks file the developer already had, keeping their hook intact", () => {
    const s = seat();
    writeFileSync(
      s.hooksPath,
      JSON.stringify({ hooks: { PreToolUse: [THEIR_HOOK] } }, null, 2) + "\n",
    );
    expect(install(s).action).toBe("added");
    const groups = (readJson(s.hooksPath).hooks as Record<string, unknown>)
      .PreToolUse as unknown[];
    expect(groups.length).toBe(2);
    expect(groups[0]).toEqual(THEIR_HOOK);
  });

  test("keeps hook events we know nothing about", () => {
    const s = seat();
    writeFileSync(
      s.hooksPath,
      JSON.stringify({
        description: "my hooks",
        hooks: { SessionStart: [THEIR_HOOK], PostToolUse: [THEIR_HOOK] },
      }) + "\n",
    );
    install(s);
    const root = readJson(s.hooksPath);
    expect(root.description).toBe("my hooks");
    const hooks = root.hooks as Record<string, unknown>;
    expect(hooks.SessionStart).toEqual([THEIR_HOOK]);
    expect(hooks.PostToolUse).toEqual([THEIR_HOOK]);
    expect(Array.isArray(hooks.PreToolUse)).toBe(true);
  });

  test("backs up the file before it changes it", () => {
    const s = seat();
    const before = JSON.stringify({ hooks: { PreToolUse: [THEIR_HOOK] } });
    writeFileSync(s.hooksPath, before);
    const result = install(s);
    expect(result.backupPath).toBe(`${s.hooksPath}.ccc-bak`);
    expect(readFileSync(result.backupPath as string, "utf8")).toBe(before);
  });

  test("Codex absent is a normal skip, not an error, and writes no file", () => {
    const dir = tmp();
    const s: Seat = {
      dir,
      hooksPath: join(dir, "nowhere", ".codex", "hooks.json"),
      ownershipPath: join(dir, "owned.json"),
      wrapperPath: join(dir, "codex-cap-hook.sh"),
    };
    const lines: string[] = [];
    const result = writeCodexControlHook({
      hooksPath: s.hooksPath,
      ownershipPath: s.ownershipPath,
      wrapperPath: s.wrapperPath,
      codexInstalled: false,
      log: (m) => lines.push(m),
    });
    expect(result.action).toBe("skipped-no-codex");
    expect(existsSync(s.hooksPath)).toBe(false);
    expect(existsSync(s.ownershipPath)).toBe(false);
    expect(lines.join(" ")).toContain("Codex isn't on this machine");
  });

  test("a hooks file that isn't valid JSON is left byte-identical, with the fix spelled out", () => {
    const s = seat();
    const broken = '{ "hooks": { "PreToolUse": [ ,,, ] } }';
    writeFileSync(s.hooksPath, broken);
    const lines: string[] = [];
    const result = writeCodexControlHook({
      hooksPath: s.hooksPath,
      ownershipPath: s.ownershipPath,
      wrapperPath: s.wrapperPath,
      log: (m) => lines.push(m),
    });
    expect(result.action).toBe("skipped-existing-file");
    expect(readFileSync(s.hooksPath, "utf8")).toBe(broken);
    expect(lines.join(" ")).toContain("isn't valid JSON");
    expect(existsSync(s.ownershipPath)).toBe(false);
  });

  test("a hooks file with the wrong shape is left byte-identical", () => {
    for (const bad of [
      '["not", "an", "object"]',
      '{ "hooks": "nope" }',
      '{ "hooks": { "PreToolUse": "nope" } }',
    ]) {
      const s = seat();
      writeFileSync(s.hooksPath, bad);
      const result = writeCodexControlHook({
        hooksPath: s.hooksPath,
        ownershipPath: s.ownershipPath,
        wrapperPath: s.wrapperPath,
        ...QUIET,
      });
      expect(result.action).toBe("skipped-existing-file");
      expect(readFileSync(s.hooksPath, "utf8")).toBe(bad);
    }
  });

  test("the receipt records the exact command we wrote", () => {
    const s = seat();
    install(s);
    expect(isCodexControlArmed(s.ownershipPath)).toBe(true);
    expect(readJson(s.ownershipPath).command).toBe(
      codexControlHookCommand(s.wrapperPath),
    );
  });
});

// ---------------------------------------------------------------------------
// THE FROZEN HOOK ENTRY (the trust contract)
// ---------------------------------------------------------------------------

describe("the hook command string is frozen", () => {
  // THE WHOLE ENTRY IS THE CONTRACT, not only the command. Checked against
  // codex-cli 0.145.0 in a throwaway CODEX_HOME: changing only timeout 10 -> 11 moved
  // currentHash (sha256:7951a8ed... -> sha256:a6d1f82a...), and changing only
  // statusMessage moved it again (-> sha256:2e4cd117...). A moved hash un-trusts the
  // hook on every machine that already armed it, silently.
  //
  // So this test spells all five hashed fields as LITERALS. Comparing them against the
  // constants the writer uses would move with the constants and prove nothing. If this
  // fails, someone changed a hashed field: either put it back, or change it on purpose
  // and ship a release note telling people to run /hooks again.
  test("the whole written entry is pinned, field for field, in literals", () => {
    const s = seat();
    install(s);
    const groups = (readJson(s.hooksPath).hooks as Record<string, unknown>)
      .PreToolUse as Record<string, unknown>[];
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({
      matcher: "*",
      hooks: [
        {
          type: "command",
          command:
            process.platform === "win32"
              ? `node "${join(dirname(s.wrapperPath), "check-cap.mjs")}"`
              : `/bin/sh "${s.wrapperPath}"`,
          timeout: 10,
          statusMessage: "Checking your MarginFront spend cap",
        },
      ],
    });
  });

  // The same two values, pinned at the source. The test above writes a file; this one
  // catches an edit to the constant even if the writer stopped using it.
  test("the hashed constants themselves are pinned", () => {
    expect(CODEX_HOOK_TIMEOUT_SECONDS).toBe(10);
    expect(CODEX_HOOK_STATUS_MESSAGE).toBe(
      "Checking your MarginFront spend cap",
    );
  });

  // EVERY platform's command, spelled out, on EVERY lane. The Windows entry
  // is a separate frozen string, and the danger of adding one is
  // nudging the Unix string while doing it - which would silently un-trust the hook
  // on every Mac that already armed it. Passing the platform explicitly means the
  // macOS bytes are pinned by the macOS run AND the Windows run, so that nudge
  // cannot hide on the lane nobody is looking at.
  test("the command is pinned per platform, and the Unix one has not moved", () => {
    const unixWrapper = "/Users/dev/.marginfront-ccc/control/codex-cap-hook.sh";
    expect(codexControlHookCommand(unixWrapper, "darwin")).toBe(
      '/bin/sh "/Users/dev/.marginfront-ccc/control/codex-cap-hook.sh"',
    );
    expect(codexControlHookCommand(unixWrapper, "linux")).toBe(
      '/bin/sh "/Users/dev/.marginfront-ccc/control/codex-cap-hook.sh"',
    );
    expect(
      codexControlHookCommand(
        "C:\\Users\\dev\\.marginfront-ccc\\control\\codex-cap-hook.sh",
        "win32",
      ),
    ).toBe('node "C:\\Users\\dev\\.marginfront-ccc\\control\\check-cap.mjs"');
  });

  // Windows runs the cap script directly, so its command must not name a wrapper
  // that is never written - a hook pointed at a missing file is a cap that is armed
  // on paper and absent in practice.
  test("the Windows command names the cap script, never the shell wrapper", () => {
    const command = codexControlHookCommand(
      "C:\\ccc\\control\\codex-cap-hook.sh",
      "win32",
    );
    expect(command).not.toContain("codex-cap-hook.sh");
    expect(command).not.toContain("/bin/sh");
    expect(command).toContain("check-cap.mjs");
  });

  test("it carries no version, date, or anything else that changes between releases", () => {
    const command = codexControlHookCommand("/x/codex-cap-hook.sh");
    expect(command).not.toMatch(/\d+\.\d+\.\d+/);
    expect(command).not.toMatch(/20\d\d/);
    expect(codexControlHookCommand("/x/codex-cap-hook.sh")).toBe(command);
  });

  test("shipping a new wrapper BODY does not change the command string", () => {
    const s = seat();
    install(s);
    const command = (
      (
        (readJson(s.hooksPath).hooks as Record<string, unknown>)
          .PreToolUse as Record<string, unknown>[]
      )[0].hooks as Record<string, unknown>[]
    )[0].command;
    writeFileSync(
      s.wrapperPath,
      "#!/bin/sh\n# a totally different wrapper\nexit 0\n",
    );
    expect(install(s).action).toBe("already-present");
    expect(command).toBe(codexControlHookCommand(s.wrapperPath));
  });
});

// ---------------------------------------------------------------------------
// the undo
// ---------------------------------------------------------------------------

describe("removeCodexControlHook", () => {
  test("our entry was the only thing in the file -> the file goes too", () => {
    const s = seat();
    install(s);
    const result = uninstall(s);
    expect(result.action).toBe("deleted-file");
    expect(existsSync(s.hooksPath)).toBe(false);
    expect(existsSync(s.wrapperPath)).toBe(false);
    expect(existsSync(s.ownershipPath)).toBe(false);
  });

  test("their hooks come back BYTE-IDENTICAL and the file stays", () => {
    const s = seat();
    const theirs =
      JSON.stringify({ hooks: { PreToolUse: [THEIR_HOOK] } }, null, 2) + "\n";
    writeFileSync(s.hooksPath, theirs);
    install(s);
    expect(readFileSync(s.hooksPath, "utf8")).not.toBe(theirs);
    expect(uninstall(s).action).toBe("removed");
    expect(readFileSync(s.hooksPath, "utf8")).toBe(theirs);
  });

  test("a hook of theirs in a DIFFERENT event survives", () => {
    const s = seat();
    writeFileSync(
      s.hooksPath,
      JSON.stringify({ hooks: { SessionStart: [THEIR_HOOK] } }, null, 2) + "\n",
    );
    install(s);
    uninstall(s);
    const hooks = readJson(s.hooksPath).hooks as Record<string, unknown>;
    expect(hooks.SessionStart).toEqual([THEIR_HOOK]);
    expect("PreToolUse" in hooks).toBe(false);
  });

  test("removes ONLY the entry whose command matches ours", () => {
    const s = seat();
    const lookalike = {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: '/bin/sh "/somewhere/else/codex-cap-hook.sh"',
        },
      ],
    };
    writeFileSync(
      s.hooksPath,
      JSON.stringify({ hooks: { PreToolUse: [lookalike] } }, null, 2) + "\n",
    );
    install(s);
    uninstall(s);
    const groups = (readJson(s.hooksPath).hooks as Record<string, unknown>)
      .PreToolUse as unknown[];
    expect(groups).toEqual([lookalike]);
  });

  test("no hooks file at all -> soft no-op that still clears our own artifacts", () => {
    const s = seat();
    writeFileSync(s.ownershipPath, JSON.stringify({ command: "x" }));
    expect(uninstall(s).action).toBe("not-found");
    expect(existsSync(s.wrapperPath)).toBe(false);
    expect(existsSync(s.ownershipPath)).toBe(false);
  });

  test("an unreadable hooks file is left alone rather than rewritten", () => {
    const s = seat();
    const broken = "{ not json at all";
    writeFileSync(s.hooksPath, broken);
    const lines: string[] = [];
    const result = removeCodexControlHook({
      hooksPath: s.hooksPath,
      ownershipPath: s.ownershipPath,
      wrapperPath: s.wrapperPath,
      log: (m) => lines.push(m),
    });
    expect(result.action).toBe("not-found");
    expect(readFileSync(s.hooksPath, "utf8")).toBe(broken);
    expect(lines.join(" ")).toContain("isn't valid JSON");
  });

  test("running uninstall twice is safe", () => {
    const s = seat();
    install(s);
    uninstall(s);
    expect(uninstall(s).action).toBe("not-found");
  });

  test("install -> uninstall leaves zero CCC artifacts behind", () => {
    const s = seat();
    install(s);
    uninstall(s);
    expect(existsSync(s.hooksPath)).toBe(false);
    expect(existsSync(s.wrapperPath)).toBe(false);
    expect(existsSync(s.ownershipPath)).toBe(false);
    expect(isCodexControlArmed(s.ownershipPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isCodexInstalled
// ---------------------------------------------------------------------------

describe("isCodexInstalled", () => {
  test("true when ~/.codex exists", () => {
    const s = seat();
    expect(
      isCodexInstalled({ codexDir: join(s.dir, ".codex"), pathEnv: "" }),
    ).toBe(true);
  });

  test("true when the codex binary is on PATH", () => {
    const binDir = tmp();
    writeFileSync(join(binDir, "codex"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    expect(
      isCodexInstalled({ codexDir: join(tmp(), "nope"), pathEnv: binDir }),
    ).toBe(true);
  });

  test("false when neither is there", () => {
    expect(
      isCodexInstalled({ codexDir: join(tmp(), "nope"), pathEnv: tmp() }),
    ).toBe(false);
  });

  // `platform` is injected, so these run everywhere - the Windows arm is proven from
  // macOS too, not only from the windows-latest lane. Splitting a Windows PATH on ":"
  // shreds every entry at its drive letter, so a ":" split could never return true
  // there.
  describe("the Windows PATH arm", () => {
    const noCodexDir = () => join(tmp(), "nope");

    for (const fileName of ["codex.cmd", "codex.exe", "codex"]) {
      test(`finds ${fileName} in a ";"-separated PATH`, () => {
        const other = tmp();
        const binDir = tmp();
        writeFileSync(join(binDir, fileName), "");
        expect(
          isCodexInstalled({
            codexDir: noCodexDir(),
            pathEnv: `${other};${binDir}`,
            platform: "win32",
          }),
        ).toBe(true);
      });
    }

    test("NEGATIVE CONTROL: the same PATH and codex.cmd read as posix finds nothing", () => {
      const other = tmp();
      const binDir = tmp();
      writeFileSync(join(binDir, "codex.cmd"), "");
      expect(
        isCodexInstalled({
          codexDir: noCodexDir(),
          pathEnv: `${other};${binDir}`,
          platform: "darwin",
        }),
      ).toBe(false);
    });

    test("posix still wants a bare codex, not codex.cmd", () => {
      const cmdOnly = tmp();
      writeFileSync(join(cmdOnly, "codex.cmd"), "");
      expect(
        isCodexInstalled({
          codexDir: noCodexDir(),
          pathEnv: cmdOnly,
          platform: "darwin",
        }),
      ).toBe(false);
    });

    // Not runnable on a Windows host: every absolute path there carries a drive
    // colon, so a ":"-joined PATH shreds its own entries and the case cannot exist.
    test.skipIf(process.platform === "win32")(
      'posix still splits PATH on ":"',
      () => {
        const other = tmp();
        const binDir = tmp();
        writeFileSync(join(binDir, "codex"), "");
        expect(
          isCodexInstalled({
            codexDir: noCodexDir(),
            pathEnv: `${other}:${binDir}`,
            platform: "darwin",
          }),
        ).toBe(true);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// the app-server helper (fake child process - no real Codex needed)
// ---------------------------------------------------------------------------

// A stand-in for `codex app-server` that replies with whatever we hand it.
function fakeCodexSpawn(reply: unknown, opts: { silent?: boolean } = {}) {
  return ((): unknown => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        if (opts.silent) continue;
        if (message.id === 1) {
          child.stdout.write(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\n",
          );
        }
        if (message.id === 2) {
          child.stdout.write(JSON.stringify(reply) + "\n");
        }
      }
    });
    return child;
  }) as never;
}

describe("codexHooksList", () => {
  test("reads back hooks, warnings, and config errors", async () => {
    const result = await codexHooksList({
      spawnImpl: fakeCodexSpawn({
        jsonrpc: "2.0",
        id: 2,
        result: {
          data: [
            {
              cwd: "/tmp/x",
              hooks: [
                {
                  key: "/h/hooks.json:pre_tool_use:0:0",
                  eventName: "preToolUse",
                  command: '/bin/sh "/c/codex-cap-hook.sh"',
                  matcher: "*",
                  source: "user",
                  enabled: true,
                  isManaged: false,
                  currentHash: "sha256:abc",
                  trustStatus: "untrusted",
                },
              ],
              warnings: ["failed to parse hooks config /h/hooks.json: boom"],
              errors: [
                { path: "/tmp/x", message: "config.toml:1:6: unclosed table" },
              ],
            },
          ],
        },
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.hooks.length).toBe(1);
    // The point of reading this at all: enabled and trustStatus are independent.
    expect(result.hooks[0].enabled).toBe(true);
    expect(result.hooks[0].trustStatus).toBe("untrusted");
    expect(result.warnings[0]).toContain("failed to parse hooks config");
    expect(result.errors[0]).toContain("unclosed table");
  });

  test("a reply we don't understand is 'unknown', never an empty success", async () => {
    const result = await codexHooksList({
      spawnImpl: fakeCodexSpawn({ jsonrpc: "2.0", id: 2, result: {} }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bad-response");
  });

  test("a Codex that never answers times out instead of hanging", async () => {
    const result = await codexHooksList({
      spawnImpl: fakeCodexSpawn(null, { silent: true }),
      timeoutMs: 60,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  test("no codex binary -> 'codex-missing', not a throw", async () => {
    const result = await codexHooksList({
      codexBin: join(tmp(), "definitely-not-codex"),
      timeoutMs: 3000,
    });
    expect(result.ok).toBe(false);
    expect(["codex-missing", "bad-response"]).toContain(result.reason);
  });
});

describe("codexDoctorConfigLoad", () => {
  function fakeDoctor(stdout: string) {
    return ((
      _bin: string,
      _args: string[],
      _opts: unknown,
      cb: (e: unknown, out: string) => void,
    ) => {
      cb(new Error("doctor exits non-zero whenever any check fails"), stdout);
    }) as never;
  }

  test("config loads fine", async () => {
    const result = await codexDoctorConfigLoad({
      execFileImpl: fakeDoctor(
        JSON.stringify({
          checks: { "config.load": { status: "ok", summary: "config loaded" } },
        }),
      ),
    });
    expect(result).toEqual({ status: "ok", summary: "config loaded" });
  });

  test("config is broken - a non-zero doctor exit is NOT what tells us so", async () => {
    const result = await codexDoctorConfigLoad({
      execFileImpl: fakeDoctor(
        JSON.stringify({
          checks: {
            "config.load": {
              status: "fail",
              summary: "config could not be loaded",
            },
          },
        }),
      ),
    });
    expect(result.status).toBe("failed");
  });

  test("output we can't read is 'unknown'", async () => {
    const result = await codexDoctorConfigLoad({
      execFileImpl: fakeDoctor("not json"),
    });
    expect(result).toEqual({ status: "unknown", summary: null });
  });
});

// ---------------------------------------------------------------------------
// the self-heal
// ---------------------------------------------------------------------------

describe("healCodexControlState", () => {
  const okList = async () => ({
    ok: true,
    hooks: [],
    warnings: [],
    errors: [],
  });
  const okDoctor = async () => ({
    status: "ok" as const,
    summary: "config loaded",
  });

  test("never installed -> nothing to do", async () => {
    const s = seat();
    const result = await healCodexControlState({
      hooksPath: s.hooksPath,
      ownershipPath: s.ownershipPath,
      wrapperPath: s.wrapperPath,
      hooksList: okList as never,
      doctorConfigLoad: okDoctor as never,
    });
    expect(result.action).toBe("not-armed");
  });

  test("we couldn't ask Codex -> 'unknown', and our hook stays put", async () => {
    const s = seat();
    install(s);
    const result = await healCodexControlState({
      hooksPath: s.hooksPath,
      ownershipPath: s.ownershipPath,
      wrapperPath: s.wrapperPath,
      hooksList: (async () => ({
        ok: false,
        reason: "codex-missing",
        hooks: [],
        warnings: [],
        errors: [],
      })) as never,
      doctorConfigLoad: okDoctor as never,
    });
    expect(result.action).toBe("unknown");
    expect(existsSync(s.hooksPath)).toBe(true);
  });

  test("Codex is happy -> our hook stays put", async () => {
    const s = seat();
    install(s);
    const before = readFileSync(s.hooksPath, "utf8");
    const result = await healCodexControlState({
      hooksPath: s.hooksPath,
      ownershipPath: s.ownershipPath,
      wrapperPath: s.wrapperPath,
      hooksList: okList as never,
      doctorConfigLoad: okDoctor as never,
    });
    expect(result.action).toBe("ok");
    expect(readFileSync(s.hooksPath, "utf8")).toBe(before);
  });

  test("Codex rejected the file -> our entry comes out, THEIRS stays", async () => {
    const s = seat();
    const theirs =
      JSON.stringify({ hooks: { PreToolUse: [THEIR_HOOK] } }, null, 2) + "\n";
    writeFileSync(s.hooksPath, theirs);
    install(s);
    const lines: string[] = [];
    const result = await healCodexControlState({
      hooksPath: s.hooksPath,
      ownershipPath: s.ownershipPath,
      wrapperPath: s.wrapperPath,
      hooksList: (async () => ({
        ok: true,
        hooks: [],
        warnings: [
          `failed to parse hooks config ${s.hooksPath}: unknown field \`statusMessage\``,
        ],
        errors: [],
      })) as never,
      doctorConfigLoad: okDoctor as never,
      log: (m) => lines.push(m),
    });
    expect(result.action).toBe("removed-hook");
    expect(readFileSync(s.hooksPath, "utf8")).toBe(theirs);
    expect(lines.join(" ")).toContain(
      "Taking the MarginFront cap check back out",
    );
  });

  test("a warning about SOMEONE ELSE's hooks file changes nothing of ours", async () => {
    const s = seat();
    install(s);
    const before = readFileSync(s.hooksPath, "utf8");
    const result = await healCodexControlState({
      hooksPath: s.hooksPath,
      ownershipPath: s.ownershipPath,
      wrapperPath: s.wrapperPath,
      hooksList: (async () => ({
        ok: true,
        hooks: [],
        warnings: [
          "failed to parse hooks config /some/plugin/hooks.json: boom",
        ],
        errors: [],
      })) as never,
      doctorConfigLoad: okDoctor as never,
    });
    expect(result.action).toBe("ok");
    expect(readFileSync(s.hooksPath, "utf8")).toBe(before);
  });

  test("the file isn't valid JSON -> we leave it alone rather than lose their hooks", async () => {
    const s = seat();
    install(s);
    const broken = '{ "hooks": broken';
    writeFileSync(s.hooksPath, broken);
    const lines: string[] = [];
    const result = await healCodexControlState({
      hooksPath: s.hooksPath,
      ownershipPath: s.ownershipPath,
      wrapperPath: s.wrapperPath,
      hooksList: (async () => ({
        ok: true,
        hooks: [],
        warnings: [
          `failed to parse hooks config ${s.hooksPath}: key must be a string`,
        ],
        errors: [],
      })) as never,
      doctorConfigLoad: okDoctor as never,
      log: (m) => lines.push(m),
    });
    expect(result.action).toBe("left-alone");
    expect(readFileSync(s.hooksPath, "utf8")).toBe(broken);
    expect(lines.join(" ")).toContain("left it alone");
  });

  test("a config.toml Codex can't load is reported in plain English, and nothing is edited", async () => {
    const s = seat();
    install(s);
    const before = readFileSync(s.hooksPath, "utf8");
    const lines: string[] = [];
    const result = await healCodexControlState({
      hooksPath: s.hooksPath,
      ownershipPath: s.ownershipPath,
      wrapperPath: s.wrapperPath,
      hooksList: okList as never,
      doctorConfigLoad: (async () => ({
        status: "failed" as const,
        summary: "config could not be loaded",
      })) as never,
      log: (m) => lines.push(m),
    });
    expect(result.action).toBe("ok");
    expect(readFileSync(s.hooksPath, "utf8")).toBe(before);
    const said = lines.join(" ");
    expect(said).toContain("Codex can't read its own config file");
    expect(said).toContain("uninstall");
  });
});

// ---------------------------------------------------------------------------
// THE REAL CODEX CLI - skipped when Codex isn't on the machine
// ---------------------------------------------------------------------------

const codexOnPath =
  spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;

describe("against the real Codex CLI", () => {
  test.skipIf(!codexOnPath)(
    "the file we write registers as a user hook, enabled, and NOT yet trusted",
    async () => {
      // A throwaway CODEX_HOME. CODEX_HOME relocates the whole Codex config root, so
      // the developer's real ~/.codex is never read or written by this test.
      const codexHome = mkdtempSync(join(tmpdir(), "ccc-codexhome-"));
      writeFileSync(join(codexHome, "config.toml"), "");
      const wrapperPath = join(codexHome, "codex-cap-hook.sh");
      writeCodexCapHookWrapper(wrapperPath);
      writeCodexControlHook({
        hooksPath: join(codexHome, "hooks.json"),
        ownershipPath: join(codexHome, "owned.json"),
        wrapperPath,
        ...QUIET,
      });

      const result = await codexHooksList({
        cwd: mkdtempSync(join(tmpdir(), "ccc-codexcwd-")),
        env: { ...process.env, CODEX_HOME: codexHome },
        timeoutMs: 60_000,
      });

      expect(result.ok).toBe(true);
      // No warnings means Codex understood every field we wrote. This is the whole
      // reason this test exists: it is the only check that the schema is real.
      expect(result.warnings).toEqual([]);
      expect(result.hooks.length).toBe(1);
      const hook = result.hooks[0];
      expect(hook.eventName).toBe("preToolUse");
      expect(hook.matcher).toBe("*");
      expect(hook.command).toBe(codexControlHookCommand(wrapperPath));
      expect(hook.source).toBe("user");
      expect(hook.isManaged).toBe(false);
      expect(hook.enabled).toBe(true);
      // ARMING IS THE DEVELOPER'S CALL. We do not grant trust ourselves; the hook
      // sits inert until they approve it in /hooks. If this ever comes back
      // "trusted" straight after a write, something is granting trust behind their
      // back and it must not ship.
      expect(hook.trustStatus).toBe("untrusted");
    },
    120_000,
  );

  test.skipIf(!codexOnPath)(
    "a hooks file Codex cannot parse shows up as a warning we can act on",
    async () => {
      const codexHome = mkdtempSync(join(tmpdir(), "ccc-codexhome-"));
      writeFileSync(join(codexHome, "config.toml"), "");
      writeFileSync(join(codexHome, "hooks.json"), "{ not json");
      const result = await codexHooksList({
        cwd: mkdtempSync(join(tmpdir(), "ccc-codexcwd-")),
        env: { ...process.env, CODEX_HOME: codexHome },
        timeoutMs: 60_000,
      });
      expect(result.ok).toBe(true);
      expect(result.hooks).toEqual([]);
      expect(
        result.warnings.some((w) => w.includes(join(codexHome, "hooks.json"))),
      ).toBe(true);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// the wiring: init --control installs it, uninstall removes it
// ---------------------------------------------------------------------------

describe("init / uninstall wiring", () => {
  // Minimal init deps that get all the way to the Control step without touching a
  // real ~/.claude, a real ~/.codex, a real daemon, or the network.
  function controlInitDeps(
    logs: string[],
    calls: string[],
    overrides: Partial<InitDeps> = {},
  ): InitDeps {
    return {
      ensureConfigFiles: () => {},
      ensureCollectorBinary: () => {},
      stageMeterProgram: () => {},
      writeServerUrl: () => {},
      loadEnv: () => ({ MARGINFRONT_API_KEY: "mf_sk_x" }),
      isTTY: () => false,
      hasApiKey: () => true,
      detectCacheTtl: () => "1h",
      checkKey: async () => ({
        ok: true,
        organizationName: "Test Org",
        keyType: "secret",
      }),
      clearAuthHold: () => {},
      writeCacheTtl: () => {},
      promptConsent: async () => true,
      writeClaudeTelemetry: () => ({
        written: [],
        skipped: [],
        backupPath: null,
      }),
      writeCodexConfig: () => ({ action: "created", backupPath: null }),
      codexHasCccBlock: () => true,
      installDaemon: () => {},
      installControlScript: () => calls.push("claude-script"),
      installControlHook: () => calls.push("claude-hook"),
      installCodexControlHook: () => {
        calls.push("codex-hook");
        return "wired";
      },
      syncControl: async () => {},
      // Codex IS on this rig's machine, and it has NOT trusted the hook yet - the
      // state the final block exists for. Injected so no test ever spawns the real
      // Codex app-server (or reads this developer's real ~/.codex).
      codexInstalled: () => true,
      claudeInstalled: () => true,
      resolveCodexTrust: async () => ({ state: "needs-re-trust" }),
      findZshrcLines: () => ({ found: false, matchedLines: [] }),
      log: (m) => logs.push(m),
      ...overrides,
    };
  }

  test("init --control wires Codex and ENDS on what to do next", async () => {
    const logs: string[] = [];
    const calls: string[] = [];
    await cmdInit(true, true, controlInitDeps(logs, calls));
    expect(calls).toContain("codex-hook");
    const out = logs.join("\n");
    expect(out).toContain("Cap check installed for Codex.");
    // The checklist row points DOWN at the block, and the block is the last thing
    // printed, so the instruction cannot be scrolled past.
    expect(out).toContain(
      "Codex:       usage reporting on, cap check needs one more step (below)",
    );
    expect(out).toContain("LAST STEP: turn on the Codex cap check.");
    expect(out).toContain("  2. Type /hooks and press Enter.");
    expect(out.trimEnd().endsWith("status")).toBe(true);
    // Nothing may print after the final block.
    const afterLastStep = out.slice(out.indexOf("LAST STEP:"));
    expect(afterLastStep).not.toContain("SETUP COMPLETE");
  });

  // An unreadable trust state still asks for the click. Trusting twice is
  // harmless; missing the click leaves Codex uncapped.
  test("an unreadable Codex trust state still prints the LAST STEP block", async () => {
    const logs: string[] = [];
    const calls: string[] = [];
    await cmdInit(
      true,
      true,
      controlInitDeps(logs, calls, {
        resolveCodexTrust: async () => {
          throw new Error("app-server exploded");
        },
      }),
    );
    expect(logs.join("\n")).toContain(
      "LAST STEP: turn on the Codex cap check.",
    );
  });

  // The mirror image: Codex already trusts it, so there is nothing left to click and
  // asking again would be noise.
  test("an already-trusted Codex ends on NOTHING LEFT TO DO", async () => {
    const logs: string[] = [];
    const calls: string[] = [];
    await cmdInit(
      true,
      true,
      controlInitDeps(logs, calls, {
        resolveCodexTrust: async () => ({ state: "armed" }),
      }),
    );
    const out = logs.join("\n");
    expect(out).toContain("Codex:       usage reporting on, cap check active");
    expect(out).toContain("NOTHING LEFT TO DO.");
    expect(out).not.toContain("LAST STEP:");
  });

  // THE POINT OF THE PER-SURFACE SPLIT. Claude Code arms itself on the next
  // session; Codex does not arm until a human trusts it. If both surfaces ever share
  // one sentence, one of them is being lied to.
  test("init --control never tells the developer Codex arms by itself", async () => {
    const logs: string[] = [];
    const calls: string[] = [];
    await cmdInit(true, true, controlInitDeps(logs, calls));
    const out = logs.join("\n");
    expect(out).toContain(
      "Cap check installed for Claude Code. It arms on your next claude session.",
    );
    // The Claude auto-arm promise must not appear anywhere in the Codex lines.
    const codexLines = out.slice(out.indexOf("Cap check installed for Codex."));
    expect(codexLines).not.toContain("arms on your next");
    // ...and the Codex row is explicit that a human step is still outstanding.
    expect(codexLines).toContain("needs one more step");
  });

  test("a plain init (no --control) touches Codex hooks not at all", async () => {
    const logs: string[] = [];
    const calls: string[] = [];
    await cmdInit(true, false, controlInitDeps(logs, calls));
    expect(calls).toEqual([]);
    expect(logs.join("\n")).not.toContain("Cap check installed for Codex.");
  });

  test("no Codex on the machine -> one honest line, and no error", async () => {
    const logs: string[] = [];
    const calls: string[] = [];
    await cmdInit(
      true,
      true,
      controlInitDeps(logs, calls, {
        installCodexControlHook: () => {
          calls.push("codex-hook");
          return "no-codex";
        },
      }),
    );
    expect(calls).toContain("codex-hook");
    const out = logs.join("\n");
    expect(out).toContain("Codex isn't on this machine");
    expect(out).not.toContain("Cap check installed for Codex.");
    // Not an error, and not a dead end: it says how to add Codex later.
    expect(out).toContain("init --control");
    // The Claude half still lands, and the run ends with nothing outstanding.
    expect(out).toContain("Cap check installed for Claude Code.");
    expect(out).toContain("NOTHING LEFT TO DO.");
  });

  test("Codex present but its hooks file wasn't safe to edit -> says so, keeps Claude", async () => {
    const logs: string[] = [];
    const calls: string[] = [];
    await cmdInit(
      true,
      true,
      controlInitDeps(logs, calls, {
        installCodexControlHook: () => {
          calls.push("codex-hook");
          return "skipped";
        },
      }),
    );
    const out = logs.join("\n");
    expect(out).toContain("Codex:       cap check skipped (see PROBLEM above)");
    expect(out).toContain("Your Claude Code cap is on and working.");
    expect(out).not.toContain("Cap check installed for Codex.");
    // A hook that was never installed has no trust to grant, so asking for the
    // /hooks click here would send the developer somewhere with nothing to do.
    expect(out).not.toContain("LAST STEP:");
  });

  test("the change record names both global files and the stop power, before anything is written", async () => {
    const logs: string[] = [];
    const calls: string[] = [];
    await cmdInit(false, true, {
      ensureConfigFiles: () => {},
      ensureCollectorBinary: () => {},
      stageMeterProgram: () => {},
      writeServerUrl: () => {},
      loadEnv: () => ({ MARGINFRONT_API_KEY: "mf_sk_x" }),
      isTTY: () => false, // no TTY => consent defaults to NO, so init stops after the record
      hasApiKey: () => true,
      detectCacheTtl: () => "1h",
      writeCacheTtl: () => {},
      codexInstalled: () => true,
      claudeInstalled: () => true,
      installControlHook: () => calls.push("claude-hook"),
      installCodexControlHook: () => {
        calls.push("codex-hook");
        return "wired";
      },
      log: (m) => logs.push(m),
    });
    const out = logs.join("\n");
    // Both global files are named...
    expect(out).toContain(".claude/settings.json");
    expect(out).toContain(".codex/config.toml");
    // ...and so is the one thing --control changes about what this tool can do.
    expect(out).toContain("CAN STOP a Claude Code or Codex tool call");
    // Nothing was installed: the record is a disclosure, not a receipt.
    expect(calls).toEqual([]);
  });

  test("uninstall removes the Codex hook exactly once", async () => {
    let called = 0;
    await cmdUninstall(false, {
      uninstallDaemon: () => {},
      stopCollector: () => {},
      removeClaudeTelemetry: () => ({
        removed: [],
        kept: [],
        backupPath: null,
      }),
      removeCodexConfig: () => ({
        action: "missing" as const,
        backupPath: null,
      }),
      removeControlHook: () => {},
      removeCodexControlHook: () => {
        called += 1;
      },
      removeRuntimeFile: () => {},
      removeControlStateDir: () => {},
      purgeConfigDir: () => {},
      findZshrcLines: () => ({ found: false, matchedLines: [] }),
      unsetDesktopEnv: () => {},
      readForwarderPid: () => null,
      sleep: async () => {},
      now: () => 0,
      log: () => {},
    });
    expect(called).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// the daemon call site
// ---------------------------------------------------------------------------
//
// The heal runs inside the watcher's poll loop, which has no exported seam to drive
// from a test without standing up a whole daemon. So this reads the shipped source
// and asserts the wiring is there, the same way the dashboard's node-only tests do.
// It is a weak check on purpose: the behaviour it guards is proved above, and this
// only catches the call site being deleted or throttled wrong.
describe("the daemon runs the self-heal", () => {
  const forwarderSource = readFileSync(
    join(__dirname, "..", "src", "forwarder.ts"),
    "utf8",
  );

  test("the poll loop calls it", () => {
    expect(forwarderSource).toContain("maybeHealCodexControl();");
    expect(forwarderSource).toContain("healCodexControlState({");
  });

  test("it is throttled to once an hour, not once a second", () => {
    expect(forwarderSource).toContain(
      "const CODEX_HEAL_INTERVAL_MS = 60 * 60 * 1000;",
    );
    expect(forwarderSource).toContain(
      "if (codexHealInFlight || Date.now() < nextCodexHealAt) return;",
    );
  });

  test("a heal error can never take the meter down", () => {
    const guard = forwarderSource.slice(
      forwarderSource.indexOf("void healCodexControlState({"),
    );
    expect(guard.slice(0, 400)).toContain(".catch(");
  });
});
