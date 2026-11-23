// codex-status.test.ts: what `code-cost-clarity status` is allowed to say about Codex.
//
// THE ONE FAILURE THIS FILE EXISTS TO PREVENT: telling a developer the cap is on for
// Codex when it is not. Everything else here is in service of that.
//
// Codex has a trap built into its own reporting. A hook can be `enabled: true` and
// `trustStatus: "untrusted"` at the same time, and in that state Codex silently skips
// it. Anything that reads `enabled` and calls it armed is wrong. So the resolver keys
// off trustStatus, and these tests drive every state through canned `hooks/list`
// payloads shaped like real app-server output.
//
// THE SECOND TRAP, probed against codex-cli 0.145.0 in a throwaway CODEX_HOME:
// with `[features] hooks = false`, `hooks/list` returns an
// EMPTY hook list, with no warning and no error. That is byte-identical to a machine
// where nothing was ever installed. So "hooks are switched off" can ONLY be learned by
// reading config.toml, and it has to be read BEFORE hooks/list is believed. The last
// test in this file re-proves that against the real binary, because the whole
// ordering rests on it.
//
// Every path here is a temp path. Nothing reads or writes the real ~/.codex.

import { test, expect, describe } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCodexControlStatus,
  renderCodexControlStatusLine,
  renderCodexControlStatusDetail,
  codexHooksFeatureDisabled,
  codexControlHookCommand,
  writeCodexCapHookWrapper,
  writeCodexControlHook,
  CODEX_HOOK_STATUS_MESSAGE,
  CONTROL_DIR,
  type CodexControlState,
} from "../src/control";
import {
  codexHooksList,
  type CodexHooksListResult,
} from "../src/codex-app-server";
import { cmdStatus, type StatusDeps } from "../src/cli";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ccc-codexstatus-"));
}

interface Seat {
  dir: string;
  hooksPath: string;
  ownershipPath: string;
  wrapperPath: string;
  configPath: string;
  command: string;
}

// A machine that has already run `init --control`: the hook is in hooks.json and the
// receipt records the exact command we wrote.
function seat(configToml = ""): Seat {
  const dir = tmp();
  const s: Seat = {
    dir,
    hooksPath: join(dir, "hooks.json"),
    ownershipPath: join(dir, "owned.json"),
    wrapperPath: join(dir, "codex-cap-hook.sh"),
    configPath: join(dir, "config.toml"),
    command: codexControlHookCommand(join(dir, "codex-cap-hook.sh")),
  };
  writeFileSync(s.configPath, configToml);
  writeCodexCapHookWrapper(s.wrapperPath);
  writeCodexControlHook({
    hooksPath: s.hooksPath,
    ownershipPath: s.ownershipPath,
    wrapperPath: s.wrapperPath,
    codexInstalled: true,
    log: () => {},
  });
  return s;
}

// The two ways a trusted hook's command can drift, spelled without naming any one
// platform's interpreter. The Unix command starts with /bin/sh and the Windows one
// with node, so a mutation written as .replace("/bin/sh", ...)
// quietly becomes a no-op on the other lane - and a "mutated" command that is
// identical to the real one turns these tests from proof into decoration.

// One character, same length: the smallest edit Codex's entry hash can see.
function mutateOneCharacter(command: string): string {
  const firstSpace = command.indexOf(" ");
  const interpreter = command.slice(0, firstSpace);
  return (
    interpreter.slice(0, -1) +
    interpreter.slice(-1).toUpperCase() +
    command.slice(firstSpace)
  );
}

