// git-coordinates.test.ts
// ---------------------------------------------------------------------------
// Cost-per-PR attribution capture. Proves:
//  - normalizeRemoteUrl handles every remote form (https/ssh/scp/creds/.git);
//  - readGitCoordinates reads a real repo, nulls EACH field independently on
//    failure (no origin / detached HEAD / non-git dir), and never throws (timeout);
//  - resolveSessionCwd resolves an unambiguous cwd but OMITS on ambiguity or a
//    missing path - the guard against silent cost misattribution;
//  - createGitCoordinatesResolver caches only sessionId->cwd and reads
//    branch/SHA FRESH every call, so a mid-session branch switch can't go stale;
//  - resolveCodexSessionCwd maps a Codex conversation.id to the cwd in
//    its rollout's session_meta line, reading that one line and nothing past it,
//    with the same two omit gates; and a real captured Codex OTLP payload run
//    through buildCodexRequestBody lands with repo/branch/commitSha stamped.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  type Dirent,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeRemoteUrl,
  readGitCoordinates,
  resolveSessionCwd,
  resolveCodexSessionCwd,
  createGitCoordinatesResolver,
  type GitCoordinatesResolverDeps,
  type SessionCwdDeps,
} from "../src/git-coordinates";
import { buildCodexRequestBody } from "../src/forwarder";
import type { GitCoordinates, ParsedOtlp } from "../src/types";

const tempRoots: string[] = [];
function makeTempDir(prefix = "ccc-gitco-"): string {
  // .native, not the JS realpathSync: on Windows the runner's TEMP is an 8.3 short
  // path (C:\Users\RUNNER~1\...) and only the OS call expands it back to the real
  // directory name. The decode under test re-encodes names it reads from readdir, so
  // a short-name base could never match and every case here would omit.
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

// Encode an absolute path the way Claude Code names its project dirs: every
// non-alphanumeric character becomes "-". This is exactly the lossy step the decode
// has to survive.
function encodeCwd(absolutePath: string): string {
  return absolutePath.replace(/[^a-zA-Z0-9]/g, "-");
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function initRepo(
  dir: string,
  opts: { origin?: string; branch?: string; commit?: boolean } = {},
): void {
  const { origin, branch = "main", commit = true } = opts;
  git(dir, ["init", "-q", "-b", branch]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  if (origin) git(dir, ["remote", "add", "origin", origin]);
  if (commit) {
    writeFileSync(join(dir, "file.txt"), "hello");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "init"]);
  }
}

// Build a fake ~/.claude/projects with one project dir (named for `cwd`) that holds
// the session's transcript file. Returns the projectsDir path to feed as a dep.
function makeProjectsDirFor(cwd: string, sessionId: string): string {
  const projectsDir = makeTempDir("ccc-projects-");
  const encoded = encodeCwd(cwd);
  const projectDir = join(projectsDir, encoded);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), "{}\n");
  return projectsDir;
}

// One fake Codex rollout: sessions/<y>/<m>/<d>/rollout-<stamp>-<sessionId>.jsonl.
// `lines` is the file body after the first line, so a test can plant a second line
// the resolver must never look at.
interface FakeRollout {
  date: [string, string, string];
  sessionId: string;
  firstLine: string;
  lines?: string[];
}

function sessionMetaLine(cwd: string, sessionId: string): string {
  return JSON.stringify({
    timestamp: "2026-09-15T18:02:28.504Z",
    type: "session_meta",
    payload: {
      session_id: sessionId,
      id: sessionId,
      cwd,
      originator: "codex_exec",
      cli_version: "0.146.0",
    },
  });
}

// Build a fake ~/.codex/sessions tree. Returns the sessions dir to feed as a dep.
function makeCodexSessionsDir(rollouts: FakeRollout[]): string {
  const sessionsDir = makeTempDir("ccc-codex-sessions-");
  for (const rollout of rollouts) {
    const [year, month, day] = rollout.date;
    const dayDir = join(sessionsDir, year, month, day);
    mkdirSync(dayDir, { recursive: true });
    const stamp = `${year}-${month}-${day}T14-02-28`;
    writeFileSync(
      join(dayDir, `rollout-${stamp}-${rollout.sessionId}.jsonl`),
      [rollout.firstLine, ...(rollout.lines ?? [])].join("\n") + "\n",
    );
  }
  return sessionsDir;
}

