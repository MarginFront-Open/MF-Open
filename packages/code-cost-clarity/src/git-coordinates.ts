// git-coordinates.ts - cost-per-PR attribution capture.
//
// Given a Claude Code / Codex session, resolve the working directory it ran in and
// read {repo, branch, commitSha} from git plumbing, so every usage record can be
// attributed to the repo/branch/commit that produced the spend.
//
// PRIVACY CONTRACT: the only thing that ever leaves the machine is those three git
// coordinate strings. We read DIRECTORY and FILE NAMES under ~/.claude/projects/ and
// ~/.codex/sessions/ to map a session to its cwd - never transcript CONTENTS. The one
// exception is Codex, whose rollout file NAME does not carry the cwd: there we read
// the first line only (the session_meta record, which holds the cwd) and stop at the
// first newline. We run git plumbing (rev-parse / branch / remote), never anything
// that exposes file contents. git's own stdout/stderr is never logged on the failure
// path.

import { execFileSync as nodeExecFileSync } from "node:child_process";
import {
  existsSync as nodeExistsSync,
  readdirSync as nodeReaddirSync,
  openSync,
  readSync,
  closeSync,
  Dirent,
} from "node:fs";
import {
  join,
  dirname,
  posix as posixPath,
  win32 as win32Path,
} from "node:path";
import { homedir } from "node:os";
import type { GitCoordinates } from "./types";

// Each git read is capped so a wedged/hung git can never stall a flush.
const GIT_TIMEOUT_MS = 1000;

// Belt-and-braces bound on the filesystem walk that decodes a project-dir name back
// to a cwd. Real home directories never approach this; it only stops a pathological
// tree from spinning.
const MAX_DECODE_PROBES = 10_000;

type ExecFileSync = typeof nodeExecFileSync;
type ReaddirSync = (p: string, opts: { withFileTypes: true }) => Dirent[];
type ExistsSync = (p: string) => boolean;

// Run one git plumbing command in `cwd`; return trimmed stdout, or null on ANY
// failure - non-zero exit, timeout, git missing, or empty output. Never throws, and
// never surfaces git's output on the failure path (privacy).
function runGit(
  execFileSync: ExecFileSync,
  cwd: string,
  args: string[],
): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = typeof out === "string" ? out.trim() : "";
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

// Normalize a git remote URL to "owner/repo". Handles https, ssh://, git://, and the
// scp-like git@host:owner/repo form; strips embedded credentials and a trailing .git.
// Returns null when no path is recoverable.
export function normalizeRemoteUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  let hostRelativePath: string;

  // scp-like syntax (user@host:owner/repo) has no scheme and its first "/" sits
  // AFTER the colon - so it must be matched before the URL branch, which would
  // otherwise split on that slash and grab the wrong path.
  const scpMatch = trimmed.match(/^[^/@]+@[^/:]+:(.+)$/);
  if (scpMatch) {
    hostRelativePath = scpMatch[1];
  } else {
    const schemeMatch = trimmed.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.+)$/);
    const afterScheme = schemeMatch ? schemeMatch[1] : trimmed;
    const afterCredentials = afterScheme.replace(/^[^/@]*@/, "");
    const firstSlash = afterCredentials.indexOf("/");
    if (firstSlash === -1) return null;
    // Empty host = a local-disk remote (file:///srv/repo, /srv/repo.git). There is
    // no owner/repo there, and stamping it would send a filesystem path off-machine.
    if (firstSlash === 0) return null;
    hostRelativePath = afterCredentials.slice(firstSlash + 1);
  }

  const ownerRepo = hostRelativePath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");

  return ownerRepo.length > 0 ? ownerRepo : null;
}

export interface ReadGitCoordinatesDeps {
  // All three default to the real machine; they exist so the home-guard case below
  // can be tested without a real dotfiles home to run inside.
  homeDir?: string;
  existsSync?: ExistsSync;
  platform?: NodeJS.Platform;
}

// Trailing separators, and on Windows capitals, are spelling rather than a different
// directory. Everything else is compared verbatim, because on Linux and macOS two
// paths that differ by a letter really are two directories.
function isSamePath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const strip = (path: string): string => path.replace(/[\\/]+$/, "");
  const a = strip(left);
  const b = strip(right);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// The nearest enclosing repository's root directory, or null when there is none up
// to the filesystem root. `.git` is a FILE in a worktree and a directory otherwise,
// so existsSync answers both.
function nearestRepoRoot(
  leafDir: string,
  existsSync: ExistsSync,
  paths: { join: typeof join; dirname: typeof dirname } = { join, dirname },
): string | null {
  let current = leafDir;
  for (;;) {
    if (existsSync(paths.join(current, ".git"))) return current;
    const parent = paths.dirname(current);
    if (parent === current) return null; // reached filesystem root
    current = parent;
  }
}

