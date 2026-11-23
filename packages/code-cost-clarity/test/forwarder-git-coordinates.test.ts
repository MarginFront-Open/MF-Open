// forwarder-git-coordinates.test.ts
// ---------------------------------------------------------------------------
// Proves the three metadata builders (Claude tokens, Codex tokens, tool calls) stamp
// {repo, branch, commitSha} into metadata when the injected resolver returns them, and
// omit the keys entirely when it returns null (the honest no-PR bucket). The resolver
// is injected exactly like the live watcher injects it - the builders stay pure.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import {
  buildMarginFrontRequestBody,
  buildCodexRequestBody,
  buildToolUsageRecords,
} from "../src/forwarder";
import type { GitCoordinates, ParsedOtlp } from "../src/types";

const COORDS: GitCoordinates = {
  repo: "acme/widgets",
  branch: "feature/x",
  commitSha: "c".repeat(40),
};

// --- Minimal OTLP fixtures for each builder ---------------------------------

function claudeMetrics(sessionId: string): ParsedOtlp {
  const dp = (type: string, value: number) => ({
    attributes: [
      { key: "user.email", value: { stringValue: "dev@example.com" } },
      { key: "model", value: { stringValue: "claude-sonnet-4-6" } },
      { key: "session.id", value: { stringValue: sessionId } },
      { key: "type", value: { stringValue: type } },
    ],
    asDouble: value,
  });
  return {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.token.usage",
                sum: { dataPoints: [dp("input", 100), dp("output", 50)] },
              },
            ],
          },
        ],
      },
    ],
  };
}

function codexLogs(sessionId: string): ParsedOtlp {
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                body: { stringValue: "codex.sse_event" },
                attributes: [
                  {
                    key: "event.name",
                    value: { stringValue: "codex.sse_event" },
                  },
                  {
                    key: "user.email",
                    value: { stringValue: "dev@example.com" },
                  },
                  { key: "model", value: { stringValue: "gpt-5-codex" } },
                  { key: "session.id", value: { stringValue: sessionId } },
                  { key: "input_token_count", value: { intValue: "100" } },
                  { key: "output_token_count", value: { intValue: "50" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function toolLogs(sessionId: string): ParsedOtlp {
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                body: { stringValue: "tool_result" },
                attributes: [
                  { key: "event.name", value: { stringValue: "tool_result" } },
                  {
                    key: "user.email",
                    value: { stringValue: "dev@example.com" },
                  },
                  { key: "session.id", value: { stringValue: sessionId } },
                  { key: "tool_name", value: { stringValue: "Bash" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

const BUILDERS: Array<
  [
    string,
    (sessionId: string) => ParsedOtlp,
    (
      p: ParsedOtlp,
      o: object,
    ) => { records: Array<{ metadata: Record<string, unknown> }> },
  ]
> = [
  ["Claude tokens", claudeMetrics, buildMarginFrontRequestBody as never],
  ["Codex tokens", codexLogs, buildCodexRequestBody as never],
  ["tool calls", toolLogs, buildToolUsageRecords as never],
];

describe("metadata builders stamp git coordinates", () => {
  it.each(BUILDERS)(
    "%s: stamps repo/branch/commitSha when the resolver returns them",
    (_label, fixture, build) => {
      const resolveGitCoordinates = vi.fn().mockReturnValue(COORDS);
      const { records } = build(fixture("sess-1"), { resolveGitCoordinates });
      expect(records).toHaveLength(1);
      expect(records[0].metadata).toMatchObject({
        repo: "acme/widgets",
        branch: "feature/x",
        commitSha: "c".repeat(40),
      });
      expect(resolveGitCoordinates).toHaveBeenCalledWith("sess-1");
    },
  );

  it.each(BUILDERS)(
    "%s: omits the keys entirely when the resolver returns null",
    (_label, fixture, build) => {
      const resolveGitCoordinates = vi.fn().mockReturnValue(null);
      const { records } = build(fixture("sess-1"), { resolveGitCoordinates });
      expect(records).toHaveLength(1);
      expect(records[0].metadata).not.toHaveProperty("repo");
      expect(records[0].metadata).not.toHaveProperty("branch");
      expect(records[0].metadata).not.toHaveProperty("commitSha");
    },
  );

  it.each(BUILDERS)(
    "%s: omits the keys when no resolver is injected (preview / one-shot send)",
    (_label, fixture, build) => {
      const { records } = build(fixture("sess-1"), {});
      expect(records).toHaveLength(1);
      expect(records[0].metadata).not.toHaveProperty("repo");
    },
  );

  it("passes a partial tuple (repo=null) straight through", () => {
    const resolveGitCoordinates = vi.fn().mockReturnValue({
      repo: null,
      branch: "main",
      commitSha: "d".repeat(40),
    });
    const { records } = buildMarginFrontRequestBody(claudeMetrics("s"), {
      resolveGitCoordinates,
    });
    expect(records[0].metadata).toMatchObject({
      repo: null,
      branch: "main",
      commitSha: "d".repeat(40),
    });
  });
});