// ─── normalizeRemoteUrl matrix ────────────────────────────────────────

describe("normalizeRemoteUrl", () => {
  it.each([
    ["https://github.com/owner/repo.git", "owner/repo"],
    ["https://github.com/owner/repo", "owner/repo"],
    ["git@github.com:owner/repo.git", "owner/repo"],
    ["git@github.com:owner/repo", "owner/repo"],
    ["ssh://git@github.com/owner/repo.git", "owner/repo"],
    ["ssh://git@github.com:22/owner/repo.git", "owner/repo"],
    ["git://github.com/owner/repo.git", "owner/repo"],
    ["https://user:token@github.com/owner/repo.git", "owner/repo"],
    ["https://github.com/owner/repo.git/", "owner/repo"],
    ["  https://github.com/owner/repo.git  ", "owner/repo"],
    // Nested groups (GitLab): collapses to the full path minus host, not special-cased.
    ["git@gitlab.com:group/subgroup/repo.git", "group/subgroup/repo"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeRemoteUrl(input)).toBe(expected);
  });

  it.each([
    ["", null],
    ["   ", null],
    ["not-a-url", null],
    ["https://github.com", null],
    // Local-disk remotes have no owner/repo; stamping them would send a
    // filesystem path off-machine.
    ["file:///srv/git/repo.git", null],
    ["/srv/git/repo.git", null],
  ])("unparseable %s -> null", (input, expected) => {
    expect(normalizeRemoteUrl(input as string)).toBe(expected);
  });
});

// ─── readGitCoordinates against a real repo ───────────────────────────

