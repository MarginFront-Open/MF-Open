// cli-commands.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: five CLI commands actually do what they claim - `help`, `version`, `preview`, `status`,
// and `stop`. Every assertion is capable of FAILING (see each test's header for
// the exact mutation that breaks it).
//
// HOW WE TEST help / version / preview / status HONESTLY:
//   These four are PRIVATE functions in cli.ts (printHelp, readVersion, cmdPreview,
//   cmdStatus) reached only through main()'s dispatch - they are not exported, so
//   there is no in-process seam to call without editing src/. The honest way to
//   exercise the REAL code is to run the CLI exactly as a user does: as a child
//   process, asserting on its real stdout/stderr + exit code. We run the CURRENT
//   TypeScript source via a tiny resolve hook (test/helpers/ts-import-hook.mjs) so
//   the help-text assertions check the code as it stands right now, not a stale
//   dist/ build. (Requires Node >= 22.6, which strips TS types natively.)
//   help / version / preview / status are all read-only - they
//   print and exit; none install a daemon, write global config, or kill a process.
//
// HOW WE TEST stop HONESTLY:
//   stop's signal-and-shutdown ENGINE is the exported stopForwarderThenStopCollector.
//   We drive it against a REAL child process with a REAL process.kill and REAL
//   liveness (the child's own 'exit' event), so we assert it genuinely terminates a
//   live forwarder - not a spy that always returns true - and that it stops the
//   collector only AFTER the forwarder is truly gone. We do NOT run `code-cost-clarity stop` as a
//   subprocess: cmdStop unconditionally boots out the live launchd daemon and kills
//   the real collector, which is a forbidden machine side effect for a unit test.
// ---------------------------------------------------------------------------

import { test, expect, describe } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPidAlive, signalForwarderStop } from "../src/connector";
import {
  stopForwarderThenStopCollector,
  runningForwarderPid,
  type StopDeps,
} from "../src/cli";

// --- paths + a helper that runs the real CLI as a child process -------------
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const CLI_SOURCE = join(PACKAGE_ROOT, "src", "cli.ts");
const STAND_IN_FORWARDER = join(HERE, "helpers", "stand-in-forwarder.ts");
const TS_HOOK_URL = pathToFileURL(
  join(HERE, "helpers", "ts-import-hook.mjs"),
).href;
const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
).version;

interface CliResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

// Run `node --import <hook> src/cli.ts <args>` and capture what the user would see.
// `stripApiKey` removes MARGINFRONT_API_KEY from the child's env, so `preview` is
// proven to work with NO key configured (its whole reason for existing).
// `isolateIdentity` points HOME at a temp dir and strips CCC_DEVELOPER_EMAIL so
// preview can't pick up this machine's real identity, the same isolation
// preview-developer-override.test.ts's runPreview() uses.
function runCli(
  args: string[],
  opts: { stripApiKey?: boolean; isolateIdentity?: boolean } = {},
): CliResult {
  const home = opts.isolateIdentity
    ? mkdtempSync(join(tmpdir(), "ccc-cli-home-"))
    : undefined;
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(home ? { HOME: home } : {}),
    };
    if (opts.stripApiKey) delete env.MARGINFRONT_API_KEY;
    if (opts.isolateIdentity) delete env.CCC_DEVELOPER_EMAIL;
    const result = spawnSync(
      process.execPath,
      ["--import", TS_HOOK_URL, CLI_SOURCE, ...args],
      { encoding: "utf8", env, timeout: 30_000 },
    );
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
    };
  } finally {
    if (home) rmSync(home, { recursive: true, force: true });
  }
}

// Pull the first top-level JSON object out of mixed stdout (preview prints the JSON
// record, then sometimes a trailing plain-English hint). Brace-counting so a single
// trailing blob is extracted regardless of the surrounding prose.
function parseFirstJsonObject(text: string): unknown {
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
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error("unbalanced JSON object in CLI output");
}

