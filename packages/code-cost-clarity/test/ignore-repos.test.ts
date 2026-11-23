// ignore-repos.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES (ignored repos): one line in the settings file,
// CCC_IGNORE_REPOS, names the repos this machine must never send spend from. A
// session whose git remote matches one of them produces ZERO records: nothing is
// built, nothing is posted, nothing is parked in the retry queue.
//
// WHY IT HAS TO FAIL OPEN. A repo the meter cannot place is still SENT. The alternative reads safer and is worse: a resolver that
// answers null for a hundred honest reasons (no remote, an ambiguous project dir, a
// wedged git) would silently stop metering the whole machine, and the customer's
// first sign would be a bill that quietly went to zero. Refusing to send happens
// only on a match we can actually name.
//
// THE NO-RULE HALF MATTERS AS MUCH AS THE RULE HALF: with the line blank, or
// with a resolver that answers null, every built record must be deep-equal to the
// same build with no ignoredRepos option at all.
//
// THE DOTFILES GUARD BELONGS WITH THIS FEATURE. Without a HOME guard, a walk up to
// the filesystem root attributes every session of a developer whose home directory
// is itself a dotfiles repo to that repo, and one ignore rule for it would swallow
// the machine's real work. The guard omits coordinates when the only enclosing
// repository is the home directory, so that can never happen.
// ---------------------------------------------------------------------------

import { test, expect, describe, afterEach, vi } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  utimesSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildRequestBodyForLine,
  countQueueRecords,
  createIgnoredReposReader,
  dropRecordsFromIgnoredRepos,
  resolveIgnoredRepos,
  watchAndForward,
  recordSessionId,
  IGNORE_REPOS_ENV_KEY,
} from "../src/forwarder";
import { readGitCoordinates } from "../src/git-coordinates";
import {
  cmdDone,
  cmdStatus,
  ignoreReposStatusLine,
  type DoneDeps,
  type StatusDeps,
} from "../src/cli";
import {
  clearWorkIdsInEnv,
  ENV_PATH,
  renderEnvFile,
  writeCacheWriteTtlToEnv,
  writeDeveloperEmailToEnv,
  writeFinishedWorkNamesToEnv,
  writeWorkIdToEnv,
} from "../src/connector";
import type {
  GitCoordinates,
  OtlpLogAttribute,
  OtlpLogRecord,
  ParsedOtlp,
  UsageRecord,
} from "../src/types";
import type {
  CodexControlStatus,
  CodexTrustCacheEntry,
  CodexTrustDeps,
} from "../src/control";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const CLI_SOURCE = join(PACKAGE_ROOT, "src", "cli.ts");
const TS_HOOK_URL = pathToFileURL(
  join(HERE, "helpers", "ts-import-hook.mjs"),
).href;
const PREVIEW_FIXTURE = join(HERE, "fixtures", "claude-with-email.otlp.json");
// The session id inside that fixture. The preview cases below plant a project dir
// for exactly this id so the REAL resolver, not a stub, places the capture.
const PREVIEW_SESSION_ID = "sess-preview-001";

const EMAIL = "dev@example.com";
const IGNORED_REMOTE = "git@github.com:Acme/Widgets.git";
// What normalizeRemoteUrl makes of the remote above: the owner/repo the resolver
// hands the partition, capitals and all.
const IGNORED_REPO_AS_GIT_REPORTS_IT = "Acme/Widgets";
const SETTINGS_DIR_NAME = ".marginfront-ccc";
const SETTINGS_FILE_NAME = [".", "env"].join("");

// --- temp directories -------------------------------------------------------

const tempRoots: string[] = [];
function makeTempDir(prefix = "ccc-ignore-"): string {
  // .native, not the JS realpathSync: on Windows the runner's TEMP is an 8.3 short
  // path and only the OS call expands it back to the real directory name, which is
  // what the project-dir decode re-encodes and matches against.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function initRepo(dir: string, origin?: string): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  if (origin) git(dir, ["remote", "add", "origin", origin]);
  writeFileSync(join(dir, "file.txt"), "hello");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

// Claude Code names a project dir by replacing every non-alphanumeric character in
// the cwd with "-". The resolver re-encodes real directory names to decode it, so a
// test that plants one has to encode the same way.
function encodeCwd(absolutePath: string): string {
  return absolutePath.replace(/[^a-zA-Z0-9]/g, "-");
}

// A throwaway HOME holding one real git repo and the ~/.claude/projects entry that
// maps `sessionId` to it - everything the REAL resolver needs, with no stub.
function makeHomeWithRepo(
  sessionId: string,
  origin = IGNORED_REMOTE,
): { home: string; repoDir: string } {
  const home = makeTempDir("ccc-ignore-home-");
  const repoDir = join(home, "work", "widgets");
  mkdirSync(repoDir, { recursive: true });
  initRepo(repoDir, origin);
  const projectDir = join(home, ".claude", "projects", encodeCwd(repoDir));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), "{}\n");
  return { home, repoDir };
}

// --- OTLP fixtures (local copies, so this file stands alone) ----------------

function strAttr(key: string, value: string) {
  return { key, value: { stringValue: value } };
}
function logStrAttr(key: string, value: string): OtlpLogAttribute {
  return { key, value: { stringValue: value } };
}
function logIntAttr(key: string, value: number): OtlpLogAttribute {
  return { key, value: { intValue: String(value) } };
}

function claudeTurn(sessionId = "session-ignore-1"): ParsedOtlp {
  const id = [
    strAttr("user.email", EMAIL),
    strAttr("model", "claude-opus-4-8[1m]"),
    strAttr("session.id", sessionId),
  ];
  return {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.token.usage",
                sum: {
                  dataPoints: [
                    {
                      attributes: [...id, strAttr("type", "input")],
                      asInt: "1200",
                    },
                    {
                      attributes: [...id, strAttr("type", "output")],
                      asInt: "340",
                    },
                  ],
                },
              },
              {
                name: "claude_code.cost.usage",
                sum: { dataPoints: [{ attributes: id, asDouble: 0.1234 }] },
              },
            ],
          },
        ],
      },
    ],
  };
}

function codexTurn(conversationId = "conv-ignore-1"): ParsedOtlp {
  const record: OtlpLogRecord = {
    attributes: [
      logStrAttr("event.name", "codex.sse_event"),
      logStrAttr("user.email", EMAIL),
      logStrAttr("model", "gpt-5-codex"),
      logStrAttr("conversation.id", conversationId),
      logIntAttr("input_token_count", 1000),
      logIntAttr("output_token_count", 500),
      logIntAttr("cached_token_count", 800),
      logIntAttr("reasoning_token_count", 300),
      logIntAttr("tool_token_count", 20),
    ],
  };
  return { resourceLogs: [{ scopeLogs: [{ logRecords: [record] }] }] };
}