// An edit inside the path itself, which is what kills every path-based way of
// recognising our own hook.
function mutateScriptPath(command: string): string {
  return command.replace(/([^\\/"]+)(\.\w+)"$/, '$1x$2"');
}

// One hook, in the shape the real app-server returns.
function listedHook(
  command: string,
  overrides: Partial<{
    trustStatus: string;
    enabled: boolean;
    statusMessage: string | null;
  }> = {},
) {
  return {
    key: "/x/hooks.json:pre_tool_use:0:0",
    eventName: "preToolUse",
    command,
    matcher: "*",
    statusMessage: CODEX_HOOK_STATUS_MESSAGE,
    source: "user",
    enabled: true,
    isManaged: false,
    currentHash: "sha256:deadbeef",
    trustStatus: "trusted",
    ...overrides,
  };
}

function canned(result: Partial<CodexHooksListResult>): typeof codexHooksList {
  return (async () =>
    ({
      ok: true,
      hooks: [],
      warnings: [],
      errors: [],
      ...result,
    }) as CodexHooksListResult) as unknown as typeof codexHooksList;
}

// ---------------------------------------------------------------------------
// the five states, one canned hooks/list payload each
// ---------------------------------------------------------------------------

describe("the five states", () => {
  test("trusted + enabled -> armed", async () => {
    const s = seat();
    const status = await resolveCodexControlStatus({
      ...s,
      codexInstalled: true,
      hooksList: canned({ hooks: [listedHook(s.command)] }),
    });
    expect(status.state).toBe("armed");
  });

  // THE TRAP. This is the payload that would fool anything reading `enabled`.
  test("enabled:true but untrusted -> needs-re-trust, NOT armed", async () => {
    const s = seat();
    const status = await resolveCodexControlStatus({
      ...s,
      codexInstalled: true,
      hooksList: canned({
        hooks: [
          listedHook(s.command, { trustStatus: "untrusted", enabled: true }),
        ],
      }),
    });
    expect(status.state).toBe("needs-re-trust");
    expect(status.reason).toBe("untrusted");
  });

  test("[features] hooks = false -> hooks-disabled", async () => {
    const s = seat('model = "gpt-5.6-sol"\n\n[features]\nhooks = false\n');
    const status = await resolveCodexControlStatus({
      ...s,
      codexInstalled: true,
      // Codex returns this payload for this state: empty, no warning, no error. If the
      // resolver believed this it would say "not-installed" and send the developer to
      // reinstall something that is already installed.
      hooksList: canned({ hooks: [] }),
    });
    expect(status.state).toBe("hooks-disabled");
    expect(status.reason).toBe("features-hooks-false");
  });

  test("no hook of ours in the list -> not-installed", async () => {
    const s = seat();
    const status = await resolveCodexControlStatus({
      ...s,
      codexInstalled: true,
      hooksList: canned({
        hooks: [
          listedHook('/bin/sh "/home/dev/my-own-hook.sh"', {
            statusMessage: "my own hook",
          }),
        ],
      }),
    });
    expect(status.state).toBe("not-installed");
  });

  test("Codex binary absent -> unknown, and never armed", async () => {
    const s = seat();
    const status = await resolveCodexControlStatus({
      ...s,
      codexInstalled: false,
      // Even if the list WOULD have said "trusted", we never get to ask.
      hooksList: canned({ hooks: [listedHook(s.command)] }),
    });
    expect(status.state).toBe("unknown");
    expect(status.reason).toBe("codex-missing");
    expect(status.state).not.toBe("armed");
  });
});

// ---------------------------------------------------------------------------
// the frozen command string is the contract
// ---------------------------------------------------------------------------

describe("a changed command string", () => {
  // Codex keys trust to a hash of the hook ENTRY. One changed byte silently un-trusts
  // it. So a command that is not byte-equal to ours can never be reported as armed,
  // even when Codex still says "trusted" - that trust belongs to a different entry.
  test("one character different in the command -> needs-re-trust", async () => {
    const s = seat();
    const mutated = mutateOneCharacter(s.command);
    expect(mutated).not.toBe(s.command);
    expect(mutated.length).toBe(s.command.length);
    const status = await resolveCodexControlStatus({
      ...s,
      codexInstalled: true,
      hooksList: canned({
        hooks: [listedHook(mutated, { trustStatus: "trusted" })],
      }),
    });
    expect(status.state).toBe("needs-re-trust");
    expect(status.reason).toBe("command-changed");
  });

  // The edit can land inside the path itself, which kills every path-based way of
  // recognising our own hook. The label Codex echoes back is what saves it.
  test("the wrapper path itself edited -> still recognised as ours", async () => {
    const s = seat();
    const mutated = mutateScriptPath(s.command);
    expect(mutated).not.toBe(s.command);
    const status = await resolveCodexControlStatus({
      ...s,
      codexInstalled: true,
      hooksList: canned({
        hooks: [listedHook(mutated, { trustStatus: "trusted" })],
      }),
    });
    expect(status.state).toBe("needs-re-trust");
  });

  // The third recogniser, and the only one the temp-dir tests above cannot reach:
  // a command living in the REAL control folder. Someone who retitles the hook still
  // gets told to re-trust it, not told nothing is installed.
  test("our folder in the command, our label gone -> still ours", async () => {
    const s = seat();
    const status = await resolveCodexControlStatus({
      ...s,
      codexInstalled: true,
      hooksList: canned({
        hooks: [
          listedHook(`/bin/sh "${join(CONTROL_DIR, "codex-cap-hook.sh")}"`, {
            statusMessage: "renamed by hand",
            trustStatus: "trusted",
          }),
        ],
      }),
    });
    expect(status.state).toBe("needs-re-trust");
  });

  // A hook that is not ours and does not carry our label is somebody else's. Claiming
  // it would be as wrong as missing our own.
  test("a stranger's hook with our label absent -> not-installed", async () => {
    const s = seat();
    const status = await resolveCodexControlStatus({
      ...s,
      codexInstalled: true,
      hooksList: canned({
        hooks: [
          listedHook('/bin/sh "/opt/acme/lint.sh"', {
            statusMessage: "Running the Acme linter",
          }),
        ],
      }),
    });
    expect(status.state).toBe("not-installed");
  });
});

// ---------------------------------------------------------------------------
// the armed invariant, stated once and checked everywhere
// ---------------------------------------------------------------------------
//
// armed  <=>  the listed command is byte-equal to the CURRENT frozen command
//             AND trustStatus is exactly "trusted"
//             AND enabled is true.
//
// THE HOLE THESE FIXTURES CLOSE: the receipt on disk also holds a command, and every
// other test in this file writes a receipt that happens to equal the frozen command.
// So a version that compared the listed hook against the RECEIPT copy instead of the
// constant would pass the whole suite while being wrong. The receipt is a record of
// what an earlier install wrote; it is not the contract. After any wrapper-path change
// that stale entry points at a wrapper that no longer exists, so calling it "armed"
// would promise a pause that fails open instead.
//
// The receipt still earns its keep as a RECOGNISER (it is how we know an old entry is
// ours rather than a stranger's), which is why the answer is needs-re-trust and not
// not-installed.

describe("armed means the current frozen command, not the receipt's copy", () => {
  // A machine mid-upgrade: the receipt records where the wrapper used to live.
  function seatWithStaleReceipt(): { s: Seat; oldCommand: string } {
    const s = seat();
    const oldCommand = codexControlHookCommand("/old/place/codex-cap-hook.sh");
    writeFileSync(
      s.ownershipPath,
      JSON.stringify({ command: oldCommand }) + "\n",
    );
    return { s, oldCommand };
  }

  test("a RECEIPT-command hook, trusted and enabled, is needs-re-trust, never armed", async () => {
    const { s, oldCommand } = seatWithStaleReceipt();
    const status = await resolveCodexControlStatus({
      ...s,
      codexInstalled: true,
      hooksList: canned({
        hooks: [listedHook(oldCommand, { trustStatus: "trusted" })],
      }),
    });
    expect(status.state).toBe("needs-re-trust");
    expect(status.reason).toBe("command-changed");
    expect(renderCodexControlStatusLine(status)).not.toContain("Codex: on.");
  });

  test("the stale receipt entry is still recognised as ours, not a stranger's", async () => {
    const { s, oldCommand } = seatWithStaleReceipt();
    const status = await resolveCodexControlStatus({
      ...s,
      codexInstalled: true,
      hooksList: canned({
        hooks: [
          listedHook(oldCommand, {
            trustStatus: "trusted",
            statusMessage: "renamed by hand",
          }),
        ],
      }),
    });
    expect(status.state).not.toBe("not-installed");
    expect(status.state).toBe("needs-re-trust");
  });

  // Three command shapes x four trust strings x two enabled values. Only one of the
  // twenty-four is armed. Enumerated rather than sampled because "armed" is the one
  // claim in this package that can cost a customer real money if it lies.
  test("24 combinations: exactly one is armed", async () => {
    const { s, oldCommand } = seatWithStaleReceipt();
    const commands = [s.command, mutateOneCharacter(s.command), oldCommand];
    const trusts = ["trusted", "untrusted", "Trusted", "unknown"];
    const enableds = [true, false];
    let armedCount = 0;
    for (const command of commands) {
      for (const trustStatus of trusts) {
        for (const enabled of enableds) {
          const status = await resolveCodexControlStatus({
            ...s,
            codexInstalled: true,
            hooksList: canned({
              hooks: [listedHook(command, { trustStatus, enabled })],
            }),
          });
          const shouldArm =
            command === s.command && trustStatus === "trusted" && enabled;
          const where = `command=${command} trust=${trustStatus} enabled=${enabled}`;
          if (shouldArm) {
            armedCount += 1;
            expect(status.state, where).toBe("armed");
          } else {
            expect(status.state, where).not.toBe("armed");
          }
        }
      }
    }
    expect(armedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// everything we cannot prove lands in "unknown"
// ---------------------------------------------------------------------------

describe("unknown never rounds up", () => {
  const unprovable: Array<[string, Partial<CodexHooksListResult>, string]> = [
    ["the app-server timed out", { ok: false, reason: "timeout" }, "timeout"],
    [
      "the app-server answered nonsense",
      { ok: false, reason: "bad-response" },
      "bad-response",
    ],
    [
      "codex could not spawn",
      { ok: false, reason: "codex-missing" },
      "codex-missing",
    ],
  ];

  for (const [name, payload, reason] of unprovable) {
    test(`${name} -> unknown`, async () => {
      const s = seat();
      const status = await resolveCodexControlStatus({
        ...s,
        codexInstalled: true,
        hooksList: canned(payload),
      });
      expect(status.state).toBe("unknown");
      expect(status.reason).toBe(reason);
    });
  }

  // A warning naming our hooks file means Codex REFUSED to read it. Our entry may
  // well still be sitting in that file, so "not-installed" would be a lie and
  // "armed" would be a worse one.
  test("Codex rejected our hooks file -> unknown, not not-installed", async () => {
    const s = seat();
    const status = await resolveCodexControlStatus({
      ...s,
      codexInstalled: true,
      hooksList: canned({
        hooks: [],
        warnings: [`failed to parse hooks config ${s.hooksPath}: bad shape`],
      }),
    });
    expect(status.state).toBe("unknown");
    expect(status.reason).toBe("hooks-file-rejected");
  });

  // A warning about somebody ELSE's hooks file tells us nothing about ours.
  test("a warning about a different file doesn't blind us", async () => {
    const s = seat();
    const status = await resolveCodexControlStatus({
      ...s,
      codexInstalled: true,
      hooksList: canned({
        hooks: [listedHook(s.command)],
        warnings: ["failed to parse hooks config /somewhere/else.json: nope"],
      }),
    });
    expect(status.state).toBe("armed");
  });
});

// ---------------------------------------------------------------------------
// the switched-off hook
// ---------------------------------------------------------------------------

describe("a hook switched off in /hooks", () => {
  // Trusted but disabled is inert. It is not "armed", and telling the developer to
  // re-trust it would be the wrong instruction - it is already trusted.
  test("trusted but enabled:false -> hooks-disabled, not armed", async () => {
    const s = seat();
    const status = await resolveCodexControlStatus({
      ...s,
      codexInstalled: true,
      hooksList: canned({
        hooks: [
          listedHook(s.command, { trustStatus: "trusted", enabled: false }),
        ],
      }),
    });
    expect(status.state).toBe("hooks-disabled");
    expect(status.reason).toBe("hook-switched-off");
  });
});

// ---------------------------------------------------------------------------
// reading [features] hooks out of config.toml
// ---------------------------------------------------------------------------

describe("codexHooksFeatureDisabled", () => {
  function cfg(text: string): boolean | null {
    const path = join(tmp(), "config.toml");
    writeFileSync(path, text);
    return codexHooksFeatureDisabled(path);
  }

  test("hooks = false inside [features] -> true", () => {
    expect(cfg("[features]\nhooks = false\n")).toBe(true);
  });

  test("hooks = true inside [features] -> false", () => {
    expect(cfg("[features]\nhooks = true\n")).toBe(false);
  });

  test("no [features] table at all -> null (Codex's default is on)", () => {
    expect(cfg('model = "gpt-5.6-sol"\n')).toBe(null);
  });

  test("a missing file -> null, never a throw", () => {
    expect(codexHooksFeatureDisabled(join(tmp(), "nope.toml"))).toBe(null);
  });

  // A real config can have other [features] keys next to hooks, and other
  // tables after it. Reading the wrong table would report "off" on a machine where
  // hooks are on, or worse, "on" where they are off.
  test("hooks = false in a DIFFERENT table is not ours", () => {
    expect(
      cfg(
        "[features]\njs_repl = false\n\n[mcp_servers.node_repl]\nhooks = false\n",
      ),
    ).toBe(null);
  });

  test("a [features] table that follows another table is still found", () => {
    expect(
      cfg(
        '[mcp_servers.node_repl]\ncommand = "node"\n\n[features]\nhooks = false\n',
      ),
    ).toBe(true);
  });

  test("the dotted form features.hooks = false is found too", () => {
    expect(cfg('model = "x"\nfeatures.hooks = false\n')).toBe(true);
  });

  test("a commented-out hooks line is ignored", () => {
    expect(cfg("[features]\n# hooks = false\nhooks = true\n")).toBe(false);
  });

  test("a bare 'hooks' key outside any table is ignored", () => {
    expect(cfg("hooks = false\n\n[features]\njs_repl = true\n")).toBe(null);
  });

  // Header spellings real Codex honours. In codex-cli 0.145.0 each one really does
  // switch hooks off (hooks/list came back empty, no warning). Missing one of these makes
  // status say "not installed" on a machine that IS installed.
  test("a trailing comment on the header -> still the features table", () => {
    expect(cfg("[features] # experimental\nhooks = false\n")).toBe(true);
  });

  test("spaces inside the header brackets -> still the features table", () => {
    expect(cfg("[ features ]\nhooks = false\n")).toBe(true);
  });

  test("spaces and a comment together -> still the features table", () => {
    expect(cfg("[ features ]   # x\nhooks = false\n")).toBe(true);
  });

  // Codex rejects this shape outright ("invalid type: sequence, expected struct
  // FeaturesToml"), so it is a broken config, not hooks switched off. Reading it as
  // "off" would tell a developer to fix hooks when the real problem is the file.
  test("the array-of-tables form [[features]] is NOT the features table", () => {
    expect(cfg("[[features]]\nhooks = false\n")).toBe(null);
  });

  test("a header that merely starts with 'features' is not ours", () => {
    expect(cfg("[features_preview]\nhooks = false\n")).toBe(null);
    expect(cfg("[features.sub]\nhooks = false\n")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// the exact line each state prints
// ---------------------------------------------------------------------------

describe("the printed line", () => {
  const lines: Array<[CodexControlState, string]> = [
    [
      "armed",
      "Codex: on. You've trusted the cap check, so it runs before Codex tool calls. Nothing to do.",
    ],
    [
      "needs-re-trust",
      "Codex: not on yet. Codex only runs hooks you've trusted, and it asks again whenever one changes. To turn it on, run /hooks inside codex and trust the MarginFront cap check.",
    ],
    [
      "hooks-disabled",
      "Codex: off. Hooks are switched off in your Codex settings, so the cap can't pause Codex tool calls. Turn hooks back on, then run /hooks inside codex and trust the MarginFront cap check.",
    ],
    [
      "not-installed",
      "Codex: no cap check installed. To add one, run: node ~/.marginfront-ccc/cli.js init --control",
    ],
    ["unknown", "Codex: we couldn't check, so we don't know if the cap is on."],
  ];

  for (const [state, expected] of lines) {
    test(`${state} prints its exact line`, () => {
      expect(renderCodexControlStatusLine({ state })).toBe(expected);
    });
  }

  // Printed text: no em dashes, and no "blocked" /
  // "denied" wording that reads as an accusation.
  test("no em dashes and no guard-tripping words in any line", () => {
    for (const [state] of lines) {
      const line = renderCodexControlStatusLine({ state });
      expect(line).not.toContain("—");
      expect(line.toLowerCase()).not.toContain("block");
      expect(line.toLowerCase()).not.toContain("denied");
    }
  });

  // Four of the five are states the developer can act on, so each names the action.
  test("every state except armed says what to do next", () => {
    for (const [state] of lines) {
      if (state === "armed") continue;
      const line = renderCodexControlStatusLine({ state });
      const detail = renderCodexControlStatusDetail({ state }) ?? "";
      expect(`${line} ${detail}`).toMatch(/[Rr]un[ :]/);
    }
  });

  test("only unknown gets a second line, and it names the reason", () => {
    expect(renderCodexControlStatusDetail({ state: "armed" })).toBe(null);
    expect(renderCodexControlStatusDetail({ state: "not-installed" })).toBe(
      null,
    );
    expect(
      renderCodexControlStatusDetail({
        state: "unknown",
        reason: "codex-missing",
      }),
    ).toContain("Codex isn't on this machine");
    expect(
      renderCodexControlStatusDetail({ state: "unknown", reason: "timeout" }),
    ).toContain("took too long");
  });
});

// ---------------------------------------------------------------------------
// the section inside `code-cost-clarity status`
// ---------------------------------------------------------------------------

describe("code-cost-clarity status", () => {
  function statusDeps(overrides: Partial<StatusDeps> = {}): {
    deps: StatusDeps;
    logs: string[];
  } {
    const logs: string[] = [];
    return {
      logs,
      deps: {
        log: (m) => logs.push(m),
        queryStatus: () => ({
          loaded: true,
          running: true,
          pid: 4242,
          lastExitCode: 0,
        }),
        readOutputLog: () => [],
        readErrorLog: () => [],
        hasApiKey: () => true,
        errorLogMtimeMs: () => null,
        now: () => 0,
        // Read-only surface checks for the other checklist rows, pinned so these
        // tests describe the Codex row alone and never read this developer's
        // real ~/.claude or ~/.codex.
        claudeTelemetryOn: () => true,
        codexInstalled: () => true,
        claudeInstalled: () => true,
        codexCaptureWired: () => true,
        ...overrides,
      },
    };
  }

  test("the Codex checklist row reports the trust state when Control is armed", async () => {
    const { deps, logs } = statusDeps({
      controlIsArmed: () => true,
      codexControlStatus: async () => ({ state: "armed" }),
    });
    await cmdStatus(deps);
    expect(logs.join("\n")).toContain(
      "  Codex:       OK. Cap check trusted. Nothing to do.",
    );
  });

  // Everything healthy except an untrusted hook.
  test("needs-re-trust puts the exact click in the checklist row", async () => {
    const { deps, logs } = statusDeps({
      controlIsArmed: () => true,
      codexControlStatus: async () => ({ state: "needs-re-trust" }),
    });
    await cmdStatus(deps);
    const out = logs.join("\n");
    expect(out).toContain(
      "  Codex:       ACTION NEEDED. Open codex, type /hooks, pick trust for the MarginFront cap check.",
    );
    // The other three rows are OK, so the one thing to do is unmissable.
    expect(out).toContain("  Claude Code: OK. Usage reporting is on.");
    expect(out).toContain(
      "  Meter:       OK. The background meter is running. Your spend is being captured.",
    );
  });

  // An install without Control has no cap to arm, so the trust check is never run, but
  // the row still has to answer "is Codex being counted?".
  test("never asks about trust when Control was never turned on, and reports capture instead", async () => {
    const { deps, logs } = statusDeps({
      controlIsArmed: () => false,
      codexControlStatus: async () => {
        throw new Error("must not be asked");
      },
    });
    await cmdStatus(deps);
    const out = logs.join("\n");
    expect(out).toContain("  Codex:       OK. Codex usage is being captured.");
    expect(out).not.toContain("cap check");
  });

  test("no Codex on the machine says so instead of asking for a cap check", async () => {
    const { deps, logs } = statusDeps({
      controlIsArmed: () => false,
      codexInstalled: () => false,
      codexCaptureWired: () => false,
    });
    await cmdStatus(deps);
    expect(logs.join("\n")).toContain(
      "  Codex:       Not found on this machine. Nothing to do.",
    );
  });

  test("unknown prints the reason line under it", async () => {
    const { deps, logs } = statusDeps({
      controlIsArmed: () => true,
      codexControlStatus: async () => ({
        state: "unknown",
        reason: "codex-missing",
      }),
    });
    await cmdStatus(deps);
    const out = logs.join("\n");
    expect(out).toContain("  Codex:       CAN'T TELL.");
    // The reason moves below the checklist, under the optional-detail header.
    expect(out).toContain("Optional detail, for the curious:");
    expect(out).toContain("Codex isn't on this machine");
  });

  // status is the command a stuck developer runs. A Codex check that throws must not
  // cost them the daemon state and the error log they actually came for.
  test("a check that throws degrades to unknown and keeps the rest of status", async () => {
    const { deps, logs } = statusDeps({
      controlIsArmed: () => true,
      codexControlStatus: async () => {
        throw new Error("app-server exploded");
      },
      readErrorLog: () => ["a real error the developer needs"],
    });
    const code = await cmdStatus(deps);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("  Codex:       CAN'T TELL.");
    expect(out).toContain("a real error the developer needs");
  });

  test("status never claims Codex is armed on a machine without Codex", async () => {
    const s = seat();
    const { deps, logs } = statusDeps({
      controlIsArmed: () => true,
      codexControlStatus: () =>
        resolveCodexControlStatus({
          ...s,
          codexInstalled: false,
          hooksList: canned({ hooks: [listedHook(s.command)] }),
        }),
    });
    await cmdStatus(deps);
    const out = logs.join("\n");
    expect(out).not.toContain("Cap check trusted");
    expect(out).toContain("  Codex:       CAN'T TELL.");
  });
});

// ---------------------------------------------------------------------------
// THE REAL CODEX CLI - skipped when Codex isn't on the machine
// ---------------------------------------------------------------------------

const codexOnPath =
  spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;

describe("against the real Codex CLI", () => {
  // THE LOAD-BEARING PROBE. The whole ordering of resolveCodexControlStatus rests on
  // this one behaviour: with hooks switched off, Codex reports an empty list and says
  // nothing about why, so config.toml is the only place the answer exists. If a Codex
  // release emits a warning here, this test fails and the config.toml read is worth
  // revisiting.
  test.skipIf(!codexOnPath)(
    "[features] hooks = false hides the hook with no warning at all",
    async () => {
      // A throwaway CODEX_HOME. CODEX_HOME relocates the whole Codex config root, so
      // the developer's real ~/.codex is never read or written by this test.
      const codexHome = mkdtempSync(join(tmpdir(), "ccc-codexhome-"));
      const wrapperPath = join(codexHome, "codex-cap-hook.sh");
      writeCodexCapHookWrapper(wrapperPath);
      writeCodexControlHook({
        hooksPath: join(codexHome, "hooks.json"),
        ownershipPath: join(codexHome, "owned.json"),
        wrapperPath,
        codexInstalled: true,
        log: () => {},
      });
      const cwd = mkdtempSync(join(tmpdir(), "ccc-codexcwd-"));

      writeFileSync(
        join(codexHome, "config.toml"),
        "[features]\nhooks = true\n",
      );
      const on = await codexHooksList({
        cwd,
        env: { ...process.env, CODEX_HOME: codexHome },
        timeoutMs: 60_000,
      });
      expect(on.ok).toBe(true);
      expect(on.hooks.length).toBe(1);

      writeFileSync(
        join(codexHome, "config.toml"),
        "[features]\nhooks = false\n",
      );
      const off = await codexHooksList({
        cwd,
        env: { ...process.env, CODEX_HOME: codexHome },
        timeoutMs: 60_000,
      });
      expect(off.ok).toBe(true);
      expect(off.hooks).toEqual([]);
      // Indistinguishable from "never installed" - this is the reason the resolver
      // reads config.toml first.
      expect(off.warnings).toEqual([]);
      expect(off.errors).toEqual([]);
    },
    120_000,
  );

  // End to end through the resolver, against the real binary, in the state that
  // matters most: the developer has not trusted it yet.
  test.skipIf(!codexOnPath)(
    "a freshly installed hook resolves to needs-re-trust, never armed",
    async () => {
      const codexHome = mkdtempSync(join(tmpdir(), "ccc-codexhome-"));
      writeFileSync(join(codexHome, "config.toml"), "");
      const wrapperPath = join(codexHome, "codex-cap-hook.sh");
      const hooksPath = join(codexHome, "hooks.json");
      writeCodexCapHookWrapper(wrapperPath);
      writeCodexControlHook({
        hooksPath,
        ownershipPath: join(codexHome, "owned.json"),
        wrapperPath,
        codexInstalled: true,
        log: () => {},
      });
      const cwd = mkdtempSync(join(tmpdir(), "ccc-codexcwd-"));

      const status = await resolveCodexControlStatus({
        hooksPath,
        ownershipPath: join(codexHome, "owned.json"),
        wrapperPath,
        configPath: join(codexHome, "config.toml"),
        codexInstalled: true,
        hooksList: (opts = {}) =>
          codexHooksList({
            ...opts,
            cwd,
            env: { ...process.env, CODEX_HOME: codexHome },
            timeoutMs: 60_000,
          }),
      });
      expect(status.state).toBe("needs-re-trust");
      expect(status.state).not.toBe("armed");
    },
    120_000,
  );
});