// ===========================================================================
// help (printHelp)
// ===========================================================================
// NON-VACUOUS: if printHelp dropped any command from its list, the mf_sk_ key
// clarification, the Codex mention, or printed "Typical first run" /
// `source ~/.marginfront-ccc/.env`-as-setup wording, the matching assertion fails.
describe("help", () => {
  test("lists every command and the setup help text", () => {
    const { stdout, status } = runCli(["help"]);
    expect(status).toBe(0);

    // Every one of the nine commands appears in the command list (line-anchored so
    // a stray prose mention of, say, "run" can't satisfy this by accident).
    for (const command of [
      "init",
      "start",
      "status",
      "preview",
      "run",
      "stop",
      "uninstall",
      "help",
      "version",
    ]) {
      expect(stdout).toMatch(new RegExp(`^\\s+${command}\\b`, "m"));
    }

    // Names the MarginFront SECRET key in its real mf_sk_ form,
    // and is explicit it is NOT the Anthropic/OpenAI key.
    expect(stdout).toContain("mf_sk_");
    expect(stdout).toMatch(/not[\s\S]*your Anthropic or OpenAI key/);

    // Covers Codex, not Claude only.
    expect(stdout).toContain("Codex");

    // The --control blurb tells the both-tools truth. The wording
    // "STOP a Claude Code tool call" must not appear.
    expect(stdout).toContain("Claude Code or Codex tool call");
    expect(stdout).not.toMatch(/STOP a Claude Code tool call\b/);

    // The primary setup flow is the one-step `init`, NOT "Typical first run"
    // and NOT "source the .env" as the way to set up.
    expect(stdout).toContain("Setup is one step:");
    expect(stdout).not.toContain("Typical first run");
    expect(stdout).not.toContain("source ~/.marginfront-ccc/.env");
  });
});

