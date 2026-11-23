// done-command.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: `code-cost-clarity done "<what you finished>" [count]`
// sends ONE record through the key, transport and queue the meter already uses, and
// refuses rather than guesses whenever it cannot answer one of the two questions the
// ROI page will ask of the row: WHOSE work is this, and WHICH assistant's column
// does it belong in.
//
// The exit codes carry one meaning each and the tests hold them to it:
//   0 = it is counted (sent, or safely on disk for the meter to send)
//   2 = nothing was counted, anywhere
// ---------------------------------------------------------------------------

import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdDone, resolveDoneAgent } from "../src/cli";
import type { DoneDeps } from "../src/cli";
import type { IgnoredRepos, WorkId } from "../src/forwarder";
import type { PostResult } from "../src/types";

const SENT: PostResult = { ok: true, parsed: null, body: "{}" };
const OFFLINE: PostResult = {
  ok: false,
  reason: "network",
  message: "ENOTFOUND",
};
const REFUSED_BY_SERVER: PostResult = {
  ok: false,
  reason: "http",
  status: 400,
  body: "bad request",
};
const DEAD_KEY: PostResult = {
  ok: false,
  reason: "http",
  status: 401,
  body: "unauthorized",
};

function harness(overrides: Partial<DoneDeps> = {}) {
  const lines: string[] = [];
  const errors: string[] = [];
  const posted: unknown[] = [];
  const queued: unknown[] = [];
  const deps = {
    loadEnv: () => ({
      MARGINFRONT_API_KEY: "mf_sk_test",
      CCC_DEVELOPER_EMAIL: "dev@example.com",
    }),
    apiKeyInEnvironment: () => undefined,
    readWorkId: (): WorkId => ({ value: undefined }),
    // Stubbed for the same reason readWorkId is: the real reader reads the settings
    // file this machine actually has, and these cases are about `done` itself.
    ignoredRepos: (): IgnoredRepos => ({
      repos: new Set(),
      malformed: [],
      hostPrefixed: [],
    }),
    claudeInstalled: () => true,
    codexInstalled: () => false,
    lastAgentSeen: () => null,
    readGitCoordinates: () => null,
    now: () => new Date("2026-09-21T14:32:07.001Z"),
    post: async (body: unknown) => {
      posted.push(body);
      return SENT;
    },
    queue: (records: unknown[]) => {
      queued.push(...records);
    },
    isTTY: () => false,
    log: (message: string) => lines.push(message),
    errorLog: (message: string) => errors.push(message),
    ...overrides,
  };
  return {
    deps,
    lines,
    errors,
    posted,
    queued,
    out: () => lines.join("\n"),
    err: () => errors.join("\n"),
  };
}

describe("it sends one record, shaped the way the ROI page reads it", () => {
  test("one finished thing, one record, exit 0", async () => {
    const h = harness();
    const code = await cmdDone(["contract summarized"], h.deps);

    expect(code).toBe(0);
    expect(h.posted).toHaveLength(1);
    const body = h.posted[0] as { records: Record<string, unknown>[] };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({
      customerExternalId: "dev@example.com",
      agentCode: "claude-code",
      signalName: "contract summarized",
      model: "work-item",
      modelProvider: "outcome",
      quantity: 1,
      environment: "development",
    });
    expect(h.queued).toHaveLength(0);
  });

  test("the name is trimmed and collapsed, the count is taken as typed", async () => {
    const h = harness();
    await cmdDone(["  contract   summarized ", "4"], h.deps);
    const body = h.posted[0] as { records: Record<string, unknown>[] };
    expect(body.records[0].signalName).toBe("contract summarized");
    expect(body.records[0].quantity).toBe(4);
  });

  test("the work item in effect rides the record", async () => {
    const h = harness({
      readWorkId: (): WorkId => ({ value: "PROJ-123", key: "CCC_WORK_ID" }),
    });
    await cmdDone(["contract summarized"], h.deps);
    const body = h.posted[0] as {
      records: { metadata: Record<string, unknown> }[];
    };
    expect(body.records[0].metadata.matterId).toBe("PROJ-123");
  });

  test("git coordinates ride the record when the cwd is a repo", async () => {
    const h = harness({
      readGitCoordinates: () => ({
        repo: "example-org/platform",
        branch: "develop",
        commitSha: "abc123",
      }),
    });
    await cmdDone(["contract summarized"], h.deps);
    const body = h.posted[0] as {
      records: { metadata: Record<string, unknown> }[];
    };
    expect(body.records[0].metadata).toMatchObject({
      repo: "example-org/platform",
      branch: "develop",
    });
  });

  test("the record it sends carries no token key", async () => {
    const h = harness();
    await cmdDone(["contract summarized", "3"], h.deps);
    expect(JSON.stringify(h.posted[0])).not.toMatch(/token/i);
    expect(JSON.stringify(h.posted[0])).not.toMatch(/cost/i);
  });
});