function toolCall(
  toolName: string,
  sessionId = "session-ignore-1",
): OtlpLogRecord {
  return {
    attributes: [
      logStrAttr("event.name", "tool_result"),
      logStrAttr("tool_name", toolName),
      logStrAttr("user.email", EMAIL),
      logStrAttr("session.id", sessionId),
    ],
  };
}

function toolTree(records: OtlpLogRecord[]): ParsedOtlp {
  return { resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] };
}

// A resolver that answers with one repo for every session, the way a machine with
// one checkout would.
function resolverFor(
  repo: string | null,
): (id: string | null) => GitCoordinates {
  return () => ({ repo, branch: "main", commitSha: "abc123" });
}

// ===========================================================================
// 1. THE READER. One line, comma-separated, read off the same mtime-guarded live
//    re-read path CCC_WORK_ID uses, so an edit lands on the next record.
// ===========================================================================

describe("resolveIgnoredRepos: one line into a set of owner/repo names", () => {
  test("a blank line ignores nothing", () => {
    const resolved = resolveIgnoredRepos({ [IGNORE_REPOS_ENV_KEY]: "" });
    expect(resolved.repos.size).toBe(0);
    expect(resolved.malformed).toEqual([]);
  });

  test("an unset key ignores nothing", () => {
    expect(resolveIgnoredRepos({}).repos.size).toBe(0);
  });

  // Matching is case-insensitive on the exact owner/repo, so the set
  // is lowercased once here rather than at every comparison.
  test("entries are trimmed, lowercased, and empties dropped", () => {
    const resolved = resolveIgnoredRepos({
      [IGNORE_REPOS_ENV_KEY]: "a/b, C/D ,,",
    });
    expect([...resolved.repos].sort()).toEqual(["a/b", "c/d"]);
    expect(resolved.malformed).toEqual([]);
  });

  test("a malformed entry is ignored and reported, and never swallows work", () => {
    const resolved = resolveIgnoredRepos({
      [IGNORE_REPOS_ENV_KEY]: "acme, acme /widgets, good/one, /nope, trailing/",
    });
    expect([...resolved.repos]).toEqual(["good/one"]);
    expect(resolved.malformed).toEqual([
      "acme",
      "acme /widgets",
      "/nope",
      "trailing/",
    ]);
  });
});

// A customer who keeps a repo off the meter is usually looking at the remote URL
// when they write the line, and its tail ends in ".git". That entry passes the
// shape gate, so it sits in the ACTIVE list looking right, and it can never match:
// normalizeRemoteUrl strips ".git" off every remote before the repo is stamped on a
// record. Stripping the same suffix at read time is what makes the paste work.
describe("resolveIgnoredRepos: a trailing .git still names the same repo", () => {
  test("the suffix comes off at read time", () => {
    const resolved = resolveIgnoredRepos({
      [IGNORE_REPOS_ENV_KEY]: "acme/widgets.git",
    });
    expect([...resolved.repos]).toEqual(["acme/widgets"]);
    expect(resolved.malformed).toEqual([]);
    expect(resolved.hostPrefixed).toEqual([]);
  });

  test("capitals in the suffix make no difference either", () => {
    const resolved = resolveIgnoredRepos({
      [IGNORE_REPOS_ENV_KEY]: "ACME/Widgets.GIT",
    });
    expect([...resolved.repos]).toEqual(["acme/widgets"]);
    expect(resolved.malformed).toEqual([]);
  });

  test("only the exact suffix goes: a repo named .github keeps its name", () => {
    expect([
      ...resolveIgnoredRepos({ [IGNORE_REPOS_ENV_KEY]: "acme/.github" }).repos,
    ]).toEqual(["acme/.github"]);
  });

  test("an entry that is nothing but the suffix is reported back verbatim", () => {
    const resolved = resolveIgnoredRepos({
      [IGNORE_REPOS_ENV_KEY]: "acme/.git",
    });
    expect(resolved.repos.size).toBe(0);
    expect(resolved.malformed).toEqual(["acme/.git"]);
  });

  test("a session in the repo it names sends nothing", () => {
    const fixture = claudeTurn();
    const sent = buildRequestBodyForLine(fixture, {
      resolveGitCoordinates: resolverFor(IGNORED_REPO_AS_GIT_REPORTS_IT),
    });
    expect(sent.records.length).toBeGreaterThan(0);

    for (const line of ["acme/widgets.git", "ACME/Widgets.GIT"]) {
      const body = buildRequestBodyForLine(fixture, {
        resolveGitCoordinates: resolverFor(IGNORED_REPO_AS_GIT_REPORTS_IT),
        ignoredRepos: resolveIgnoredRepos({ [IGNORE_REPOS_ENV_KEY]: line })
          .repos,
      });
      expect(body.records).toEqual([]);
    }
  });
});

function tempEnvFile(contents: string): { dir: string; path: string } {
  const dir = makeTempDir("ccc-ignore-env-");
  const path = join(dir, SETTINGS_FILE_NAME);
  writeFileSync(path, contents);
  return { dir, path };
}

// Writing twice inside the same millisecond leaves mtimeMs unchanged, which would
// make these flake rather than fail. Stamping the time takes the clock out of the
// test without taking the guard out of the code.
function rewrite(path: string, contents: string, secondsLater: number): void {
  writeFileSync(path, contents);
  const when = new Date(Date.now() + secondsLater * 1000);
  utimesSync(path, when, when);
}