// Read {repo, branch, commitSha} FRESH for a working directory. Never throws;
// per-field null on any failure. Reads all three together so the tuple is internally
// consistent: a mid-session branch switch can never pair a fresh SHA with a
// stale branch, because nothing here is cached.
//
// THE HOME GUARD: when the ONLY enclosing repository is the home directory itself,
// there are no coordinates to report. A home that is a dotfiles checkout otherwise
// sits "inside a repo" everywhere on the machine, so every session on it lands on the
// dotfiles repo - wrong on its own, and next to an ignore rule it would let one entry
// stop the machine sending anything at all.
export function readGitCoordinates(
  cwd: string,
  execFileSync: ExecFileSync = nodeExecFileSync,
  deps: ReadGitCoordinatesDeps = {},
): GitCoordinates {
  const existsSync = deps.existsSync ?? nodeExistsSync;
  const platform = deps.platform ?? process.platform;
  const paths = platform === "win32" ? win32Path : posixPath;
  const repoRoot = nearestRepoRoot(cwd, existsSync, paths);
  if (
    repoRoot !== null &&
    isSamePath(repoRoot, deps.homeDir ?? homedir(), platform)
  ) {
    return { repo: null, branch: null, commitSha: null };
  }

  const commitSha = runGit(execFileSync, cwd, ["rev-parse", "HEAD"]);
  // `git branch --show-current` prints an EMPTY string (exit 0) on a detached HEAD;
  // runGit maps empty output to null, so detached HEAD => branch null.
  const branch = runGit(execFileSync, cwd, ["branch", "--show-current"]);
  const remote = runGit(execFileSync, cwd, ["remote", "get-url", "origin"]);
  const repo = remote ? normalizeRemoteUrl(remote) : null;
  return { repo, branch, commitSha };
}

// Re-encode a real directory NAME the way Claude Code encodes a cwd into a
// project-dir name: every non-alphanumeric character becomes "-". This is the key to
// a NON-GUESSING decode - instead of inverting the lossy encoding (impossible: "/",
// ".", "_" and a literal "-" all become "-"), we re-encode REAL directory entries and
// keep only the ones whose encoding matches.
function encodeSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "-");
}

function listChildDirectories(dir: string, readdirSync: ReaddirSync): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// True when `leafDir` sits inside a git repo: walk UP checking each ancestor for a
// `.git` entry (a FILE for worktrees, a dir otherwise), stopping at the filesystem
// root. This is what lets a session run from a SUBDIRECTORY of a repo (the monorepo
// `cd apps/dashboard` case) still attribute - git itself resolves from any subdir by
// walking up to .git, and readGitCoordinates runs git from this cwd, so it does too.
function isInsideGitRepo(
  leafDir: string,
  existsSync: ExistsSync,
  paths: { join: typeof join; dirname: typeof dirname } = { join, dirname },
): boolean {
  return nearestRepoRoot(leafDir, existsSync, paths) !== null;
}

// Walk the real filesystem from `baseDir`, consuming the encoded name segment by
// segment, and collect every real path that (a) fully consumes the name and (b) is
// inside a git repo (`.git` at the leaf OR any ancestor up to root). Because a single
// encoded name can correspond to several real paths (the encoding is lossy), this can
// return zero, one, or many candidates - the caller OMITS on anything but exactly one.
function collectCwdCandidates(
  baseDir: string,
  remainingEncoded: string,
  existsSync: ExistsSync,
  readdirSync: ReaddirSync,
  budget: { probes: number },
): string[] {
  if (budget.probes++ > MAX_DECODE_PROBES) return [];

  if (remainingEncoded === "") {
    return isInsideGitRepo(baseDir, existsSync) ? [baseDir] : [];
  }

  const results: string[] = [];
  for (const childName of listChildDirectories(baseDir, readdirSync)) {
    const encoded = encodeSegment(childName);
    const childPath = join(baseDir, childName);
    if (remainingEncoded === encoded) {
      results.push(
        ...collectCwdCandidates(childPath, "", existsSync, readdirSync, budget),
      );
    } else if (remainingEncoded.startsWith(encoded + "-")) {
      results.push(
        ...collectCwdCandidates(
          childPath,
          remainingEncoded.slice(encoded.length + 1),
          existsSync,
          readdirSync,
          budget,
        ),
      );
    }
  }
  return results;
}

type ReadFirstLine = (filePath: string) => string | null;

export interface SessionCwdDeps {
  projectsDir?: string;
  codexSessionsDir?: string;
  existsSync?: ExistsSync;
  readdirSync?: ReaddirSync;
  readFirstLine?: ReadFirstLine;
  platform?: NodeJS.Platform;
}