describe("what it says when it worked", () => {
  test("with a work item set, it names the work item", async () => {
    const h = harness({
      readWorkId: (): WorkId => ({ value: "PROJ-123", key: "CCC_WORK_ID" }),
    });
    await cmdDone(["contract summarized"], h.deps);
    expect(h.out()).toContain(
      'Recorded "contract summarized" x1 for dev@example.com under work item PROJ-123.',
    );
  });

  test("with none set, it says so and names the command that sets one", async () => {
    const h = harness();
    await cmdDone(["contract summarized"], h.deps);
    expect(h.out()).toContain(
      'Recorded "contract summarized" x1 for dev@example.com with no work item set, so its AI cost is a share of everything your AI spent outside one. Run node ~/.marginfront-ccc/cli.js work "<name>" in your terminal first next time to narrow that to one piece of work.',
    );
  });
});

describe("it refuses rather than guesses", () => {
  test("no name: exit 2, nothing sent, and the line shows the shape", async () => {
    const h = harness();
    expect(await cmdDone([], h.deps)).toBe(2);
    expect(h.posted).toHaveLength(0);
    expect(h.queued).toHaveLength(0);
    expect(h.err()).toContain('done "contract summarized"');
  });

  test("a count that is not a whole number: exit 2, nothing sent", async () => {
    const h = harness();
    expect(await cmdDone(["contract summarized", "two"], h.deps)).toBe(2);
    expect(h.posted).toHaveLength(0);
  });

  test("no developer email anywhere: exit 2, nothing sent, one line naming the fix", async () => {
    const h = harness({
      loadEnv: () => ({ MARGINFRONT_API_KEY: "mf_sk_test" }),
    });
    expect(await cmdDone(["contract summarized"], h.deps)).toBe(2);
    expect(h.posted).toHaveLength(0);
    expect(h.queued).toHaveLength(0);
    expect(h.err()).toContain("init");
  });

  test("no key saved: exit 2, nothing sent", async () => {
    const h = harness({
      loadEnv: () => ({ CCC_DEVELOPER_EMAIL: "dev@example.com" }),
    });
    expect(await cmdDone(["contract summarized"], h.deps)).toBe(2);
    expect(h.posted).toHaveLength(0);
    expect(h.err()).toContain("init");
  });

  test("the server refuses the request: exit 2, and it says nothing was counted", async () => {
    const h = harness({ post: async () => REFUSED_BY_SERVER });
    expect(await cmdDone(["contract summarized"], h.deps)).toBe(2);
    expect(h.queued).toHaveLength(0);
    expect(h.err()).toContain("Nothing was counted");
  });
});