describe("readGitCoordinates", () => {
  it("reads repo, branch, and commitSha from a real repo with an origin", () => {
    const dir = makeTempDir();
    initRepo(dir, {
      origin: "git@github.com:acme/widgets.git",
      branch: "feature/x",
    });
    const coords = readGitCoordinates(dir);
    expect(coords.repo).toBe("acme/widgets");
    expect(coords.branch).toBe("feature/x");
    expect(coords.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("nulls repo when there is no origin remote (partial tuple: branch+sha stay)", () => {
    const dir = makeTempDir();
    initRepo(dir, { branch: "main" }); // no origin
    const coords = readGitCoordinates(dir);
    expect(coords.repo).toBeNull();
    expect(coords.branch).toBe("main");
    expect(coords.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("nulls branch on a detached HEAD (empty --show-current output)", () => {
    const dir = makeTempDir();
    initRepo(dir, { origin: "https://github.com/acme/widgets.git" });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    git(dir, ["checkout", "-q", "--detach", sha]);
    const coords = readGitCoordinates(dir);
    expect(coords.branch).toBeNull();
    expect(coords.commitSha).toBe(sha);
    expect(coords.repo).toBe("acme/widgets");
  });

  it("nulls every field for a directory that is not a git repo", () => {
    const dir = makeTempDir();
    const coords = readGitCoordinates(dir);
    expect(coords).toEqual({ repo: null, branch: null, commitSha: null });
  });

  it("nulls every field and never throws when git times out / errors", () => {
    const timingOut = (() => {
      throw Object.assign(new Error("spawnSync git ETIMEDOUT"), {
        code: "ETIMEDOUT",
      });
    }) as unknown as typeof execFileSync;
    const coords = readGitCoordinates("/some/dir", timingOut);
    expect(coords).toEqual({ repo: null, branch: null, commitSha: null });
  });

  it("passes a 1s timeout to every git invocation", () => {
    const spy = vi
      .fn()
      .mockReturnValue("main\n") as unknown as typeof execFileSync;
    readGitCoordinates("/some/dir", spy);
    const calls = (spy as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(3);
    for (const [, , options] of calls) {
      expect(options.timeout).toBe(1000);
    }
  });
});

// ─── resolveSessionCwd (lossy decode, omit on ambiguity) ──────────

describe("resolveSessionCwd", () => {
  const sessionId = "11111111-2222-3333-4444-555555555555";

  it("resolves an unambiguous cwd to the real git repo", () => {
    const base = makeTempDir();
    const repo = join(base, "myproject");
    mkdirSync(repo);
    initRepo(repo);
    const projectsDir = makeProjectsDirFor(repo, sessionId);

    expect(resolveSessionCwd(sessionId, { projectsDir })).toBe(repo);
  });

  it("resolves a cwd TWO levels below the repo's .git to the leaf cwd (subdirectory)", () => {
    // The monorepo case: the session ran from `<repo>/apps/dashboard`, so `.git`
    // lives two levels ABOVE the cwd. git resolves fine from any subdir; the decode
    // must too, returning the leaf cwd (git walks up from there for the coordinates).
    const base = makeTempDir();
    const repo = join(base, "repo");
    const leaf = join(repo, "apps", "dashboard");
    mkdirSync(leaf, { recursive: true });
    initRepo(repo); // .git only at repo root
    const projectsDir = makeProjectsDirFor(leaf, sessionId);

    expect(resolveSessionCwd(sessionId, { projectsDir })).toBe(leaf);
  });

  it("OMITS when a subdir cwd's encoded name is ambiguous between two in-repo paths (guard still holds)", () => {
    // Both `<repo>/a/child` and `<repo>/a-child` encode to the SAME name and both sit
    // INSIDE the repo, so both survive the inside-a-repo acceptance. The exactly-
    // one-candidate guard must still fire and omit rather than guess.
    const base = makeTempDir();
    const repo = join(base, "repo");
    mkdirSync(repo);
    initRepo(repo);
    const nested = join(repo, "a", "child");
    const dashed = join(repo, "a-child");
    mkdirSync(nested, { recursive: true });
    mkdirSync(dashed, { recursive: true });
    expect(encodeCwd(nested)).toBe(encodeCwd(dashed));

    const projectsDir = makeProjectsDirFor(dashed, sessionId);
    expect(resolveSessionCwd(sessionId, { projectsDir })).toBeNull();
  });

  it("OMITS when the resolved cwd has no .git anywhere up to the filesystem root", () => {
    // A real, fully-decoded directory that is NOT inside any git repo must omit:
    // acceptance covers only subdirectories OF a repo.
    const base = makeTempDir();
    const leaf = join(base, "apps", "dashboard");
    mkdirSync(leaf, { recursive: true }); // no .git at leaf or any ancestor
    const projectsDir = makeProjectsDirFor(leaf, sessionId);

    expect(resolveSessionCwd(sessionId, { projectsDir })).toBeNull();
  });

  it("OMITS (returns null) when the dir name decodes to TWO real repos - never guesses", () => {
    // /base/parent/child AND /base/parent-child both encode to the SAME project-dir
    // name. A greedy decode would pick one and silently bill the wrong repo; the
    // correct decode sees two survivors and omits. THIS is the case that catches it.
    const base = makeTempDir();
    const parent = join(base, "parent");
    const nestedChild = join(parent, "child");
    const dashChild = join(base, "parent-child");
    mkdirSync(nestedChild, { recursive: true });
    mkdirSync(dashChild, { recursive: true });
    initRepo(nestedChild);
    initRepo(dashChild);

    // Both real paths share this encoded form:
    expect(encodeCwd(nestedChild)).toBe(encodeCwd(dashChild));

    // Point the fake session transcript at the ambiguous encoded name.
    const projectsDir = makeProjectsDirFor(dashChild, sessionId);
    expect(resolveSessionCwd(sessionId, { projectsDir })).toBeNull();
  });

  it("OMITS when the decoded path does not exist on disk", () => {
    const base = makeTempDir();
    const projectsDir = makeTempDir("ccc-projects-");
    const ghost = join(base, "does-not-exist");
    const projectDir = join(projectsDir, encodeCwd(ghost));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), "{}\n");

    expect(resolveSessionCwd(sessionId, { projectsDir })).toBeNull();
  });

  it("OMITS when the resolved dir exists but is not a git repo", () => {
    const base = makeTempDir();
    const plain = join(base, "plainfolder");
    mkdirSync(plain); // exists, no .git
    const projectsDir = makeProjectsDirFor(plain, sessionId);

    expect(resolveSessionCwd(sessionId, { projectsDir })).toBeNull();
  });

  it("OMITS when no project dir holds the session transcript", () => {
    const projectsDir = makeTempDir("ccc-projects-");
    mkdirSync(join(projectsDir, "-tmp-somewhere"));
    expect(resolveSessionCwd(sessionId, { projectsDir })).toBeNull();
  });

  it("OMITS when the projects dir itself is missing", () => {
    expect(
      resolveSessionCwd(sessionId, { projectsDir: "/no/such/projects/dir" }),
    ).toBeNull();
  });

  it("returns null for a null/empty sessionId", () => {
    expect(resolveSessionCwd(null)).toBeNull();
    expect(resolveSessionCwd("")).toBeNull();
  });

  // ─── the drive-rooted decode ────────────────────────────
  //
  // These drive a PRETEND Windows disk through the injected fs, so the arm is proven
  // on macOS too; windows-latest proves the same paths against a real one.
  describe("a Windows drive-rooted cwd", () => {
    // node:path joins with "/" off Windows, so compare on a separator-blind form:
    // what is under test is which node the walk reached, not the host's slash.
    const sameNode = (path: string | null) =>
      path === null ? null : path.replace(/[\\/]+/g, "\\");

    // Lookups are separator- and trailing-slash-blind for the same reason.
    function fakeWindowsDisk(
      childDirs: Record<string, string[]>,
      cwdEncodedName: string,
      gitDir: string,
    ): SessionCwdDeps {
      const key = (p: string) => p.replace(/[\\/]+/g, "\\").replace(/\\$/, "");
      const existing = new Set(
        [gitDir, `projects\\${cwdEncodedName}\\${sessionId}.jsonl`].map(key),
      );
      const byParent = new Map<string, string[]>(
        Object.entries(childDirs).map(([parent, names]) => [
          key(parent),
          names,
        ]),
      );
      byParent.set(key("projects"), [cwdEncodedName]);
      return {
        projectsDir: "projects",
        existsSync: (p) => existing.has(key(p)),
        readdirSync: (p) => {
          const names = byParent.get(key(p));
          if (!names) throw new Error(`ENOENT: ${p}`);
          return names.map(
            (name) => ({ name, isDirectory: () => true }) as unknown as Dirent,
          );
        },
      };
    }

    it("walks from C:\\ and resolves the repo", () => {
      const disk = fakeWindowsDisk(
        {
          "C:\\": ["Users", "Windows"],
          "C:\\Users": ["dev", "Public"],
          "C:\\Users\\dev": ["repo"],
          "C:\\Users\\dev\\repo": [],
        },
        "C--Users-dev-repo",
        "C:\\Users\\dev\\repo\\.git",
      );

      expect(sameNode(resolveSessionCwd(sessionId, disk))).toBe(
        "C:\\Users\\dev\\repo",
      );
    });

    it("resolves a subdir cwd whose .git sits two levels up", () => {
      const disk = fakeWindowsDisk(
        {
          "C:\\": ["work"],
          "C:\\work": ["mono"],
          "C:\\work\\mono": ["apps"],
          "C:\\work\\mono\\apps": ["dashboard"],
          "C:\\work\\mono\\apps\\dashboard": [],
        },
        "C--work-mono-apps-dashboard",
        "C:\\work\\mono\\.git",
      );

      expect(sameNode(resolveSessionCwd(sessionId, disk))).toBe(
        "C:\\work\\mono\\apps\\dashboard",
      );
    });

    it("still OMITS rather than guesses when the drive walk is ambiguous", () => {
      // `C:\work\a\child` and `C:\work\a-child` flatten to the same name, and both
      // sit inside the repo. Two survivors must omit, exactly as on POSIX.
      const disk = fakeWindowsDisk(
        {
          "C:\\": ["work"],
          "C:\\work": ["a", "a-child"],
          "C:\\work\\a": ["child"],
          "C:\\work\\a\\child": [],
          "C:\\work\\a-child": [],
        },
        "C--work-a-child",
        "C:\\work\\.git",
      );

      expect(resolveSessionCwd(sessionId, disk)).toBeNull();
    });
  });
});

// ─── createGitCoordinatesResolver (cache cwd, read git fresh) ──────

describe("createGitCoordinatesResolver", () => {
  // A mutable repo state the fake readGitCoordinates reflects, so a test can flip the
  // branch/SHA between resolver calls the way a mid-session `git switch` would.
  function fakeDeps() {
    const repoState: GitCoordinates = {
      repo: "acme/widgets",
      branch: "main",
      commitSha: "a".repeat(40),
    };
    const resolveSessionCwdFn = vi.fn().mockReturnValue("/work/dir");
    const readGitCoordinatesFn = vi.fn(() => ({ ...repoState }));
    const deps: GitCoordinatesResolverDeps = {
      resolveSessionCwdFn,
      readGitCoordinatesFn,
    };
    return { repoState, resolveSessionCwdFn, readGitCoordinatesFn, deps };
  }

  it("caches sessionId->cwd (resolved once) but reads git coordinates FRESH every call", () => {
    const { repoState, resolveSessionCwdFn, readGitCoordinatesFn, deps } =
      fakeDeps();
    const resolve = createGitCoordinatesResolver(deps);

    const first = resolve("sess-1");
    expect(first).toEqual({
      repo: "acme/widgets",
      branch: "main",
      commitSha: "a".repeat(40),
    });

    // Mid-session branch switch: branch AND sha move together.
    repoState.branch = "feature/y";
    repoState.commitSha = "b".repeat(40);

    const second = resolve("sess-1");
    // Fresh read => the NEW branch/sha, never a fresh sha paired with a stale branch.
    expect(second).toEqual({
      repo: "acme/widgets",
      branch: "feature/y",
      commitSha: "b".repeat(40),
    });

    // cwd resolved once (cached); coordinates read on EVERY call (not cached). If the
    // resolver cached the whole tuple, `second` above would be the stale "main" pair.
    expect(resolveSessionCwdFn).toHaveBeenCalledTimes(1);
    expect(readGitCoordinatesFn).toHaveBeenCalledTimes(2);
  });

  it("negative-caches an unresolvable cwd (probes the filesystem once, never reads git)", () => {
    const resolveSessionCwdFn = vi.fn().mockReturnValue(null);
    const readGitCoordinatesFn = vi.fn();
    const resolve = createGitCoordinatesResolver({
      resolveSessionCwdFn,
      readGitCoordinatesFn,
    });

    expect(resolve("sess-x")).toBeNull();
    expect(resolve("sess-x")).toBeNull();
    expect(resolve("sess-x")).toBeNull();
    expect(resolveSessionCwdFn).toHaveBeenCalledTimes(1);
    expect(readGitCoordinatesFn).not.toHaveBeenCalled();
  });

  it("returns null for a null sessionId without touching the filesystem or git", () => {
    const resolveSessionCwdFn = vi.fn();
    const readGitCoordinatesFn = vi.fn();
    const resolve = createGitCoordinatesResolver({
      resolveSessionCwdFn,
      readGitCoordinatesFn,
    });
    expect(resolve(null)).toBeNull();
    expect(resolveSessionCwdFn).not.toHaveBeenCalled();
    expect(readGitCoordinatesFn).not.toHaveBeenCalled();
  });

  it("end-to-end: resolves a real repo through the real decode + git read", () => {
    const base = makeTempDir();
    const repo = join(base, "e2eproject");
    mkdirSync(repo);
    initRepo(repo, {
      origin: "https://github.com/acme/e2e.git",
      branch: "dev",
    });
    const sessionId = "99999999-0000-0000-0000-000000000000";
    const projectsDir = makeProjectsDirFor(repo, sessionId);

    const resolve = createGitCoordinatesResolver({
      sessionCwdDeps: { projectsDir },
    });
    const coords = resolve(sessionId);
    expect(coords?.repo).toBe("acme/e2e");
    expect(coords?.branch).toBe("dev");
    expect(coords?.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("end-to-end: a cwd TWO levels below .git still yields repo/branch/commit", () => {
    // A session run from `<repo>/apps/dashboard`
    // must produce the SAME repo/branch/commit as one run from the repo root, because
    // git (and readGitCoordinates) walk up to the `.git` two levels above the cwd.
    const base = makeTempDir();
    const repo = join(base, "monorepo");
    const leaf = join(repo, "apps", "dashboard");
    mkdirSync(leaf, { recursive: true });
    initRepo(repo, {
      origin: "https://github.com/acme/monorepo.git",
      branch: "develop",
    });
    const sessionId = "88888888-1111-2222-3333-444444444444";
    const projectsDir = makeProjectsDirFor(leaf, sessionId);

    const resolve = createGitCoordinatesResolver({
      sessionCwdDeps: { projectsDir },
    });
    const coords = resolve(sessionId);
    expect(coords?.repo).toBe("acme/monorepo");
    expect(coords?.branch).toBe("develop");
    expect(coords?.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ─── resolveCodexSessionCwd ────────────────────────────────

describe("resolveCodexSessionCwd", () => {
  // Real conversation.id shape from a codex-cli 0.146.0 capture.
  const sessionId = "01a0a63c-0cfe-7381-bdab-9b03ca9d3685";
  const otherId = "01a0a638-c60b-7c51-a4dc-39592d47e90b";

  it("resolves the cwd from the one matching rollout across two dated dirs", () => {
    const base = makeTempDir();
    const repo = join(base, "sam-probe");
    mkdirSync(repo);
    initRepo(repo);
    const codexSessionsDir = makeCodexSessionsDir([
      {
        date: ["2026", "07", "28"],
        sessionId: otherId,
        firstLine: sessionMetaLine(join(base, "elsewhere"), otherId),
      },
      {
        date: ["2026", "09", "15"],
        sessionId,
        firstLine: sessionMetaLine(repo, sessionId),
      },
    ]);

    expect(resolveCodexSessionCwd(sessionId, { codexSessionsDir })).toBe(repo);
  });

  it("OMITS when two rollouts carry the same session id - never guesses", () => {
    const base = makeTempDir();
    const repo = join(base, "repo");
    mkdirSync(repo);
    initRepo(repo);
    const codexSessionsDir = makeCodexSessionsDir([
      {
        date: ["2026", "09", "14"],
        sessionId,
        firstLine: sessionMetaLine(repo, sessionId),
      },
      {
        date: ["2026", "09", "15"],
        sessionId,
        firstLine: sessionMetaLine(repo, sessionId),
      },
    ]);

    expect(resolveCodexSessionCwd(sessionId, { codexSessionsDir })).toBeNull();
  });

  it("returns a Windows drive-letter cwd byte-for-byte when platform is win32", () => {
    const windowsCwd = "C:\\Users\\sam\\proj";
    const codexSessionsDir = makeCodexSessionsDir([
      {
        date: ["2026", "09", "15"],
        sessionId,
        firstLine: sessionMetaLine(windowsCwd, sessionId),
      },
    ]);
    // The rollout tree is real; only the pretend Windows disk is injected. The
    // drive-rooted .git probe must use backslash joins, not the host's "/".
    const existing = new Set([windowsCwd, "C:\\Users\\sam\\proj\\.git"]);
    const existsSync = vi.fn((p: string) => existing.has(p));

    expect(
      resolveCodexSessionCwd(sessionId, {
        codexSessionsDir,
        existsSync,
        platform: "win32",
      }),
    ).toBe(windowsCwd);
    expect(existsSync).toHaveBeenCalledWith("C:\\Users\\sam\\proj\\.git");
  });

  it("finds .git two levels up from a Windows subdir cwd and still returns the leaf", () => {
    const windowsCwd = "C:\\work\\mono\\apps\\dashboard";
    const codexSessionsDir = makeCodexSessionsDir([
      {
        date: ["2026", "09", "15"],
        sessionId,
        firstLine: sessionMetaLine(windowsCwd, sessionId),
      },
    ]);
    const existing = new Set([windowsCwd, "C:\\work\\mono\\.git"]);

    expect(
      resolveCodexSessionCwd(sessionId, {
        codexSessionsDir,
        existsSync: (p) => existing.has(p),
        platform: "win32",
      }),
    ).toBe(windowsCwd);
  });

  it("OMITS a Windows cwd whose drive has no .git anywhere up to the root", () => {
    const windowsCwd = "C:\\Users\\sam\\notes";
    const codexSessionsDir = makeCodexSessionsDir([
      {
        date: ["2026", "09", "15"],
        sessionId,
        firstLine: sessionMetaLine(windowsCwd, sessionId),
      },
    ]);
    const probed: string[] = [];
    const existsSync = (p: string) => {
      probed.push(p);
      return p === windowsCwd;
    };

    expect(
      resolveCodexSessionCwd(sessionId, {
        codexSessionsDir,
        existsSync,
        platform: "win32",
      }),
    ).toBeNull();
    // The walk terminated at the drive root instead of spinning on it.
    expect(probed).toContain("C:\\.git");
    expect(probed.length).toBeLessThan(10);
  });

  it("OMITS when the cwd exists but is not inside a git repo", () => {
    const base = makeTempDir();
    const plain = join(base, "plainfolder");
    mkdirSync(plain);
    const codexSessionsDir = makeCodexSessionsDir([
      {
        date: ["2026", "09", "15"],
        sessionId,
        firstLine: sessionMetaLine(plain, sessionId),
      },
    ]);

    expect(resolveCodexSessionCwd(sessionId, { codexSessionsDir })).toBeNull();
  });

  it("OMITS when the cwd no longer exists on disk", () => {
    const base = makeTempDir();
    const codexSessionsDir = makeCodexSessionsDir([
      {
        date: ["2026", "09", "15"],
        sessionId,
        firstLine: sessionMetaLine(join(base, "gone"), sessionId),
      },
    ]);

    expect(resolveCodexSessionCwd(sessionId, { codexSessionsDir })).toBeNull();
  });

  it("OMITS when the first line is not a session_meta record", () => {
    const base = makeTempDir();
    const repo = join(base, "repo");
    mkdirSync(repo);
    initRepo(repo);
    const codexSessionsDir = makeCodexSessionsDir([
      {
        date: ["2026", "09", "15"],
        sessionId,
        firstLine: JSON.stringify({
          type: "response_item",
          payload: { cwd: repo },
        }),
      },
    ]);

    expect(resolveCodexSessionCwd(sessionId, { codexSessionsDir })).toBeNull();
  });

  it("OMITS when the first line is not JSON at all", () => {
    const codexSessionsDir = makeCodexSessionsDir([
      { date: ["2026", "09", "15"], sessionId, firstLine: "not json" },
    ]);
    expect(resolveCodexSessionCwd(sessionId, { codexSessionsDir })).toBeNull();
  });

  it("reads ONLY the first line: an unparseable second line does not break the resolve", () => {
    const base = makeTempDir();
    const repo = join(base, "repo");
    mkdirSync(repo);
    initRepo(repo);
    const codexSessionsDir = makeCodexSessionsDir([
      {
        date: ["2026", "09", "15"],
        sessionId,
        firstLine: sessionMetaLine(repo, sessionId),
        lines: ["{this is not json and must never be parsed", '{"type":"x"}'],
      },
    ]);

    expect(resolveCodexSessionCwd(sessionId, { codexSessionsDir })).toBe(repo);
  });

  it("reads the first line in full when it is larger than one read chunk", () => {
    // The real session_meta carries Codex's base instructions inline (~22 KB), so
    // the line spans several 16 KB reads before the newline shows up.
    const base = makeTempDir();
    const repo = join(base, "repo");
    mkdirSync(repo);
    initRepo(repo);
    const padded = JSON.stringify({
      type: "session_meta",
      payload: {
        id: sessionId,
        cwd: repo,
        base_instructions: { text: "x".repeat(40_000) },
      },
    });
    const codexSessionsDir = makeCodexSessionsDir([
      {
        date: ["2026", "09", "15"],
        sessionId,
        firstLine: padded,
        lines: ["garbage"],
      },
    ]);

    expect(resolveCodexSessionCwd(sessionId, { codexSessionsDir })).toBe(repo);
  });

  it("only descends year/month/day digit dirs and matches rollout-*-<id>.jsonl", () => {
    const base = makeTempDir();
    const repo = join(base, "repo");
    mkdirSync(repo);
    initRepo(repo);
    const codexSessionsDir = makeCodexSessionsDir([
      {
        date: ["2026", "09", "15"],
        sessionId,
        firstLine: sessionMetaLine(repo, sessionId),
      },
    ]);
    // A non-digit dir holding a look-alike rollout must be ignored, so it can't
    // trip the exactly-one gate; a bare "<id>.jsonl" (Claude's naming) must not
    // match either.
    const decoy = join(codexSessionsDir, "archive", "09", "15");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(
      join(decoy, `rollout-2026-09-15T00-00-00-${sessionId}.jsonl`),
      sessionMetaLine(join(base, "elsewhere"), sessionId) + "\n",
    );
    writeFileSync(
      join(codexSessionsDir, "2026", "09", "15", `${sessionId}.jsonl`),
      sessionMetaLine(join(base, "elsewhere"), sessionId) + "\n",
    );

    expect(resolveCodexSessionCwd(sessionId, { codexSessionsDir })).toBe(repo);
  });

  it("OMITS when the sessions dir is missing, and for a null/empty id", () => {
    expect(
      resolveCodexSessionCwd(sessionId, {
        codexSessionsDir: "/no/such/codex/sessions",
      }),
    ).toBeNull();
    expect(resolveCodexSessionCwd(null)).toBeNull();
    expect(resolveCodexSessionCwd("")).toBeNull();
  });
});

// ─── resolveSessionCwd dispatches Claude then Codex ────────────────────

describe("resolveSessionCwd across both layouts", () => {
  const claudeId = "11111111-2222-3333-4444-555555555555";
  const codexId = "01a0a63c-0cfe-7381-bdab-9b03ca9d3685";

  it("resolves a Claude session from projectsDir and a Codex session from codexSessionsDir", () => {
    const base = makeTempDir();
    const claudeRepo = join(base, "claude-repo");
    const codexRepo = join(base, "codex-repo");
    mkdirSync(claudeRepo);
    mkdirSync(codexRepo);
    initRepo(claudeRepo);
    initRepo(codexRepo);
    const deps: SessionCwdDeps = {
      projectsDir: makeProjectsDirFor(claudeRepo, claudeId),
      codexSessionsDir: makeCodexSessionsDir([
        {
          date: ["2026", "09", "15"],
          sessionId: codexId,
          firstLine: sessionMetaLine(codexRepo, codexId),
        },
      ]),
    };

    expect(resolveSessionCwd(claudeId, deps)).toBe(claudeRepo);
    expect(resolveSessionCwd(codexId, deps)).toBe(codexRepo);
    expect(resolveSessionCwd("unknown-id", deps)).toBeNull();
  });

  it("still resolves Codex when the Claude projects dir does not exist", () => {
    const base = makeTempDir();
    const codexRepo = join(base, "codex-repo");
    mkdirSync(codexRepo);
    initRepo(codexRepo);
    const deps: SessionCwdDeps = {
      projectsDir: join(base, "no-claude-here"),
      codexSessionsDir: makeCodexSessionsDir([
        {
          date: ["2026", "09", "15"],
          sessionId: codexId,
          firstLine: sessionMetaLine(codexRepo, codexId),
        },
      ]),
    };
    expect(resolveSessionCwd(codexId, deps)).toBe(codexRepo);
  });
});

// ─── Codex end-to-end through the forwarder ────────────────

describe("Codex usage record carries repo/branch/commitSha end-to-end", () => {
  // The captured line: a real `codex exec` on codex-cli 0.146.0. Its
  // codex.sse_event response.completed record carries the session as
  // conversation.id (no session.id attribute exists on Codex records), and that id
  // equals the uuid in the rollout file name and in session_meta payload.id.
  const fixture = JSON.parse(
    readFileSync(
      join(__dirname, "fixtures", "codex-exec-capture-0.146.json"),
      "utf8",
    ),
  ) as { capture: ParsedOtlp };
  const capturedConversationId = "01a0a63c-0cfe-7381-bdab-9b03ca9d3685";

  it("stamps the probe repo's coordinates onto the captured codex.sse_event", () => {
    const base = makeTempDir();
    const repo = join(base, "sam-probe");
    mkdirSync(repo);
    initRepo(repo, {
      origin: "git@github.com:example/sam-probe.git",
      branch: "main",
    });
    const expectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();

    const resolveGitCoordinates = createGitCoordinatesResolver({
      sessionCwdDeps: {
        projectsDir: makeTempDir("ccc-projects-"),
        codexSessionsDir: makeCodexSessionsDir([
          {
            date: ["2026", "09", "15"],
            sessionId: capturedConversationId,
            firstLine: sessionMetaLine(repo, capturedConversationId),
            lines: ['{"type":"response_item","payload":{"never":"read"}}'],
          },
        ]),
      },
    });

    const { records } = buildCodexRequestBody(fixture.capture, {
      resolveGitCoordinates,
      fallbackCustomerId: "sam@example.com",
    });

    expect(records).toHaveLength(1);
    expect(records[0].inputTokens).toBe(11173);
    expect(records[0].metadata).toMatchObject({
      source: "codex",
      sessionId: capturedConversationId,
      repo: "example/sam-probe",
      branch: "main",
      commitSha: expectedSha,
    });
  });
});