describe("createIgnoredReposReader: the live re-read, behind the modified-time guard", () => {
  test("the file line decides", () => {
    const { path } = tempEnvFile(`${IGNORE_REPOS_ENV_KEY}=Acme/Widgets\n`);
    const read = createIgnoredReposReader({ envPath: path });
    expect([...read().repos]).toEqual(["acme/widgets"]);
  });

  test("a blank line ignores nothing", () => {
    const { path } = tempEnvFile(`${IGNORE_REPOS_ENV_KEY}=\n`);
    expect(createIgnoredReposReader({ envPath: path })().repos.size).toBe(0);
  });

  test("no settings file at all ignores nothing", () => {
    const read = createIgnoredReposReader({
      envPath: join(makeTempDir(), "no-such-file", SETTINGS_FILE_NAME),
    });
    expect(read().repos.size).toBe(0);
  });

  // The call site runs once per telemetry line. An unguarded reader would parse the
  // settings file forever.
  test("the file is parsed once until it actually changes", () => {
    const { path } = tempEnvFile(`${IGNORE_REPOS_ENV_KEY}=acme/widgets\n`);
    const parses: string[] = [];
    const read = createIgnoredReposReader({
      envPath: path,
      readFileValues: (filePath) => {
        parses.push(filePath);
        return { [IGNORE_REPOS_ENV_KEY]: "acme/widgets" };
      },
    });
    for (let i = 0; i < 1000; i++) expect(read().repos.size).toBe(1);
    expect(parses.length).toBe(1);

    // Touching the file is what buys a second parse, nothing else.
    rewrite(path, `${IGNORE_REPOS_ENV_KEY}=acme/widgets\n`, 3);
    expect(read().repos.size).toBe(1);
    expect(parses.length).toBe(2);
  });

  test("an edited line reaches the next read with nothing restarted", () => {
    const { path } = tempEnvFile(`${IGNORE_REPOS_ENV_KEY}=acme/widgets\n`);
    const read = createIgnoredReposReader({ envPath: path });
    expect([...read().repos]).toEqual(["acme/widgets"]);
    rewrite(path, `${IGNORE_REPOS_ENV_KEY}=other/repo\n`, 2);
    expect([...read().repos]).toEqual(["other/repo"]);
    rewrite(path, `${IGNORE_REPOS_ENV_KEY}=\n`, 4);
    expect(read().repos.size).toBe(0);
  });
});

// ===========================================================================
// 2. THE PARTITION. One site, in the dispatcher, across all three record shapes.
// ===========================================================================

const IGNORED_SET = new Set(["acme/widgets"]);

const RECORD_SHAPES: Array<[string, () => ParsedOtlp]> = [
  ["Claude token metrics", () => claudeTurn()],
  ["Codex token logs", () => codexTurn()],
  ["tool records", () => toolTree([toolCall("WebFetch")])],
];

describe("a matching session produces zero records, on every record shape", () => {
  for (const [name, makeFixture] of RECORD_SHAPES) {
    test(`${name}: the ignored repo sends nothing`, () => {
      const fixture = makeFixture();
      // Before the ignore rule this same build produces records - otherwise the
      // case below would pass on a fixture that was empty all along.
      const sent = buildRequestBodyForLine(fixture, {
        resolveGitCoordinates: resolverFor(IGNORED_REPO_AS_GIT_REPORTS_IT),
      });
      expect(sent.records.length).toBeGreaterThan(0);

      const withIgnore = buildRequestBodyForLine(fixture, {
        resolveGitCoordinates: resolverFor(IGNORED_REPO_AS_GIT_REPORTS_IT),
        ignoredRepos: IGNORED_SET,
      });
      expect(withIgnore.records).toEqual([]);
    });
  }
});

describe("fail-open: anything short of a named match still sends", () => {
  for (const [name, makeFixture] of RECORD_SHAPES) {
    test(`${name}: a resolver that answers null sends what it sends today`, () => {
      const fixture = makeFixture();
      const today = buildRequestBodyForLine(fixture, {
        resolveGitCoordinates: () => null,
      });
      const withIgnore = buildRequestBodyForLine(fixture, {
        resolveGitCoordinates: () => null,
        ignoredRepos: IGNORED_SET,
      });
      expect(withIgnore).toEqual(today);
    });

    test(`${name}: a session placed with no repo still sends`, () => {
      const fixture = makeFixture();
      const today = buildRequestBodyForLine(fixture, {
        resolveGitCoordinates: resolverFor(null),
      });
      const withIgnore = buildRequestBodyForLine(fixture, {
        resolveGitCoordinates: resolverFor(null),
        ignoredRepos: IGNORED_SET,
      });
      expect(withIgnore).toEqual(today);
    });

    test(`${name}: an empty set is identical to no ignore option at all`, () => {
      const fixture = makeFixture();
      const today = buildRequestBodyForLine(fixture, {
        resolveGitCoordinates: resolverFor(IGNORED_REPO_AS_GIT_REPORTS_IT),
      });
      const withEmptySet = buildRequestBodyForLine(fixture, {
        resolveGitCoordinates: resolverFor(IGNORED_REPO_AS_GIT_REPORTS_IT),
        ignoredRepos: new Set<string>(),
      });
      expect(withEmptySet).toEqual(today);
    });

    test(`${name}: a repo nobody named still sends`, () => {
      const fixture = makeFixture();
      const today = buildRequestBodyForLine(fixture, {
        resolveGitCoordinates: resolverFor("other/repo"),
      });
      const withIgnore = buildRequestBodyForLine(fixture, {
        resolveGitCoordinates: resolverFor("other/repo"),
        ignoredRepos: IGNORED_SET,
      });
      expect(withIgnore).toEqual(today);
    });
  }
});

// The sharp one. Two sessions share one flush line, and only one of them is in an
// ignored repo. The other has to survive UNCHANGED - same order, same idempotency
// key - or a replay of this line would land as a second, different record on the
// server and double-count work that was never ignored.
test("two sessions on one line: only the ignored one goes, and the survivor is untouched", () => {
  const fixture = toolTree([
    toolCall("WebFetch", "session-ignored"),
    toolCall("Bash", "session-kept"),
    toolCall("Read", "session-kept"),
  ]);
  const rawSourceLine = JSON.stringify(fixture);
  const resolveGitCoordinates = (sessionId: string | null): GitCoordinates =>
    sessionId === "session-ignored"
      ? {
          repo: IGNORED_REPO_AS_GIT_REPORTS_IT,
          branch: "main",
          commitSha: "a1",
        }
      : { repo: "other/repo", branch: "main", commitSha: "b2" };

  const today = buildRequestBodyForLine(fixture, {
    resolveGitCoordinates,
    rawSourceLine,
  });
  const withIgnore = buildRequestBodyForLine(fixture, {
    resolveGitCoordinates,
    ignoredRepos: IGNORED_SET,
    rawSourceLine,
  });

  expect(today.records).toHaveLength(3);
  const survivors = today.records.filter(
    (record) => recordSessionId(record) === "session-kept",
  );
  expect(survivors).toHaveLength(2);
  expect(withIgnore.records).toEqual(survivors);
  expect(withIgnore.records.map((record) => record.model)).toEqual([
    "Bash",
    "Read",
  ]);
  for (const record of withIgnore.records) {
    expect(record.idempotencyKey).toBeTruthy();
  }
});