// The encoding flattens the root too, so the walk has to recover it first: "/Users/x"
// arrives as "-Users-x", "C:\Users\x" as "C--Users-x". A POSIX absolute path can never
// begin with a letter, so the drive shape is unambiguous. Null for anything else we
// cannot walk (a relative cwd, a UNC share) - the caller then omits.
function decodeRoot(
  encodedName: string,
): { root: string; remainder: string } | null {
  const drive = encodedName.match(/^([A-Za-z])--/);
  if (drive) {
    return { root: `${drive[1]}:\\`, remainder: encodedName.slice(3) };
  }
  if (encodedName.startsWith("-")) {
    return { root: "/", remainder: encodedName.slice(1) };
  }
  return null;
}

// Resolve a Claude Code session's working directory, reading ONLY directory and file
// NAMES under ~/.claude/projects/ (never transcript contents). Two omit gates: if
// the sessionId's transcript is not in exactly one project dir, omit; if that dir's
// name decodes to anything but exactly one real git repo, omit.
// Never guesses - a wrong cwd would silently bill the wrong project.
export function resolveClaudeSessionCwd(
  sessionId: string | null,
  deps: SessionCwdDeps = {},
): string | null {
  if (!sessionId) return null;

  const projectsDir =
    deps.projectsDir ?? join(homedir(), ".claude", "projects");
  const existsSync = deps.existsSync ?? nodeExistsSync;
  const readdirSync = deps.readdirSync ?? (nodeReaddirSync as ReaddirSync);

  let projectDirNames: string[];
  try {
    projectDirNames = readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }

  const transcriptName = `${sessionId}.jsonl`;
  const matchingDirs = projectDirNames.filter((name) =>
    existsSync(join(projectsDir, name, transcriptName)),
  );
  if (matchingDirs.length !== 1) return null;

  const decoded = decodeRoot(matchingDirs[0]);
  if (!decoded) return null;

  const candidates = collectCwdCandidates(
    decoded.root,
    decoded.remainder,
    existsSync,
    readdirSync,
    { probes: 0 },
  );
  return candidates.length === 1 ? candidates[0] : null;
}

// The session_meta line carries Codex's full base instructions inline (~22 KB on
// codex-cli 0.146.0), so the first line is large; past this cap it is not one.
const CODEX_FIRST_LINE_MAX_BYTES = 1024 * 1024;
const CODEX_READ_CHUNK_BYTES = 16 * 1024;

// Null when no newline arrives within the cap or on any failure. The tail of the
// last chunk past the newline is dropped unparsed (privacy: line 2 is transcript).
function readFirstLineBounded(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const chunk = Buffer.alloc(CODEX_READ_CHUNK_BYTES);
    const pieces: Buffer[] = [];
    let total = 0;
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      const read = chunk.subarray(0, bytesRead);
      const newlineAt = read.indexOf(0x0a);
      if (newlineAt !== -1) {
        pieces.push(Buffer.from(read.subarray(0, newlineAt)));
        return Buffer.concat(pieces).toString("utf8");
      }
      pieces.push(Buffer.from(read));
      total += bytesRead;
      if (total > CODEX_FIRST_LINE_MAX_BYTES) return null;
    }
    return pieces.length > 0 ? Buffer.concat(pieces).toString("utf8") : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// Codex names rollouts rollout-<ISO timestamp>-<uuid>.jsonl under sessions/YYYY/MM/DD/.
function isCodexRolloutFor(fileName: string, sessionId: string): boolean {
  return (
    fileName.startsWith("rollout-") &&
    fileName.endsWith(`-${sessionId}.jsonl`) &&
    fileName.length > `rollout--${sessionId}.jsonl`.length
  );
}

function listEntries(dir: string, readdirSync: ReaddirSync): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Only the YYYY/MM/DD digit dirs are descended, so the walk is bounded and never
// strays into anything else that may live under sessions/.
function findCodexRollouts(
  sessionsDir: string,
  sessionId: string,
  readdirSync: ReaddirSync,
): string[] {
  const matches: string[] = [];
  let probes = 0;
  const digitDirs = (dir: string, width: number): string[] =>
    listEntries(dir, readdirSync)
      .filter(
        (entry) =>
          entry.isDirectory() && new RegExp(`^\\d{${width}}$`).test(entry.name),
      )
      .map((entry) => join(dir, entry.name));

  for (const yearDir of digitDirs(sessionsDir, 4)) {
    for (const monthDir of digitDirs(yearDir, 2)) {
      for (const dayDir of digitDirs(monthDir, 2)) {
        if (probes++ > MAX_DECODE_PROBES) return matches;
        for (const entry of listEntries(dayDir, readdirSync)) {
          if (entry.isFile() && isCodexRolloutFor(entry.name, sessionId)) {
            matches.push(join(dayDir, entry.name));
          }
        }
      }
    }
  }
  return matches;
}

