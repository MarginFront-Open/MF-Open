// collector-drops-content.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS PROVES, and why a YAML assertion could not: the capture file on the
// user's disk holds none of their prompt text, the model's reply, a tool call's
// input, or - for a shell call - the second copy of the command that rides in
// tool_parameters. Claude Code sends all of them as OTel log attributes, and the file
// exporter writes every attribute it is handed, so without the attributes processors
// they land in ~/.marginfront-ccc/live-otlp.jsonl in the clear. A test that only
// greps the rendered config would stay green if a processor name were misspelled, if
// the collector dropped the component as unknown, if "delete" did not mean what we
// think on a log record, or if the exclude rule that spares MCP records did not match
// the way we read the docs - all of which are the collector's behavior, not ours.
//
// So this runs the REAL collector binary against the REAL rendered config: two OTLP
// log records in over HTTP, the written lines read back off disk. The second record is
// the carve-out: an MCP call has to come out the far side still carrying its server
// and tool names, which live nowhere but tool_parameters.
//
// WHAT IT TOUCHES: it READS the binary already installed on this machine and runs it
// from a temp directory, on ports nothing else is using, writing to a temp capture
// file. Nothing under the real ~/.marginfront-ccc is written, and no copy of the
// 360 MB binary is made. With no binary installed there is nothing to run and the
// test skips with a note saying so.
// ---------------------------------------------------------------------------

