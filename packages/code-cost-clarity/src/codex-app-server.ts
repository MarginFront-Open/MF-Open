// codex-app-server.ts - the two read-only questions we ask the Codex CLI.
//
// There is no `codex hooks list` command. The only machine-readable way to learn
// whether Codex actually registered a hook - and whether it trusts it - is the
// app-server's JSON-RPC method `hooks/list`, spoken over the process's stdin and
// stdout. Config health has its own door: `codex doctor --json`.
//
// Everything here is READ-ONLY and best-effort. Codex missing, a hung process, a
// response we don't recognise: all of it comes back as an honest "unknown", never a
// throw and never a guess. Two callers need this - the daemon's self-heal and the
// status command - so it lives on its own.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import {
  planBinaryLaunch,
  stopLaunchedProcess,
  type BinaryLaunch,
  type StopLaunchedOptions,
} from "./binary-path";

// Codex's own record of one registered hook, as `hooks/list` reports it. The two
// fields that matter most:
//   enabled     - the hook is switched on
//   trustStatus - the developer has reviewed it in /hooks
// They are INDEPENDENT. A hook can be enabled:true and trustStatus:"untrusted" at
// the same time, and in that state Codex skips it silently. Anything that reports
// "armed" must key off trustStatus, never off enabled.
export interface CodexListedHook {
  key: string;
  eventName: string;
  command: string;
  matcher: string | null;
  // Codex echoes back the statusMessage from the hook entry. It is how we still
  // recognise our own hook after someone edits its command string - the command is
  // no longer ours, but the label still is.
  statusMessage: string | null;
  source: string;
  enabled: boolean;
  isManaged: boolean;
  currentHash: string | null;
  trustStatus: string;
}

export interface CodexHooksListResult {
  ok: boolean;
  // Why we have no answer. "codex-missing" and "timeout" both mean "we don't know",
  // and callers must never round that up to "armed".
  reason?: "codex-missing" | "timeout" | "bad-response";
  hooks: CodexListedHook[];
  // Codex's own complaints about hook FILES it could not read (e.g. "failed to parse
  // hooks config /path/hooks.json: ..."). This is how a bad hooks.json shows up.
  warnings: string[];
  // Codex's own complaints about loading config.toml.
  errors: string[];
}

const EMPTY: CodexHooksListResult = {
  ok: false,
  hooks: [],
  warnings: [],
  errors: [],
};

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseListedHook(raw: unknown): CodexListedHook | null {
  if (typeof raw !== "object" || raw === null) return null;
  const h = raw as Record<string, unknown>;
  const key = asString(h.key);
  const command = asString(h.command);
  if (key === null || command === null) return null;
  return {
    key,
    eventName: asString(h.eventName) ?? "",
    command,
    matcher: asString(h.matcher),
    statusMessage: asString(h.statusMessage),
    source: asString(h.source) ?? "",
    enabled: h.enabled === true,
    isManaged: h.isManaged === true,
    currentHash: asString(h.currentHash),
    trustStatus: asString(h.trustStatus) ?? "unknown",
  };
}

export interface CodexHooksListOptions {
  codexBin?: string;
  // Codex resolves hooks per working directory, so we have to name one.
  cwd?: string;
  timeoutMs?: number;
  // Test seam. Defaults to a real `codex app-server` child process.
  spawnImpl?: typeof spawn;
  env?: NodeJS.ProcessEnv;
}