// ===========================================================================
// version (readVersion)
// ===========================================================================
// NON-VACUOUS: version is sourced from the one package.json (build inlines it as
// __CCC_VERSION__; from source it falls back to reading package.json - same value).
// If readVersion printed a hardcoded/stale string, or the resolver drifted from
// package.json, stdout.trim() would no longer equal the real version and this fails.
describe("version", () => {
  test("prints exactly the package's real version", () => {
    const { stdout, status } = runCli(["version"]);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(PACKAGE_VERSION);
    // Guard against an empty/garbage version slipping through the equality above.
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ===========================================================================
// preview (cmdPreview)
// ===========================================================================
// Drives the REAL preview path against REAL OTLP/JSON fixtures, with NO
// MARGINFRONT_API_KEY in the environment, and asserts the exact record fields.
const FIXTURE_WITH_IDENTITY = {
  resourceMetrics: [
    {
      scopeMetrics: [
        {
          metrics: [
            {
              name: "claude_code.token.usage",
              sum: {
                dataPoints: [
                  tokenPoint(
                    "dev@example.com",
                    "claude-opus-4-8[1m]",
                    "sess-abc",
                    "input",
                    1200,
                  ),
                  tokenPoint(
                    "dev@example.com",
                    "claude-opus-4-8[1m]",
                    "sess-abc",
                    "output",
                    340,
                  ),
                  tokenPoint(
                    "dev@example.com",
                    "claude-opus-4-8[1m]",
                    "sess-abc",
                    "cacheRead",
                    5000,
                  ),
                  tokenPoint(
                    "dev@example.com",
                    "claude-opus-4-8[1m]",
                    "sess-abc",
                    "cacheCreation",
                    800,
                  ),
                ],
              },
            },
            {
              name: "claude_code.cost.usage",
              sum: {
                dataPoints: [
                  costPoint(
                    "dev@example.com",
                    "claude-opus-4-8[1m]",
                    "sess-abc",
                    0.0123,
                  ),
                ],
              },
            },
          ],
        },
      ],
    },
  ],
};

// Same shape, but with NO user.email on any datapoint and NO cost metric - models a
// non-org-managed login: spend still lands, under the no-identity placeholder.
const FIXTURE_NO_IDENTITY = {
  resourceMetrics: [
    {
      scopeMetrics: [
        {
          metrics: [
            {
              name: "claude_code.token.usage",
              sum: {
                dataPoints: [
                  tokenPoint(
                    null,
                    "claude-sonnet-4-5",
                    "sess-xyz",
                    "input",
                    900,
                  ),
                  tokenPoint(
                    null,
                    "claude-sonnet-4-5",
                    "sess-xyz",
                    "output",
                    150,
                  ),
                ],
              },
            },
          ],
        },
      ],
    },
  ],
};

// Build one OTLP token datapoint. email=null omits the user.email attribute entirely
// (the real signal for "no org-managed seat").
function tokenPoint(
  email: string | null,
  model: string,
  sessionId: string,
  type: string,
  count: number,
) {
  const attributes = [
    { key: "model", value: { stringValue: model } },
    { key: "session.id", value: { stringValue: sessionId } },
    { key: "type", value: { stringValue: type } },
  ];
  if (email)
    attributes.unshift({ key: "user.email", value: { stringValue: email } });
  return { attributes, asDouble: count };
}

function costPoint(
  email: string,
  model: string,
  sessionId: string,
  cost: number,
) {
  return {
    attributes: [
      { key: "user.email", value: { stringValue: email } },
      { key: "model", value: { stringValue: model } },
      { key: "session.id", value: { stringValue: sessionId } },
    ],
    asDouble: cost,
  };
}

describe("preview", () => {
  // NON-VACUOUS: if cmdPreview stopped printing the record, mis-mapped the developer
  // email to customerExternalId, skipped model normalization, or dropped the token /
  // cost fields, these field assertions fail.
  test("prints the exact record for an identified turn - and needs NO API key", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-preview-"));
    try {
      const file = join(dir, "with-identity.json");
      writeFileSync(file, JSON.stringify(FIXTURE_WITH_IDENTITY));

      const { stdout, stderr, status } = runCli(["preview", file], {
        stripApiKey: true,
        isolateIdentity: true,
      });
      expect(status).toBe(0);
      // No "missing key" complaint - preview must work entirely without a key.
      expect(stderr).not.toMatch(/MARGINFRONT_API_KEY|no.*key/i);

      const body = parseFirstJsonObject(stdout) as {
        records: Array<Record<string, unknown>>;
      };
      expect(body.records).toHaveLength(1);
      const record = body.records[0];

      // Developer email IS the customer id (per-user attribution).
      expect(record.customerExternalId).toBe("dev@example.com");
      // Model normalized: "claude-opus-4-8[1m]" -> "claude-opus-4.8".
      expect(record.model).toBe("claude-opus-4.8");
      // Billed token fields (fresh input + output; cache in its own typed fields).
      expect(record.inputTokens).toBe(1200);
      expect(record.outputTokens).toBe(340);
      expect(record.cacheReadTokens).toBe(5000);
      expect(record.cacheWriteTokens).toBe(800);
      // Cost is carried through (Claude Code's own cache-accurate figure).
      const metadata = record.metadata as Record<string, unknown>;
      expect(metadata.claudeCodeCostUsd).toBe(0.0123);
      expect(metadata.rawModel).toBe("claude-opus-4-8[1m]");

      // Identified turn -> the no-identity hint must NOT appear.
      expect(stdout).not.toMatch(/no-identity placeholder/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // NON-VACUOUS: if the no-email fallback stopped attributing to the placeholder, or
  // the no-identity hint stopped printing, these assertions fail.
  test("falls back to the no-identity placeholder and prints the hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-preview-"));
    try {
      const file = join(dir, "no-identity.json");
      writeFileSync(file, JSON.stringify(FIXTURE_NO_IDENTITY));

      const { stdout, status } = runCli(["preview", file], {
        stripApiKey: true,
        isolateIdentity: true,
      });
      expect(status).toBe(0);

      const body = parseFirstJsonObject(stdout) as {
        records: Array<Record<string, unknown>>;
      };
      expect(body.records).toHaveLength(1);
      const record = body.records[0];

      // No developer email -> Claude-Code no-identity placeholder.
      expect(record.customerExternalId).toBe("claude-code-no-identity");
      expect(record.model).toBe("claude-sonnet-4.5");
      // No cost datapoint -> cost is null (the "needs a backfill" signal downstream).
      const metadata = record.metadata as Record<string, unknown>;
      expect(metadata.claudeCodeCostUsd).toBeNull();

      // The placeholder hint must be printed so the user knows how to fix attribution.
      expect(stdout).toMatch(
        /no developer email is attributed to a no-identity placeholder/,
      );
      expect(stdout).toContain("claude-code-no-identity");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // NON-VACUOUS: if the missing-argument guard were removed, preview would crash or
  // exit 0 instead of returning the helpful exit-1 usage message.
  test("with no file argument exits 1 with a usage message", () => {
    const { stderr, status } = runCli(["preview"], { stripApiKey: true });
    expect(status).toBe(1);
    expect(stderr).toContain("preview needs a capture file");
  });
});

// ===========================================================================
// status (cmdStatus)
// ===========================================================================
// status is read-only: it asks launchd whether the daemon is loaded/running and
// tails the daemon's logs. It NEVER installs, boots out, or kills anything. We run
// it for real and assert the invariants that hold in EVERY branch, so the test is
// deterministic regardless of whether a daemon happens to be loaded on this machine.
//
// NON-VACUOUS: if cmdStatus printed a status sentence outside its four sanctioned
// forms, dropped either log-tail section, or returned a non-zero exit code, the
// matching assertion fails. On a clean machine with a key configured (no daemon)
// the asserted line is the "NOT running (not installed/loaded)" branch; on a
// keyless machine (CI runners) it is the "waiting for a MarginFront key" honesty
// line, so a reword of either branch fails here. The keyless branch's full wording
// is pinned HOME-isolated in error-hardening.test.ts.
describe("status", () => {
  test("reports running-vs-not in plain English and tails both logs, exit 0", () => {
    const { stdout, status } = runCli(["status"]);
    expect(status).toBe(0);

    // The four-line checklist opens the output, so "am I set up right?"
    // is answered before anything scrolls. The very first non-empty line is the Key
    // row; every row is present, in order.
    const firstLine = stdout.split("\n").find((line) => line.trim().length > 0);
    expect(firstLine).toBeDefined();
    expect(firstLine).toMatch(/^ {2}Key: {9}/);
    for (const label of ["Meter:", "Claude Code:", "Codex:"]) {
      expect(stdout).toContain(`  ${label}`);
    }

    // The version still prints just below the checklist, says the build came from
    // source, and never points at a registry.
    expect(stdout).toContain(`CCC version ${PACKAGE_VERSION}, built from source.`);
    expect(stdout).not.toMatch(/@latest|npx @marginfront/);

    // Exactly one of the sanctioned Meter lines appears. The last alternative is the
    // one a Linux host (this suite's ubuntu lane) reads: there is no service manager
    // there, so `status` reports that instead of asking one and crashing.
    expect(stdout).toMatch(
      / {2}Meter: {7}(OK\. The background meter is running\. Your spend is being captured\.|ACTION NEEDED\. Not running\. Run: node .* start|Waiting for your key\. After you save one, run: node .* start|Installed but not running right now\. Wait a minute, then run status again\.|PROBLEM\. The meter keeps stopping right after it starts\. See below\.|There's no background meter on \w+ yet\. Nothing's counting your spend right now\. Meter it in a terminal: node .* run)/,
    );

    // The log tails are labeled optional, so a reader knows where to stop reading.
    expect(stdout).toContain("Optional detail, for the curious:");

    // Both log tails always print (this is what a stuck user reads to self-diagnose).
    expect(stdout).toContain("Recent output (");
    expect(stdout).toContain("Recent errors (");
  });
});

// ===========================================================================
// stop (stopForwarderThenStopCollector - the engine behind cmdStop)
// ===========================================================================
// A PID-liveness check via process.kill(pid, 0): once the OS has reaped the child,
// this throws ESRCH and isPidAlive returns false. We use the child's own 'exit'
// event as the ground-truth liveness signal to avoid the zombie-reaping window.

// ===========================================================================
// stop (stopForwarderThenStopCollector - the engine behind cmdStop)
// ===========================================================================
// THE LADDER: ask the forwarder to stop, wait for it to actually go, and only force
// it down if it won't. What the polite rung buys is an ORDERLY TEARDOWN - the process
// runs its own shutdown code (timer cleared, pidfile released, the collector it
// started stopped) and exits 0. It is NOT a flush; forwarder.ts has no flush or drain
// entry point. So these tests assert the TEARDOWN happened, not the name of a signal.
//
// That distinction is the whole reason they read this way. On macOS and Linux the
// polite rung is SIGTERM. On Windows there is no SIGTERM: Node maps it to
// TerminateProcess, so a test that asserted "it died from SIGTERM" would pass on
// Windows while proving the opposite of what we need - that the forwarder was shot
// where it stood. The polite rung there is the request file in connector.ts. Both
// tests therefore call the PRODUCTION dispatcher, signalForwarderStop, and assert the
// user-visible outcome: on a polite stop the forwarder tore itself down; on a forced
// one it did not.
//
// The stand-in forwarder is a REAL child process (test/helpers/stand-in-forwarder.ts)
// that reads the mailbox with the REAL reader, so a broken reader fails here.
describe("stop", () => {
  // Spawn the stand-in and wait until it says its shutdown path is wired.
  async function spawnStandInForwarder(
    mode: "obey" | "wedged",
    teardownMarkerPath: string,
    shutdownRequestPath: string,
  ): Promise<{
    pid: number;
    exited: () => boolean;
    exitCode: () => number | null;
    exitSignal: () => NodeJS.Signals | null;
    kill: () => void;
  }> {
    const child = spawn(
      process.execPath,
      [
        "--import",
        TS_HOOK_URL,
        STAND_IN_FORWARDER,
        teardownMarkerPath,
        shutdownRequestPath,
        mode,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    child.on("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
    });
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.stdout!.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("ready")) resolve();
      });
    });
    return {
      pid: child.pid as number,
      exited: () => exited,
      exitCode: () => exitCode,
      exitSignal: () => exitSignal,
      kill: () => {
        if (!exited) child.kill("SIGKILL");
      },
    };
  }

  // NON-VACUOUS: if stop stopped asking (or asked but never waited), the real child
  // stays alive and `exited` stays false. If the polite rung stopped reaching the
  // forwarder - the Windows case - the child would be forced
  // down instead and the teardown marker would be missing. If the collector were
  // stopped BEFORE the forwarder was gone, aliveWhenCollectorStopped would be true. A
  // spy that "always returns true" cannot pass this.
  test("a polite stop really terminates a live forwarder AND lets it tear itself down; collector stopped only after it's gone; pidfile guard then clears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-stop-"));
    const teardownMarkerPath = join(dir, "torn-down");
    const shutdownRequestPath = join(dir, "shutdown.request");
    const child = await spawnStandInForwarder(
      "obey",
      teardownMarkerPath,
      shutdownRequestPath,
    );
    expect(isPidAlive(child.pid)).toBe(true); // premise: the forwarder is really up

    // A real temp pidfile, exactly as `run` would have left behind.
    const pidPath = join(dir, "forwarder.pid");
    writeFileSync(pidPath, String(child.pid));
    // While alive, the single-instance guard sees it -> a second `run` is blocked.
    expect(runningForwarderPid(pidPath)).toBe(child.pid);

    const signals: Array<"SIGTERM" | "SIGKILL"> = [];
    let aliveWhenCollectorStopped: boolean | null = null;

    const deps: StopDeps = {
      isForwarderAlive: () => !child.exited(), // REAL liveness, from the real exit event
      signalForwarder: (signal) => {
        signals.push(signal);
        // The PRODUCTION dispatcher, not a copy of it: SIGTERM on POSIX, the mailbox
        // on Windows. If that dispatch is wrong, this test cannot pass.
        signalForwarderStop(child.pid, signal, { shutdownRequestPath });
      },
      stopCollector: () => {
        aliveWhenCollectorStopped = !child.exited();
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      log: () => {},
    };

    try {
      await stopForwarderThenStopCollector(deps, 25, 5000);

      expect(signals).toEqual(["SIGTERM"]); // polite shutdown: no force needed
      expect(child.exited()).toBe(true); // REAL effect: the process actually stopped
      // THE ASSERTION THAT MATTERS: it did not just die, it shut itself down. On a
      // hard kill this file is never written and its collector is left orphaned.
      expect(existsSync(teardownMarkerPath)).toBe(true);
      expect(child.exitCode()).toBe(0); // a clean exit, not a termination
      expect(aliveWhenCollectorStopped).toBe(false); // collector stopped only after

      // The pidfile-clearing CONTRACT: with the forwarder truly gone, the guard now
      // reads the pidfile as clear, so the next `run` starts clean (cmdStop also rm's
      // the file outright; see the file header for why that exact line is out of unit
      // scope). This is what "stop clears the pidfile" means to the user.
      expect(runningForwarderPid(pidPath)).toBeNull();
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // NON-VACUOUS: if the escalation to SIGKILL were removed, a forwarder that ignores
  // the polite rung would never die and `exited` would stay false. A fake that flipped
  // on the first signal could NOT catch this - only a real process that genuinely
  // ignores the polite rung does.
  test("a wedged forwarder that ignores the polite stop is escalated to a hard kill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-stop-wedged-"));
    const teardownMarkerPath = join(dir, "torn-down");
    const shutdownRequestPath = join(dir, "shutdown.request");
    const child = await spawnStandInForwarder(
      "wedged",
      teardownMarkerPath,
      shutdownRequestPath,
    );

    const signals: Array<"SIGTERM" | "SIGKILL"> = [];
    let aliveWhenCollectorStopped: boolean | null = null;

    const deps: StopDeps = {
      isForwarderAlive: () => !child.exited(),
      signalForwarder: (signal) => {
        signals.push(signal);
        signalForwarderStop(child.pid, signal, { shutdownRequestPath });
      },
      stopCollector: () => {
        aliveWhenCollectorStopped = !child.exited();
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      log: () => {},
    };

    try {
      // Short grace period so the polite wait expires quickly and we escalate.
      await stopForwarderThenStopCollector(deps, 25, 600);

      expect(signals).toEqual(["SIGTERM", "SIGKILL"]); // escalated, in order
      expect(child.exited()).toBe(true); // REAL effect: the hard kill took it down
      // A forced kill is meant to be brutal: no shutdown handler, no teardown. This is
      // the negative control for the assertion in the test above - if the marker
      // turned up here too, that one would be proving nothing.
      expect(existsSync(teardownMarkerPath)).toBe(false);
      expect(aliveWhenCollectorStopped).toBe(false); // collector still last
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // POSIX ONLY, and deliberately so: this pins that the two rungs are still real
  // SIGNALS where signals exist. Windows has no equivalent to assert - that is the
  // whole reason the two tests above assert on the teardown instead.
  test.skipIf(process.platform === "win32")(
    "on POSIX the two rungs are the signals they claim to be",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "ccc-stop-signals-"));
      const shutdownRequestPath = join(dir, "shutdown.request");
      try {
        // A bare child with NO handler: SIGTERM's default action terminates it, so
        // seeing exitSignal === SIGTERM proves a real signal was delivered.
        const polite = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          { stdio: "ignore" },
        );
        const politeExit = new Promise<NodeJS.Signals | null>((resolve) => {
          polite.on("exit", (_code, signal) => resolve(signal));
        });
        await new Promise<void>((resolve, reject) => {
          polite.on("spawn", () => resolve());
          polite.on("error", reject);
        });
        signalForwarderStop(polite.pid as number, "SIGTERM", {
          shutdownRequestPath,
        });
        expect(await politeExit).toBe("SIGTERM");
        // The polite rung must NOT have left a mailbox file behind on POSIX - that
        // path belongs to Windows alone.
        expect(existsSync(shutdownRequestPath)).toBe(false);

        // And the forced rung is a real SIGKILL, which cannot be trapped.
        const wedged = spawn(
          process.execPath,
          ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
          { stdio: "ignore" },
        );
        const wedgedExit = new Promise<NodeJS.Signals | null>((resolve) => {
          wedged.on("exit", (_code, signal) => resolve(signal));
        });
        await new Promise<void>((resolve, reject) => {
          wedged.on("spawn", () => resolve());
          wedged.on("error", reject);
        });
        signalForwarderStop(wedged.pid as number, "SIGKILL", {
          shutdownRequestPath,
        });
        expect(await wedgedExit).toBe("SIGKILL");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