// The count and the spend have to land under ONE customerExternalId, or the ROI
// page shows the count with a permanent dash where its cost belongs. The daemon's
// second answer is the coding-agent login, which lives in telemetry `done` cannot
// read - and init offers exactly that blank state, so a git guess here is how the
// two come apart.
describe("the developer identity the meter already uses", () => {
  test("CCC_DEVELOPER_EMAIL wins", async () => {
    const h = harness({
      loadEnv: () => ({
        MARGINFRONT_API_KEY: "mf_sk_test",
        CCC_DEVELOPER_EMAIL: "chosen@example.com",
      }),
    });
    await cmdDone(["contract summarized"], h.deps);
    const body = h.posted[0] as { records: Record<string, unknown>[] };
    expect(body.records[0].customerExternalId).toBe("chosen@example.com");
  });

  // GIT_CONFIG_GLOBAL, not a mock: git really would hand back this address if
  // anything in cmdDone asked, on a laptop with an email set and on a bare runner.
  test("with it blank, nothing is counted and nothing is guessed from git", async () => {
    const gitConfigDir = mkdtempSync(join(tmpdir(), "ccc-done-git-"));
    const gitConfig = join(gitConfigDir, "gitconfig");
    writeFileSync(gitConfig, "[user]\n\temail = ghost@nowhere.invalid\n");
    const savedGitConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    try {
      const h = harness({
        loadEnv: () => ({
          MARGINFRONT_API_KEY: "mf_sk_test",
          CCC_DEVELOPER_EMAIL: "",
        }),
      });
      expect(await cmdDone(["contract summarized"], h.deps)).toBe(2);
      expect(h.posted).toHaveLength(0);
      expect(h.queued).toHaveLength(0);
      expect(h.err()).not.toContain("ghost@nowhere.invalid");
    } finally {
      if (savedGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = savedGitConfig;
      rmSync(gitConfigDir, { recursive: true, force: true });
    }
  });

  test("the refusal names init, and never offers git as the fix", async () => {
    const h = harness({
      loadEnv: () => ({
        MARGINFRONT_API_KEY: "mf_sk_test",
        CCC_DEVELOPER_EMAIL: "  ",
      }),
    });
    expect(await cmdDone(["contract summarized"], h.deps)).toBe(2);
    expect(h.err()).toContain("init");
    expect(h.err()).not.toContain("git config");
  });
});

describe("which assistant the row rolls up under", () => {
  test("the flag wins, in both spellings", () => {
    const both = {
      claudeInstalled: true,
      codexInstalled: true,
      lastSeen: "codex",
    };
    expect(resolveDoneAgent({ ...both, flag: "claude-code" })).toEqual({
      ok: true,
      agentCode: "claude-code",
    });
    expect(
      resolveDoneAgent({
        claudeInstalled: false,
        codexInstalled: false,
        lastSeen: null,
        flag: "codex",
      }),
    ).toEqual({ ok: true, agentCode: "codex" });
  });

  test("an unknown name on the flag is refused, never coerced", () => {
    expect(
      resolveDoneAgent({
        claudeInstalled: true,
        codexInstalled: false,
        lastSeen: null,
        flag: "cursor",
      }).ok,
    ).toBe(false);
  });

  test("only one installed: that one, no question asked", () => {
    expect(
      resolveDoneAgent({
        claudeInstalled: true,
        codexInstalled: false,
        lastSeen: null,
      }),
    ).toEqual({ ok: true, agentCode: "claude-code" });
    expect(
      resolveDoneAgent({
        claudeInstalled: false,
        codexInstalled: true,
        lastSeen: null,
      }),
    ).toEqual({ ok: true, agentCode: "codex" });
  });

  test("both installed: the one the meter last saw a record from", () => {
    expect(
      resolveDoneAgent({
        claudeInstalled: true,
        codexInstalled: true,
        lastSeen: "codex",
      }),
    ).toEqual({ ok: true, agentCode: "codex" });
    expect(
      resolveDoneAgent({
        claudeInstalled: true,
        codexInstalled: true,
        lastSeen: "claude-code",
      }),
    ).toEqual({ ok: true, agentCode: "claude-code" });
  });

  // The gap the rule does not name. Guessing would put the count in one assistant's
  // column and its cost in the other's, which is the exact lie this feature exists to
  // stop telling.
  test("both installed and no record seen yet: refused, not guessed", () => {
    expect(
      resolveDoneAgent({
        claudeInstalled: true,
        codexInstalled: true,
        lastSeen: null,
      }).ok,
    ).toBe(false);
  });

  test("neither installed: refused", () => {
    expect(
      resolveDoneAgent({
        claudeInstalled: false,
        codexInstalled: false,
        lastSeen: null,
      }).ok,
    ).toBe(false);
  });

  test("done refuses on an unresolvable assistant and names the flag", async () => {
    const h = harness({
      claudeInstalled: () => true,
      codexInstalled: () => true,
      lastAgentSeen: () => null,
    });
    expect(await cmdDone(["contract summarized"], h.deps)).toBe(2);
    expect(h.posted).toHaveLength(0);
    expect(h.err()).toContain("--agent");
  });

  // A trailing --agent must not fall through to auto-detection, which on a machine
  // with a last-seen record would file a typo under whichever assistant happened to
  // be working. Silently wrong is the one outcome this command may not have.
  test("--agent with nothing after it is refused, not ignored", async () => {
    for (const argv of [
      ["contract summarized", "--agent"],
      ["contract summarized", "--agent="],
    ]) {
      const h = harness({
        claudeInstalled: () => true,
        codexInstalled: () => true,
        lastAgentSeen: () => "codex",
      });
      expect(await cmdDone(argv, h.deps)).toBe(2);
      expect(h.posted).toHaveLength(0);
      expect(h.err()).toContain("--agent");
    }
  });

  test("done takes --agent in either spelling", async () => {
    for (const argv of [
      ["contract summarized", "--agent", "codex"],
      ["contract summarized", "--agent=codex"],
    ]) {
      const h = harness({
        claudeInstalled: () => true,
        codexInstalled: () => true,
        lastAgentSeen: () => "claude-code",
      });
      expect(await cmdDone(argv, h.deps)).toBe(0);
      const body = h.posted[0] as { records: Record<string, unknown>[] };
      expect(body.records[0].agentCode).toBe("codex");
    }
  });
});

describe("offline, it uses the same queue the turn records use", () => {
  test("a network failure parks the record and still exits 0", async () => {
    const h = harness({ post: async () => OFFLINE });
    expect(await cmdDone(["contract summarized"], h.deps)).toBe(0);
    expect(h.queued).toHaveLength(1);
    expect(h.out()).toContain("saved on this machine");
  });

  test("a dead key parks it too, so the count survives until the key is fixed", async () => {
    const h = harness({ post: async () => DEAD_KEY });
    expect(await cmdDone(["contract summarized"], h.deps)).toBe(0);
    expect(h.queued).toHaveLength(1);
  });

  // MarginFront WAS reached and refused the key. Saying "couldn't reach MarginFront"
  // there sends someone to check their wifi over a key they have to go replace.
  test("a dead key says the key is the problem, not the network", async () => {
    const h = harness({ post: async () => DEAD_KEY });
    await cmdDone(["contract summarized"], h.deps);
    expect(h.out()).toContain("isn't accepting your key");
    expect(h.out()).not.toContain("Couldn't reach MarginFront");
    expect(h.out()).toContain("init");
  });

  test("the parked record is the same record it tried to send", async () => {
    const h = harness({ post: async () => OFFLINE });
    await cmdDone(["contract summarized", "2"], h.deps);
    expect(h.queued[0]).toMatchObject({
      signalName: "contract summarized",
      quantity: 2,
      modelProvider: "outcome",
    });
  });
});

describe("done --setup re-asks both questions", () => {
  test("yes plus names writes the names and the note, and sends nothing", async () => {
    const writeNames = vi.fn();
    const writeBlocks = vi.fn(() => [
      { path: "/tmp/home/.claude/CLAUDE.md", action: "written" as const },
    ]);
    const h = harness({
      isTTY: () => true,
      currentFinishedNames: () => "",
      promptFinishedWork: async () => true,
      promptFinishedNames: async () => "contract summarized, slide deck",
      writeFinishedNames: writeNames,
      writeMemoryBlocks: writeBlocks,
    });

    expect(await cmdDone(["--setup"], h.deps)).toBe(0);
    expect(writeNames).toHaveBeenCalledWith("contract summarized, slide deck");
    expect(writeBlocks).toHaveBeenCalledWith(["contract summarized", "slide deck"]);
    expect(h.posted).toHaveLength(0);
  });

  test("no clears the names and removes the note", async () => {
    const writeNames = vi.fn();
    const removeBlocks = vi.fn(() => [
      { path: "/tmp/home/.claude/CLAUDE.md", action: "removed" as const },
    ]);
    const h = harness({
      isTTY: () => true,
      currentFinishedNames: () => "contract summarized",
      promptFinishedWork: async () => false,
      writeFinishedNames: writeNames,
      removeMemoryBlocks: removeBlocks,
    });

    expect(await cmdDone(["--setup"], h.deps)).toBe(0);
    expect(writeNames).toHaveBeenCalledWith("");
    expect(removeBlocks).toHaveBeenCalled();
  });

  test("with nobody at the keyboard it changes nothing and says where to run it", async () => {
    const writeNames = vi.fn();
    const h = harness({
      isTTY: () => false,
      currentFinishedNames: () => "",
      writeFinishedNames: writeNames,
    });
    expect(await cmdDone(["--setup"], h.deps)).toBe(2);
    expect(writeNames).not.toHaveBeenCalled();
  });
});

// Two lines a user reads at the moment they most need to trust
// the count: what landed, and what happens to one that could not be sent.
describe("what it says, exactly", () => {
  test("it quotes the name it was given and says how many", async () => {
    const h = harness({
      readWorkId: (): WorkId => ({ value: "PROJ-123", key: "CCC_WORK_ID" }),
    });
    await cmdDone(["contract summarized", "2"], h.deps);
    expect(h.out()).toContain(
      'Recorded "contract summarized" x2 for dev@example.com under work item PROJ-123.',
    );
    // "Recorded 2 contract summarized" reads as a sentence with a missing plural.
    expect(h.out()).not.toContain("Recorded 2 contract summarized");
  });

  test("a parked record waits for a RUNNING meter, and says so for Linux", async () => {
    // There is no background meter on Linux or WSL, so the message must not promise
    // an automatic send there.
    const h = harness({ post: async () => OFFLINE });
    expect(await cmdDone(["contract summarized"], h.deps)).toBe(0);
    expect(h.queued).toHaveLength(1);
    expect(h.out()).toContain("the meter sends it the next time it's running");
    expect(h.out()).toContain(
      "On Linux and WSL that means the next time you run node ~/.marginfront-ccc/cli.js run.",
    );
    expect(h.out()).not.toContain("sends it when sending recovers");
  });
});