import { test, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { collectorBinaryName, renderCollectorYaml } from "../src/connector";

// The connector builds COLLECTOR_BIN_PATH from homedir(), and the suite runs on a
// throwaway HOME, so the constant points at an empty temp directory here. userInfo()
// reads the account's own home from the OS rather than $HOME, which is how this finds
// the install that actually exists on the machine.
const realCollectorPath = join(
  userInfo().homedir,
  ".marginfront-ccc",
  collectorBinaryName(),
);
const collectorInstalled = existsSync(realCollectorPath);

if (!collectorInstalled) {
  console.log(
    [
      "SKIPPED: the live-capture test needs an OpenTelemetry collector binary and",
      `there is none at ${realCollectorPath}.`,
      "Run `node ~/.marginfront-ccc/cli.js init` on this machine to download one,",
      "then run this file again. The rendered-config tests in connector.test.ts still",
      "cover the processor itself.",
    ].join("\n"),
  );
}

// A port nothing is listening on right now. Asking the OS for one and handing it
// straight over is the standard race, and the alternative - the real 4317/4318 - is a
// guaranteed collision with the meter running on this machine.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Two Claude-Code-shaped tool events. The Bash one carries everything that must not
// reach the disk - the command's second copy inside tool_parameters included, which a
// tool_input drop alone would miss - plus the two that have to survive
// (tool_name prices the call; input_tokens stands in for every usage number). The MCP
// one is the carve-out: its tool_parameters holds the only copy of the real names.
const SECRET_PROMPT = "PROMPT-CANARY refactor the billing service for me";
const SECRET_RESPONSE =
  "RESPONSE-CANARY here is the refactored billing service";
const SECRET_TOOL_INPUT = 'TOOL-INPUT-CANARY {"file_path":"/etc/passwd"}';
const SECRET_FULL_COMMAND =
  "FULL-COMMAND-CANARY cat /etc/passwd && cat ~/.ssh/id_rsa";

const BASH_TOOL_PARAMETERS = JSON.stringify({
  full_command: SECRET_FULL_COMMAND,
  description: "read a file",
});
const MCP_TOOL_PARAMETERS = JSON.stringify({
  mcp_server_name: "linear-team",
  mcp_tool_name: "list_issues",
});

function attribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function twoLogRecords(): string {
  const now = String(Date.now() * 1_000_000);
  return JSON.stringify({
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "claude-code" } },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: now,
                body: { stringValue: "claude_code.tool_result" },
                attributes: [
                  attribute("prompt", SECRET_PROMPT),
                  attribute("response", SECRET_RESPONSE),
                  attribute("tool_input", SECRET_TOOL_INPUT),
                  attribute("tool_parameters", BASH_TOOL_PARAMETERS),
                  attribute("tool_name", "Bash"),
                  { key: "input_tokens", value: { intValue: "4242" } },
                ],
              },
              {
                timeUnixNano: now,
                body: { stringValue: "claude_code.tool_result" },
                attributes: [
                  attribute("tool_parameters", MCP_TOOL_PARAMETERS),
                  attribute("tool_name", "mcp_tool"),
                  { key: "input_tokens", value: { intValue: "1717" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

// The receiver is not up the moment the process is, so the POST is the readiness
// check: retry until one is accepted or the deadline passes.
async function postUntilAccepted(
  url: string,
  body: string,
  deadlineMs: number,
): Promise<number> {
  let lastProblem = "never attempted";
  while (Date.now() < deadlineMs) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (response.ok) return response.status;
      lastProblem = `HTTP ${response.status}`;
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  throw new Error(`the collector never accepted a record: ${lastProblem}`);
}

// One written log record, flattened: attribute key -> the JSON of its value. Keeping
// the value as text lets one assertion cover both the key and what is inside it.
interface WrittenRecord {
  keys: string[];
  values: Record<string, string>;
}

// Every log record in the file, however deeply the exporter nested it, so a
// re-nesting cannot hide one from the assertions below.
function writtenRecords(text: string): WrittenRecord[] {
  const records: WrittenRecord[] = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) collect(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    if (Array.isArray(object.logRecords)) {
      for (const raw of object.logRecords) {
        const attributes = (raw as { attributes?: unknown }).attributes;
        const record: WrittenRecord = { keys: [], values: {} };
        if (Array.isArray(attributes)) {
          for (const attribute of attributes) {
            const { key, value } = attribute as {
              key?: unknown;
              value?: unknown;
            };
            if (typeof key !== "string") continue;
            record.keys.push(key);
            record.values[key] = JSON.stringify(value);
          }
        }
        records.push(record);
      }
    }
    for (const value of Object.values(object)) collect(value);
  };
  for (const line of text.trim().split("\n")) collect(JSON.parse(line));
  return records;
}

// Both records may arrive on one batched line or on two, and a read can catch the
// file mid-write, so the wait is for a parseable file holding the expected count.
async function readWhenRecordsWritten(
  path: string,
  howMany: number,
  deadlineMs: number,
): Promise<{ text: string; records: WrittenRecord[] }> {
  let lastProblem = "nothing was written";
  while (Date.now() < deadlineMs) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      if (text.trim().length > 0) {
        try {
          const records = writtenRecords(text);
          if (records.length >= howMany) return { text, records };
          lastProblem = `only ${records.length} of ${howMany} records so far`;
        } catch (error) {
          lastProblem = error instanceof Error ? error.message : String(error);
        }
      }
    }
    await sleep(100);
  }
  throw new Error(
    `the collector never wrote ${howMany} records to ${path}: ${lastProblem}`,
  );
}

test.skipIf(!collectorInstalled)(
  "the real collector writes capture lines with no prompt, reply, tool input or shell command, and an MCP call still carrying its two names",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-collector-drop-"));
    const capturePath = join(dir, "live-otlp.jsonl");
    const configPath = join(dir, "otel-collector.yaml");
    const httpPort = await freePort();
    const grpcPort = await freePort();

    // The config we ship, with three collisions with the meter already running on this
    // machine taken out: its two OTLP ports, and the collector's own Prometheus
    // endpoint, which defaults to localhost:8888 and refuses to start a second time.
    // Everything else, the processors and the pipelines included, is the real template.
    const yaml = renderCollectorYaml(capturePath)
      .replace("127.0.0.1:4317", `127.0.0.1:${grpcPort}`)
      .replace("127.0.0.1:4318", `127.0.0.1:${httpPort}`)
      .replace(
        "  telemetry:\n",
        "  telemetry:\n    metrics:\n      level: none\n",
      );
    writeFileSync(configPath, yaml);

    const collector = spawn(realCollectorPath, ["--config", configPath], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let collectorOutput = "";
    collector.stdout.on("data", (c: Buffer) => (collectorOutput += c));
    collector.stderr.on("data", (c: Buffer) => (collectorOutput += c));
    const exited = new Promise<void>((resolve) =>
      collector.on("exit", () => resolve()),
    );

    try {
      const deadline = Date.now() + 30_000;
      await postUntilAccepted(
        `http://127.0.0.1:${httpPort}/v1/logs`,
        twoLogRecords(),
        deadline,
      );
      const { text, records } = await readWhenRecordsWritten(
        capturePath,
        2,
        deadline,
      );

      // Values and all, so a rename or a re-nesting cannot hide one.
      expect(text).not.toContain("PROMPT-CANARY");
      expect(text).not.toContain("RESPONSE-CANARY");
      expect(text).not.toContain("TOOL-INPUT-CANARY");
      expect(text).not.toContain("FULL-COMMAND-CANARY");

      const bash = records.find((record) =>
        (record.values.tool_name ?? "").includes("Bash"),
      );
      expect(bash, "the Bash record never reached the file").toBeDefined();
      // THE POINT: the content attributes are gone from the file, tool_parameters -
      // which held the whole command line a second time - with them...
      expect(bash!.keys).not.toContain("prompt");
      expect(bash!.keys).not.toContain("response");
      expect(bash!.keys).not.toContain("tool_input");
      expect(bash!.keys).not.toContain("tool_parameters");
      // ...and the record is still worth having: the two attributes the forwarder
      // bills from survived the same processors.
      expect(bash!.keys).toContain("tool_name");
      expect(bash!.keys).toContain("input_tokens");
      expect(text).toContain("4242");

      // THE CARVE-OUT: an MCP call keeps tool_parameters, because it is the only place
      // the server and tool it really called are written down. Lose it and every MCP
      // tool on the bill collapses into one unnamed "mcp_tool" line.
      const mcp = records.find((record) =>
        (record.values.tool_name ?? "").includes("mcp_tool"),
      );
      expect(mcp, "the MCP record never reached the file").toBeDefined();
      expect(mcp!.keys).toContain("tool_parameters");
      expect(mcp!.values.tool_parameters).toContain("linear-team");
      expect(mcp!.values.tool_parameters).toContain("list_issues");
      expect(mcp!.keys).toContain("tool_name");
      expect(mcp!.keys).toContain("input_tokens");
      expect(text).toContain("1717");
    } finally {
      collector.kill("SIGTERM");
      await Promise.race([exited, sleep(5_000)]);
      if (collector.exitCode === null && collector.signalCode === null) {
        collector.kill("SIGKILL");
      }
      // Only on a failure does anyone want the collector's own output, and a failed
      // assertion above prints before this runs.
      if (process.env.CCC_TEST_SHOW_COLLECTOR_LOG === "1") {
        console.log(collectorOutput);
      }
    }
  },
  60_000,
);