// ===========================================================================
// 3. THE DAEMON. The promise a customer is actually given: the running meter
//    sends nothing from the named repo, and un-naming it needs no restart.
// ===========================================================================

function inMemoryCodexTrust(): CodexTrustDeps {
  const status: CodexControlStatus = { state: "unknown", reason: "test" };
  let cached: CodexTrustCacheEntry | null = null;
  return {
    resolveStatus: async () => status,
    readCache: () => cached,
    writeCache: (resolved, cccVersion) => {
      cached = {
        state: resolved.state,
        reason: resolved.reason ?? null,
        resolvedAt: new Date().toISOString(),
        ccc: cccVersion,
      };
      return cached;
    },
  };
}

async function waitForCaptured(
  captured: Array<{ records: UsageRecord[] }>,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (captured.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(captured.length).toBeGreaterThanOrEqual(count);
}

test("LIVE: the running meter posts nothing from an ignored repo, and un-naming it needs no restart", async () => {
  const captured: Array<{ records: UsageRecord[] }> = [];
  vi.stubGlobal(
    "fetch",
    async (_url: string, init?: RequestInit): Promise<Response> => {
      captured.push(
        JSON.parse(String(init?.body)) as { records: UsageRecord[] },
      );
      return new Response(JSON.stringify({ results: { success: [] } }), {
        status: 200,
      });
    },
  );

  const sessionId = "session-live-ignored";
  const dir = makeTempDir("ccc-ignore-live-");
  const jsonlPath = join(dir, "live.jsonl");
  const envPath = join(dir, SETTINGS_FILE_NAME);
  writeFileSync(envPath, `${IGNORE_REPOS_ENV_KEY}=acme/widgets\n`);
  writeFileSync(jsonlPath, JSON.stringify(claudeTurn(sessionId)) + "\n");

  const savedKey = process.env.MARGINFRONT_API_KEY;
  process.env.MARGINFRONT_API_KEY = "test-key-ignore-live";
  let stop: (() => void) | null = null;
  try {
    stop = watchAndForward(jsonlPath, {
      cursorPath: join(dir, "cursor"),
      matterEnvPath: envPath,
      codexTrustDeps: inMemoryCodexTrust(),
      // The real resolver keys off homedir(), and under vitest homedir() does not
      // follow a process.env.HOME this test could set. The real one is driven end to
      // end by the preview cases below, which run in a child process with a real
      // throwaway home; this seam is what lets the DAEMON half be tested at all.
      gitCoordinatesResolver: () => ({
        repo: IGNORED_REPO_AS_GIT_REPORTS_IT,
        branch: "main",
        commitSha: "abc123",
      }),
    });

    // Four poll intervals with nothing posted.
    await new Promise((r) => setTimeout(r, 4_000));
    expect(captured).toEqual([]);

    // The person un-names the repo: one line blanked, nothing restarted.
    rewrite(envPath, `${IGNORE_REPOS_ENV_KEY}=\n`, 2);
    appendFileSync(jsonlPath, JSON.stringify(claudeTurn(sessionId)) + "\n");

    await waitForCaptured(captured, 1);
    expect(captured[0].records.length).toBeGreaterThan(0);
    expect(captured[0].records[0].metadata.repo).toBe(
      IGNORED_REPO_AS_GIT_REPORTS_IT,
    );
  } finally {
    if (stop) stop();
    if (savedKey === undefined) delete process.env.MARGINFRONT_API_KEY;
    else process.env.MARGINFRONT_API_KEY = savedKey;
    vi.unstubAllGlobals();
  }
}, 40_000);

// ===========================================================================
// 4. THE DOTFILES GUARD. Without it, a home directory that is itself a git repo
//    catches every session on the machine, and one ignore rule for that repo would
//    stop the meter dead while looking like it was working.
// ===========================================================================

describe("a home directory that is itself a git repo never becomes the answer", () => {
  test("a folder under HOME with no nearer repo reports no repo", () => {
    const home = makeTempDir("ccc-dotfiles-home-");
    initRepo(home, "git@github.com:alex/dotfiles.git");
    const notARepo = join(home, "scratch", "notes");
    mkdirSync(notARepo, { recursive: true });

    const coordinates = readGitCoordinates(notARepo, undefined, {
      homeDir: home,
    });
    expect(coordinates.repo).toBeNull();
  });

  test("a real repo nested under that HOME still resolves", () => {
    const home = makeTempDir("ccc-dotfiles-home-");
    initRepo(home, "git@github.com:alex/dotfiles.git");
    const nested = join(home, "code", "widgets");
    mkdirSync(nested, { recursive: true });
    initRepo(nested, IGNORED_REMOTE);

    const coordinates = readGitCoordinates(nested, undefined, {
      homeDir: home,
    });
    expect(coordinates.repo).toBe(IGNORED_REPO_AS_GIT_REPORTS_IT);
    expect(coordinates.branch).toBe("main");
  });

  test("a repo that is not the home directory is unaffected", () => {
    const home = makeTempDir("ccc-dotfiles-home-");
    const elsewhere = makeTempDir("ccc-elsewhere-");
    initRepo(elsewhere, IGNORED_REMOTE);
    expect(
      readGitCoordinates(elsewhere, undefined, { homeDir: home }).repo,
    ).toBe(IGNORED_REPO_AS_GIT_REPORTS_IT);
  });
});

// ===========================================================================
// 5. PREVIEW TELLS THE SAME TRUTH THE DAEMON DOES. Preview passes the same git
//    resolver the daemon uses, so the rule it shows is the rule the daemon
//    applies.
// ===========================================================================

function runPreview(ignoreLine?: string): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const { home } = makeHomeWithRepo(PREVIEW_SESSION_ID);
  mkdirSync(join(home, SETTINGS_DIR_NAME), { recursive: true });
  writeFileSync(
    join(home, SETTINGS_DIR_NAME, SETTINGS_FILE_NAME),
    ignoreLine === undefined ? "" : `${IGNORE_REPOS_ENV_KEY}=${ignoreLine}\n`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
  delete env.MARGINFRONT_API_KEY;
  delete env.CCC_DEVELOPER_EMAIL;
  delete env[IGNORE_REPOS_ENV_KEY];
  const result = spawnSync(
    process.execPath,
    ["--import", TS_HOOK_URL, CLI_SOURCE, "preview", PREVIEW_FIXTURE],
    { encoding: "utf8", env, timeout: 60_000 },
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

test("preview WITH the repo named: no records, and a line naming the repo it refused", () => {
  const { stdout, status } = runPreview("acme/widgets");
  expect(status).toBe(0);
  expect(stdout).toContain('"records": []');
  expect(stdout).toMatch(/Ignoring:/);
  expect(stdout).toContain(IGNORED_REPO_AS_GIT_REPORTS_IT);
}, 90_000);

test("preview WITHOUT the line (regression): the capture's records print unfiltered", () => {
  const { stdout, status } = runPreview(undefined);
  expect(status).toBe(0);
  expect(stdout).not.toContain('"records": []');
  expect(stdout).toContain("login@example.com");
  expect(stdout).not.toMatch(/Ignoring:/);
}, 90_000);

// ===========================================================================
// 6. `status` SAYS WHICH REPOS THIS MACHINE IS KEEPING OFF THE METER. Both
//    halves are gated: the line naming the repos, and the line that says no
//    repo is being held back - a machine sending everything must never read as
//    a machine with a rule on it.
// ===========================================================================

describe("ignoreReposStatusLine", () => {
  test("with repos named: the repos, where they came from, and the fail-open truth", () => {
    expect(
      ignoreReposStatusLine({
        repos: new Set(["acme/widgets", "acme/billing"]),
        malformed: [],
        hostPrefixed: [],
      }),
    ).toBe(
      `Ignoring: acme/billing, acme/widgets (from ${IGNORE_REPOS_ENV_KEY} in ${ENV_PATH}, capitals make no difference). Sessions the meter can't place in a repo are still sent.`,
    );
  });

  test("with nothing named: says every repo is metered, and where to change that", () => {
    expect(
      ignoreReposStatusLine({
        repos: new Set(),
        malformed: [],
        hostPrefixed: [],
      }),
    ).toBe(
      `Ignoring: no repos. Every repo on this machine is metered. Set ${IGNORE_REPOS_ENV_KEY} in ${ENV_PATH} to keep one off.`,
    );
  });

  // An entry that ignores nothing looks exactly like one that works, from the
  // customer's side of the file. Hand it back verbatim, quoted, so a stray space
  // is visible.
  test("malformed entries get one extra sentence, quoted verbatim", () => {
    const line = ignoreReposStatusLine({
      repos: new Set(["acme/widgets"]),
      malformed: ["widgets", "acme / widgets"],
      hostPrefixed: [],
    });
    expect(line).toContain("acme/widgets (from ");
    expect(line).toContain(
      'Not owner/repo, so these ignore nothing: "widgets", "acme / widgets". Write each one as owner/repo.',
    );
  });

  test("the malformed sentence shows up on an otherwise empty rule too", () => {
    const line = ignoreReposStatusLine({
      repos: new Set(),
      malformed: ["widgets"],
      hostPrefixed: [],
    });
    expect(line).toContain("Ignoring: no repos.");
    expect(line).toContain(
      'Not owner/repo, so these ignore nothing: "widgets". Write each one as owner/repo.',
    );
  });

  test("no malformed entries means no extra sentence at all", () => {
    for (const repos of [new Set<string>(), new Set(["acme/widgets"])]) {
      expect(
        ignoreReposStatusLine({ repos, malformed: [], hostPrefixed: [] }),
      ).not.toContain("ignore nothing");
    }
  });
});

describe("cmdStatus prints the ignore line right under the work item line", () => {
  function statusRig(overrides: Partial<StatusDeps> = {}): {
    deps: StatusDeps;
    logs: string[];
  } {
    const logs: string[] = [];
    const deps: StatusDeps = {
      log: (message) => logs.push(message),
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
      now: () => 10_000_000_000,
      claudeTelemetryOn: () => true,
      claudeInstalled: () => true,
      codexInstalled: () => false,
      codexCaptureWired: () => false,
      controlIsArmed: () => false,
      codexControlStatus: async () => ({ state: "armed" }),
      authHold: () => null,
      queueDepth: () => 0,
      capsSpentMtimeMs: () => null,
      workId: () => ({ value: undefined }),
      finishedWorkNames: () => undefined,
      ...overrides,
    };
    return { deps, logs };
  }

  test("the ignore line is the very next line after the work item line", async () => {
    const { deps, logs } = statusRig({
      ignoredRepos: () => ({
        repos: new Set(["acme/widgets"]),
        malformed: [],
        hostPrefixed: [],
      }),
    });
    await cmdStatus(deps);
    const lines = logs.join("\n").split("\n");
    const workItemAt = lines.findIndex((line) => line.startsWith("Work item:"));
    expect(workItemAt).toBeGreaterThan(-1);
    expect(lines[workItemAt + 1]).toBe(
      ignoreReposStatusLine({
        repos: new Set(["acme/widgets"]),
        malformed: [],
        hostPrefixed: [],
      }),
    );
  });

  test("a machine with no rule still gets the line, saying so", async () => {
    const { deps, logs } = statusRig({
      ignoredRepos: () => ({
        repos: new Set(),
        malformed: [],
        hostPrefixed: [],
      }),
    });
    await cmdStatus(deps);
    expect(logs.join("\n")).toContain("Ignoring: no repos.");
  });

  // The seam is for tests. On a real machine `status` has to read the settings file
  // the same way the running meter does, or it reports a rule nobody has.
  test("with no seam, status reads the settings file itself and prints a line", async () => {
    const { deps, logs } = statusRig();
    await cmdStatus(deps);
    expect(logs.join("\n")).toMatch(/^Ignoring: /m);
  });
});

// ===========================================================================
// 7. THE SETTINGS FILE `init` WRITES CARRIES THE SWITCH, BLANK. Without it the
//    feature has no discoverable switch, and `init` never rewrites a settings
//    file that already exists, so this block sits on the customer's disk for
//    the life of the install.
//
//    THE BYTE-FOR-BYTE GATE: the fixture is the template without the ignore
//    block, so this block is the only difference. Regenerate it only when a
//    release deliberately changes another line.
// ===========================================================================

describe("the .env template carries a blank CCC_IGNORE_REPOS= line", () => {
  const template = renderEnvFile();

  test("exactly one blank line, and it sits after the older work-item key", () => {
    expect(template.match(/^CCC_IGNORE_REPOS=$/gm)).toHaveLength(1);
    expect(template.indexOf("\nCCC_IGNORE_REPOS=")).toBeGreaterThan(
      template.indexOf("\nCCC_MATTER_ID="),
    );
  });

  test("the block above it explains the line with an everyday example", () => {
    const at = template.indexOf("\nCCC_IGNORE_REPOS=");
    const block = template.slice(
      template.indexOf("# WHICH REPOS THIS MACHINE NEVER SENDS"),
      at,
    );
    expect(block).not.toBe("");
    expect(
      block.split("\n").filter((line) => line.startsWith("#")).length,
    ).toBeGreaterThanOrEqual(3);
    expect(block).toContain("acme-corp/billing");
    expect(block).toMatch(/owner\/repo/);
    expect(block).toMatch(/BLANK/);
    // The fail-open promise belongs where the rule is typed, not only in status.
    expect(block).toMatch(/still sent/);
  });

  test("every other line of the template matches the pinned fixture byte for byte", () => {
    const afterMatterId =
      template.indexOf("\nCCC_MATTER_ID=") + "\nCCC_MATTER_ID=\n".length;
    const endOfBlock =
      template.indexOf("\nCCC_IGNORE_REPOS=") + "\nCCC_IGNORE_REPOS=\n".length;
    expect(endOfBlock).toBeGreaterThan(afterMatterId);
    const withoutBlock =
      template.slice(0, afterMatterId) + template.slice(endOfBlock);
    expect(withoutBlock).toBe(
      readFileSync(
        join(HERE, "fixtures", "env-template-0.18.0.txt"),
        "utf8",
      ).replace(/\r\n/g, "\n"),
    );
  });
});

describe("the other settings writers leave the ignore line alone", () => {
  const RULE = "CCC_IGNORE_REPOS=acme/widgets,acme/billing";

  function envFileWithRule(): string {
    const path = join(makeTempDir("ccc-writers-"), SETTINGS_FILE_NAME);
    writeFileSync(
      path,
      renderEnvFile().replace("\nCCC_IGNORE_REPOS=", `\n${RULE}`),
    );
    return path;
  }

  const writers: Array<[string, (path: string) => void]> = [
    ["work --clear", (path) => clearWorkIdsInEnv(path)],
    ["work <name>", (path) => writeWorkIdToEnv("Q3 pricing model", path)],
    [
      "the developer email",
      (path) => writeDeveloperEmailToEnv("d@e.example", path),
    ],
    [
      "the finished-work names",
      (path) => writeFinishedWorkNamesToEnv("contract summarized", path),
    ],
    ["the cache-write TTL", (path) => writeCacheWriteTtlToEnv("1h", path)],
  ];

  for (const [what, write] of writers) {
    test(`${what} leaves it untouched`, () => {
      const path = envFileWithRule();
      write(path);
      const after = readFileSync(path, "utf8");
      expect(after.match(/^CCC_IGNORE_REPOS=.*$/m)?.[0]).toBe(RULE);
    });
  }
});

// ===========================================================================
// 8. `code-cost-clarity done` OBEYS THE SAME RULE. It is the one command a
//    customer types by hand, it reads git from the folder it runs in, and it posts on its own
//    path rather than through the partition the watcher uses - so it gets its own
//    proof, not an inherited one. The promise in the settings file is absolute:
//    no record built, nothing posted, nothing waiting in the outbox.
// ===========================================================================

const IGNORED_COORDINATES: GitCoordinates = {
  repo: IGNORED_REPO_AS_GIT_REPORTS_IT,
  branch: "main",
  commitSha: "abc123",
};

function doneRig(overrides: Partial<DoneDeps> = {}): {
  deps: DoneDeps;
  lines: string[];
  errors: string[];
  posted: unknown[];
  queued: unknown[];
} {
  const lines: string[] = [];
  const errors: string[] = [];
  const posted: unknown[] = [];
  const queued: unknown[] = [];
  const deps: DoneDeps = {
    loadEnv: () => ({
      MARGINFRONT_API_KEY: "mf_sk_test",
      CCC_DEVELOPER_EMAIL: EMAIL,
    }),
    apiKeyInEnvironment: () => undefined,
    readWorkId: () => ({ value: undefined }),
    claudeInstalled: () => true,
    codexInstalled: () => false,
    lastAgentSeen: () => null,
    readGitCoordinates: () => IGNORED_COORDINATES,
    ignoredRepos: () => ({
      repos: new Set<string>(),
      malformed: [],
      hostPrefixed: [],
    }),
    now: () => new Date("2026-09-23T14:32:07.001Z"),
    post: async (body) => {
      posted.push(body);
      return { ok: true, parsed: null, body: "{}" };
    },
    queue: (records) => {
      queued.push(...records);
    },
    isTTY: () => false,
    log: (message) => lines.push(message),
    errorLog: (message) => errors.push(message),
    ...overrides,
  };
  return { deps, lines, errors, posted, queued };
}

describe("`done` in an ignored repo counts nothing and sends nothing", () => {
  test("CONTROL: with nobody named, the same call posts one record", async () => {
    const rig = doneRig();
    expect(await cmdDone(["contract summarized"], rig.deps)).toBe(0);
    expect(rig.posted).toHaveLength(1);
  });

  test("the named repo: nothing posted, nothing queued, and it says why", async () => {
    const rig = doneRig({
      ignoredRepos: () => ({
        repos: new Set(["acme/widgets"]),
        malformed: [],
        hostPrefixed: [],
      }),
    });

    expect(await cmdDone(["contract summarized"], rig.deps)).toBe(0);
    expect(rig.posted).toEqual([]);
    expect(rig.queued).toEqual([]);
    expect(rig.errors).toEqual([]);
    expect(rig.lines.join("\n")).toContain(IGNORE_REPOS_ENV_KEY);
  });

  test("a repo nobody named still counts", async () => {
    const rig = doneRig({
      ignoredRepos: () => ({
        repos: new Set(["other/repo"]),
        malformed: [],
        hostPrefixed: [],
      }),
    });
    expect(await cmdDone(["contract summarized"], rig.deps)).toBe(0);
    expect(rig.posted).toHaveLength(1);
  });

  // Fail-open, the same rule the watcher follows: a folder the meter can't place
  // in a repo is still counted, or one unreadable git would stop `done` dead.
  test("a folder the meter can't place in a repo still counts", async () => {
    const rig = doneRig({
      readGitCoordinates: () => null,
      ignoredRepos: () => ({
        repos: new Set(["acme/widgets"]),
        malformed: [],
        hostPrefixed: [],
      }),
    });
    expect(await cmdDone(["contract summarized"], rig.deps)).toBe(0);
    expect(rig.posted).toHaveLength(1);
  });

  test("a repo with no remote still counts", async () => {
    const rig = doneRig({
      readGitCoordinates: () => ({
        repo: null,
        branch: "main",
        commitSha: "abc123",
      }),
      ignoredRepos: () => ({
        repos: new Set(["acme/widgets"]),
        malformed: [],
        hostPrefixed: [],
      }),
    });
    expect(await cmdDone(["contract summarized"], rig.deps)).toBe(0);
    expect(rig.posted).toHaveLength(1);
  });
});

// The seam above proves the branch. This proves the WIRING: the real `done`, in a
// real repo, reading the real settings file, with the ingest endpoint pointed at a
// loopback server this test owns. Nothing leaves the machine either way.
async function withLoopbackIngest(
  run: (serverUrl: string, posts: () => number) => Promise<void>,
): Promise<void> {
  let posts = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST") posts += 1;
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ results: { success: [] } }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1`, () => posts);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

async function runDoneInRepo(
  serverUrl: string,
  ignoreLine: string,
): Promise<string> {
  const { home, repoDir } = makeHomeWithRepo("session-done-wiring");
  mkdirSync(join(home, SETTINGS_DIR_NAME), { recursive: true });
  writeFileSync(
    join(home, SETTINGS_DIR_NAME, SETTINGS_FILE_NAME),
    [
      `CCC_DEVELOPER_EMAIL=${EMAIL}`,
      "MARGINFRONT_API_KEY=mf_sk_loopback_test_key",
      `${IGNORE_REPOS_ENV_KEY}=${ignoreLine}`,
      "",
    ].join("\n"),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    MARGINFRONT_API_URL: serverUrl,
  };
  delete env[IGNORE_REPOS_ENV_KEY];
  delete env.CCC_DEVELOPER_EMAIL;
  delete env.MARGINFRONT_API_KEY;
  // spawn, not spawnSync: the loopback server lives in THIS process, and a
  // synchronous spawn blocks the event loop that would answer the child's POST.
  const child = spawn(
    process.execPath,
    [
      "--import",
      TS_HOOK_URL,
      CLI_SOURCE,
      "done",
      "contract summarized",
      "--agent",
      "claude-code",
    ],
    { cwd: repoDir, env },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  await new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });
  return output;
}

test("WIRING: `done` reads the settings file itself, with no seam", async () => {
  await withLoopbackIngest(async (serverUrl, posts) => {
    const control = await runDoneInRepo(serverUrl, "");
    expect(posts()).toBe(1);
    expect(control).toContain("contract summarized");

    const ignored = await runDoneInRepo(serverUrl, "acme/widgets");
    expect(posts()).toBe(1);
    expect(ignored).toContain(IGNORE_REPOS_ENV_KEY);
  });
}, 120_000);

// ===========================================================================
// 9. THE PARTITION DECIDES FROM THE REPO THE RECORD ALREADY CARRIES, not
//     from a second git read. Two reads can disagree - a 1-second timeout on a
//     busy machine, an index wedged mid-rebase - and the only direction that
//     disagreement can break is a record going out stamped with the very repo
//     name the rule was set to keep in.
// ===========================================================================

describe("one git read per session, and the stamped repo is what decides", () => {
  test("turning the rule on asks git nothing extra", () => {
    const fixture = toolTree([
      toolCall("WebFetch", "session-a"),
      toolCall("Bash", "session-b"),
    ]);
    const gitReads = (ignoredRepos?: Set<string>): number => {
      let calls = 0;
      buildRequestBodyForLine(fixture, {
        resolveGitCoordinates: () => {
          calls += 1;
          return { repo: "other/repo", branch: "main", commitSha: "abc123" };
        },
        ignoredRepos,
      });
      return calls;
    };
    expect(gitReads(IGNORED_SET)).toBe(gitReads(undefined));
  });

  test("a git read that goes quiet after the stamp can't un-ignore the record", () => {
    const fixture = claudeTurn("session-flaky");
    let duringBuild = 0;
    buildRequestBodyForLine(fixture, {
      resolveGitCoordinates: () => {
        duringBuild += 1;
        return IGNORED_COORDINATES;
      },
    });

    let calls = 0;
    const body = buildRequestBodyForLine(fixture, {
      resolveGitCoordinates: () => {
        calls += 1;
        return calls <= duringBuild ? IGNORED_COORDINATES : null;
      },
      ignoredRepos: IGNORED_SET,
    });
    expect(body.records).toEqual([]);
  });

  test("the partition is one function over stamped records", () => {
    const built = buildRequestBodyForLine(claudeTurn(), {
      resolveGitCoordinates: resolverFor(IGNORED_REPO_AS_GIT_REPORTS_IT),
    });
    expect(built.records.length).toBeGreaterThan(0);
    expect(dropRecordsFromIgnoredRepos(built.records, IGNORED_SET)).toEqual([]);
    expect(
      dropRecordsFromIgnoredRepos(built.records, new Set(["other/repo"])),
    ).toEqual(built.records);
    // Identity, not equality: an unset or empty rule has to hand the caller back the
    // very array it was given, which is what keeps the body byte-identical.
    expect(dropRecordsFromIgnoredRepos(built.records, undefined)).toBe(
      built.records,
    );
    expect(dropRecordsFromIgnoredRepos(built.records, new Set())).toBe(
      built.records,
    );
  });

  // readQueue casts every parsed line to a record, so a file truncated by a crash
  // mid-append can hand the partition a number, a string, null, or an object with no
  // metadata on it. None of those names a repo, and fail-open means each one goes out
  // unchanged rather than throwing and wedging the whole drain.
  test("a queue line that is not a record passes through instead of throwing", () => {
    const corrupt = [
      42,
      "not a record",
      null,
      { customerExternalId: EMAIL },
      { customerExternalId: EMAIL, metadata: null },
      { customerExternalId: EMAIL, metadata: { repo: 7 } },
    ] as unknown as UsageRecord[];
    expect(dropRecordsFromIgnoredRepos(corrupt, IGNORED_SET)).toEqual(corrupt);
  });
});

// ===========================================================================
// 10. THE OUTBOX OBEYS IT TOO. New records never reach the queue from an
//     ignored repo - the partition and `done` both refuse first. The one way an
//     ignored repo's record sits in there is that it was parked during an outage
//     BEFORE the rule was written, which is exactly when a customer writes one:
//     right after noticing something they didn't want sent.
// ===========================================================================

function parkedRecord(signalName: string, repo: string | null): UsageRecord {
  return {
    customerExternalId: EMAIL,
    agentCode: "claude-code",
    signalName,
    model: "work-item",
    modelProvider: "outcome",
    quantity: 1,
    environment: "development",
    metadata: {
      source: "outcome",
      doneAt: "2026-09-23T12:00:00.000Z",
      ...(repo ? { repo, branch: "main", commitSha: "abc123" } : {}),
    },
  } as unknown as UsageRecord;
}

async function withParkedQueue(
  ignoreLine: string,
  parked: UsageRecord[],
  run: (rig: {
    postedNames: () => string[];
    queueDepth: () => number;
  }) => Promise<void>,
): Promise<void> {
  const dir = makeTempDir("ccc-ignore-drain-");
  const livePath = join(dir, "live.jsonl");
  const queuePath = join(dir, "queue.jsonl");
  const envPath = join(dir, SETTINGS_FILE_NAME);
  writeFileSync(livePath, "");
  writeFileSync(envPath, `${IGNORE_REPOS_ENV_KEY}=${ignoreLine}\n`);
  writeFileSync(
    queuePath,
    parked.map((record) => JSON.stringify(record) + "\n").join(""),
  );

  const postedNames: string[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      const parsed = JSON.parse(String(init.body)) as {
        records?: Array<{ signalName?: string }>;
      };
      for (const record of parsed.records ?? []) {
        postedNames.push(record.signalName ?? "");
      }
    }
    return new Response(JSON.stringify({ results: { success: [] } }), {
      status: 200,
    });
  });
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const savedKey = process.env.MARGINFRONT_API_KEY;
  process.env.MARGINFRONT_API_KEY = "test-key-ignore-drain";

  let stop: (() => void) | null = null;
  try {
    stop = watchAndForward(livePath, {
      cursorPath: join(dir, "cursor"),
      queuePath,
      authHoldPath: join(dir, "hold.json"),
      matterEnvPath: envPath,
      codexTrustDeps: inMemoryCodexTrust(),
    });
    await run({
      postedNames: () => postedNames,
      queueDepth: () => countQueueRecords(queuePath),
    });
  } finally {
    if (stop) stop();
    if (savedKey === undefined) delete process.env.MARGINFRONT_API_KEY;
    else process.env.MARGINFRONT_API_KEY = savedKey;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

describe("records parked before the rule was written", () => {
  test("CONTROL: with nobody named, both parked records go out", async () => {
    await withParkedQueue(
      "",
      [
        parkedRecord("contract summarized", IGNORED_REPO_AS_GIT_REPORTS_IT),
        parkedRecord("slide deck", "other/repo"),
      ],
      async (rig) => {
        expect(await waitFor(() => rig.queueDepth() === 0)).toBe(true);
        expect([...rig.postedNames()].sort()).toEqual([
          "contract summarized",
          "slide deck",
        ]);
      },
    );
  }, 40_000);

  test("the named repo's parked record never goes out, and the other one does", async () => {
    await withParkedQueue(
      "acme/widgets",
      [
        parkedRecord("contract summarized", IGNORED_REPO_AS_GIT_REPORTS_IT),
        parkedRecord("slide deck", "other/repo"),
      ],
      async (rig) => {
        expect(await waitFor(() => rig.queueDepth() === 0)).toBe(true);
        expect(rig.postedNames()).toEqual(["slide deck"]);
      },
    );
  }, 40_000);

  test("a parked record the meter never placed still goes out", async () => {
    await withParkedQueue(
      "acme/widgets",
      [parkedRecord("contract summarized", null)],
      async (rig) => {
        expect(await waitFor(() => rig.queueDepth() === 0)).toBe(true);
        expect(rig.postedNames()).toEqual(["contract summarized"]);
      },
    );
  }, 40_000);
});

// ===========================================================================
// 11. WHAT `status` READS BACK. Two ways the line can look right and be
//     wrong: a spelling the customer doesn't recognize as their own, and an entry
//     that sits in the ACTIVE list while matching nothing at all.
// ===========================================================================

describe("the status line explains the spelling it reads back", () => {
  test("it says capitals make no difference, because it prints them lowercased", () => {
    const line = ignoreReposStatusLine({
      repos: new Set(["acme-corp/billing"]),
      malformed: [],
      hostPrefixed: [],
    });
    expect(line).toContain("capitals make no difference");
  });
});

describe("resolveIgnoredRepos flags an entry that carries a web address", () => {
  test("a pasted browser address is named back, and still listed", () => {
    const resolved = resolveIgnoredRepos({
      [IGNORE_REPOS_ENV_KEY]: "github.com/acme/billing,acme/widgets",
    });
    expect(resolved.hostPrefixed).toEqual(["github.com/acme/billing"]);
    expect(resolved.malformed).toEqual([]);
    expect([...resolved.repos].sort()).toEqual([
      "acme/widgets",
      "github.com/acme/billing",
    ]);
  });

  test("a pasted git remote is named back too", () => {
    const resolved = resolveIgnoredRepos({
      [IGNORE_REPOS_ENV_KEY]: "git@github.com:acme/billing",
    });
    expect(resolved.hostPrefixed).toEqual(["git@github.com:acme/billing"]);
  });

  test("a plain owner/repo is never flagged", () => {
    const resolved = resolveIgnoredRepos({
      [IGNORE_REPOS_ENV_KEY]: "acme-corp/billing,acme/widgets",
    });
    expect(resolved.hostPrefixed).toEqual([]);
  });

  // GitLab subgroups normalize to group/subgroup/repo, and a group name may carry a
  // dot. Three segments alone is not a web address, so it is not flagged.
  test("a GitLab subgroup path is never flagged", () => {
    const resolved = resolveIgnoredRepos({
      [IGNORE_REPOS_ENV_KEY]: "acme/platform/billing",
    });
    expect(resolved.hostPrefixed).toEqual([]);
    expect([...resolved.repos]).toEqual(["acme/platform/billing"]);
  });

  test("the status line hands the flagged entry back verbatim", () => {
    const line = ignoreReposStatusLine({
      repos: new Set(["github.com/acme/billing"]),
      malformed: [],
      hostPrefixed: ["github.com/acme/billing"],
    });
    expect(line).toContain('"github.com/acme/billing"');
    expect(line).toContain("web address");
  });

  test("with nothing flagged, the line says nothing about web addresses", () => {
    const line = ignoreReposStatusLine({
      repos: new Set(["acme/widgets"]),
      malformed: [],
      hostPrefixed: [],
    });
    expect(line).not.toContain("web address");
  });
});