// Codex stores the cwd verbatim from the launching process, so a Windows session
// arrives as "C:\Users\sam\proj" and the .git probe must walk with backslashes.
function isAbsoluteCwd(cwd: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(cwd);
  return cwd.startsWith("/");
}

// Resolve a Codex session's working directory from its rollout file under
// ~/.codex/sessions/. PRIVACY: this is the one place the resolver opens a transcript
// file, and it reads exactly one line - the leading session_meta record, which is
// where Codex writes the cwd - stopping at the first newline. The conversation that
// follows is never read, parsed, cached, or logged; on any failure the answer is null
// and nothing about the file is surfaced. Same two omit gates as the Claude arm:
// exactly one rollout for the sessionId, and a cwd that exists and sits inside
// exactly one real git repo, else omit.
export function resolveCodexSessionCwd(
  sessionId: string | null,
  deps: SessionCwdDeps = {},
): string | null {
  if (!sessionId) return null;

  const sessionsDir =
    deps.codexSessionsDir ?? join(homedir(), ".codex", "sessions");
  const existsSync = deps.existsSync ?? nodeExistsSync;
  const readdirSync = deps.readdirSync ?? (nodeReaddirSync as ReaddirSync);
  const readFirstLine = deps.readFirstLine ?? readFirstLineBounded;
  const platform = deps.platform ?? process.platform;

  const rollouts = findCodexRollouts(sessionsDir, sessionId, readdirSync);
  if (rollouts.length !== 1) return null;

  const firstLine = readFirstLine(rollouts[0]);
  if (!firstLine) return null;

  let cwd: string;
  try {
    const meta = JSON.parse(firstLine) as {
      type?: unknown;
      payload?: { cwd?: unknown };
    };
    if (meta?.type !== "session_meta") return null;
    if (typeof meta.payload?.cwd !== "string") return null;
    cwd = meta.payload.cwd;
  } catch {
    return null;
  }

  if (!isAbsoluteCwd(cwd, platform)) return null;
  if (!existsSync(cwd)) return null;
  const paths = platform === "win32" ? win32Path : posixPath;
  return isInsideGitRepo(cwd, existsSync, paths) ? cwd : null;
}

// Resolve the working directory a session ran in, whichever coding agent produced
// it: Claude Code's ~/.claude/projects/ layout first, then Codex's ~/.codex/sessions/
// layout. Session ids are UUIDs minted by different tools, so a hit in one layout is
// never checked against the other.
export function resolveSessionCwd(
  sessionId: string | null,
  deps: SessionCwdDeps = {},
): string | null {
  return (
    resolveClaudeSessionCwd(sessionId, deps) ??
    resolveCodexSessionCwd(sessionId, deps)
  );
}

export interface GitCoordinatesResolverDeps {
  execFileSync?: ExecFileSync;
  sessionCwdDeps?: SessionCwdDeps;
  resolveSessionCwdFn?: (
    sessionId: string | null,
    deps?: SessionCwdDeps,
  ) => string | null;
  readGitCoordinatesFn?: (
    cwd: string,
    execFileSync?: ExecFileSync,
  ) => GitCoordinates;
}

// Build the resolver the live watcher injects into the pure builders. It caches ONLY
// sessionId -> cwd: a session's cwd is fixed at launch, so caching it is safe;
// branch and SHA move mid-session, so they are read FRESH on every call and NEVER
// cached. A null cwd is cached too - a sessionId->null IS a sessionId->cwd mapping,
// and a session's transcript exists before its telemetry flushes, so a session that
// won't resolve now won't resolve later either.
export function createGitCoordinatesResolver(
  deps: GitCoordinatesResolverDeps = {},
): (sessionId: string | null) => GitCoordinates | null {
  const execFileSync = deps.execFileSync ?? nodeExecFileSync;
  const resolveCwd = deps.resolveSessionCwdFn ?? resolveSessionCwd;
  const readCoords = deps.readGitCoordinatesFn ?? readGitCoordinates;
  const cwdBySession = new Map<string, string | null>();

  return (sessionId: string | null): GitCoordinates | null => {
    if (!sessionId) return null;

    let cwd: string | null;
    if (cwdBySession.has(sessionId)) {
      cwd = cwdBySession.get(sessionId) ?? null;
    } else {
      cwd = resolveCwd(sessionId, deps.sessionCwdDeps);
      cwdBySession.set(sessionId, cwd);
    }
    if (!cwd) return null;

    return readCoords(cwd, execFileSync);
  };
}