// Ask Codex what hooks it has registered for `cwd`.
//
// The handshake is three messages on stdin: initialize, then initialized, then
// hooks/list. We read newline-delimited JSON off stdout until the hooks/list reply
// arrives, then kill the child - we never leave an app-server running.
export function codexHooksList({
  codexBin = "codex",
  cwd = process.cwd(),
  timeoutMs = 20_000,
  spawnImpl = spawn,
  env = process.env,
}: CodexHooksListOptions = {}): Promise<CodexHooksListResult> {
  return new Promise((resolve) => {
    let child;
    // An npm-installed Codex is codex.cmd, which CreateProcess will not run
    const launch = planBinaryLaunch(codexBin, ["app-server"], { env });
    try {
      child = spawnImpl(launch.command, launch.args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
    } catch {
      resolve({ ...EMPTY, reason: "codex-missing" });
      return;
    }

    let settled = false;
    let buffer = "";
    const finish = (result: CodexHooksListResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releaseAppServer(child, launch);
      resolve(result);
    };
    // unref'd: the child's own handles keep the loop alive while it is running, so
    // this still fires on a hung app-server, and it can never outlive the command.
    const timer = setTimeout(
      () => finish({ ...EMPTY, reason: "timeout" }),
      timeoutMs,
    );
    timer.unref();

    // Nothing reads stderr. Left unread, a chatty app-server fills the pipe and
    // blocks; left open, it is one more handle the command has to wait on.
    child.stderr?.resume();

    const send = (message: unknown): void => {
      try {
        child.stdin?.write(JSON.stringify(message) + "\n");
      } catch {
        finish({ ...EMPTY, reason: "bad-response" });
      }
    };

    child.on("error", () => finish({ ...EMPTY, reason: "codex-missing" }));
    child.on("exit", () => finish({ ...EMPTY, reason: "bad-response" }));

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // Not our line. Codex is free to print whatever it likes.
        }
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "hooks/list",
            params: { cwd },
          });
          continue;
        }
        if (message.id !== 2) continue;

        const result = message.result as Record<string, unknown> | undefined;
        const data = result?.data;
        if (!Array.isArray(data)) {
          finish({ ...EMPTY, reason: "bad-response" });
          return;
        }
        const hooks: CodexListedHook[] = [];
        const warnings: string[] = [];
        const errors: string[] = [];
        for (const scope of data) {
          if (typeof scope !== "object" || scope === null) continue;
          const s = scope as Record<string, unknown>;
          for (const raw of Array.isArray(s.hooks) ? s.hooks : []) {
            const parsed = parseListedHook(raw);
            if (parsed) hooks.push(parsed);
          }
          for (const w of Array.isArray(s.warnings) ? s.warnings : []) {
            if (typeof w === "string") warnings.push(w);
          }
          for (const e of Array.isArray(s.errors) ? s.errors : []) {
            if (typeof e === "string") errors.push(e);
            else if (typeof e === "object" && e !== null) {
              const message2 = (e as Record<string, unknown>).message;
              if (typeof message2 === "string") errors.push(message2);
            }
          }
        }
        finish({ ok: true, hooks, warnings, errors });
        return;
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "marginfront-code-cost-clarity",
          title: "MarginFront Code Cost Control",
          version: "1",
        },
      },
    });
  });
}

// Closed before the caller gets its answer, so a short command like status has
// nothing left holding the event loop open once it returns.
//
// On Windows the child we hold can be the cmd.exe that started Codex, so `launch` is
// what tells stopLaunchedProcess to take the tree and not orphan it.
export function releaseAppServer(
  child: ChildProcess,
  launch: BinaryLaunch,
  stopOptions: StopLaunchedOptions = {},
): void {
  try {
    child.stdin?.end();
  } catch {
    // Already closed.
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  stopLaunchedProcess(child, launch, stopOptions);
}

export interface CodexConfigLoadResult {
  // "ok"      - Codex read its config.toml fine.
  // "failed"  - Codex could NOT read it. Every Codex session is broken until it's fixed.
  // "unknown" - we could not ask (no codex on this machine, or it never answered).
  status: "ok" | "failed" | "unknown";
  summary: string | null;
}

export interface CodexDoctorOptions {
  codexBin?: string;
  timeoutMs?: number;
  // Test seam. Defaults to a real `codex doctor --json` child process.
  execFileImpl?: typeof execFile;
  env?: NodeJS.ProcessEnv;
}

// Ask Codex whether it can still load its own config.toml.
//
// `codex doctor --json` exits non-zero whenever ANY check fails (a missing login
// counts), so the exit code tells us nothing. The answer we want is one field:
// checks["config.load"].status.
export function codexDoctorConfigLoad({
  codexBin = "codex",
  timeoutMs = 30_000,
  execFileImpl = execFile,
  env = process.env,
}: CodexDoctorOptions = {}): Promise<CodexConfigLoadResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CodexConfigLoadResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const launch = planBinaryLaunch(codexBin, ["doctor", "--json"], { env });
    try {
      execFileImpl(
        launch.command,
        launch.args,
        {
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          env,
          windowsVerbatimArguments: launch.windowsVerbatimArguments,
        },
        (_err, stdout) => {
          let report: Record<string, unknown>;
          try {
            report = JSON.parse(String(stdout)) as Record<string, unknown>;
          } catch {
            finish({ status: "unknown", summary: null });
            return;
          }
          const checks = report.checks as Record<string, unknown> | undefined;
          const check = checks?.["config.load"] as
            | Record<string, unknown>
            | undefined;
          const status = asString(check?.status);
          const summary = asString(check?.summary);
          if (status === "ok") {
            finish({ status: "ok", summary });
            return;
          }
          if (status === null) {
            finish({ status: "unknown", summary: null });
            return;
          }
          finish({ status: "failed", summary });
        },
      );
    } catch {
      finish({ status: "unknown", summary: null });
    }
  });
}
