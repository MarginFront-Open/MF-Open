// Suite-level safety belt. Vitest loads this before any test file, via setupFiles in
// vitest.config.ts.
//
// WHY IT EXISTS: src/control.ts and src/connector.ts build CONTROL_DIR,
// CLAUDE_SETTINGS_PATH, and CODEX_HOOKS_PATH from homedir() at MODULE LOAD. A test
// that forgets to inject one of those paths reaches the machine's real install no
// matter how many temp dirs it made, and the uninstall reverters DELETE what they
// find there, such as a real ~/.marginfront-ccc/control.
//
// So the suite refuses to start on a HOME that looks like a person's, whenever that
// HOME holds a live install. Escape hatch: CCC_TEST_ALLOW_REAL_HOME=1, for the one
// case where someone deliberately wants to run against their own machine.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HomeGuardDeps {
  home?: string;
  allowRealHome?: string;
  // "Does a live install sit at this path?" Injected so a test can drive
  // the person's-home-WITH-an-install case, which no temp directory can stand in for.
  hasInstall?: (configDir: string) => boolean;
}

function looksLikeAPersonsHome(home: string): boolean {
  // A Windows home is drive-rooted and backslashed (C:\Users\alex), so it matches
  // none of the POSIX prefixes. Compare on one separator and cover both shapes -
  // without the drive arm this guard protects nobody running vitest on Windows.
  const path = home.replace(/\\/g, "/");
  return (
    path === "/root" ||
    path.startsWith("/Users/") ||
    path.startsWith("/home/") ||
    /^[A-Za-z]:\/Users\/./.test(path)
  );
}

export function assertHomeIsThrowaway(deps: HomeGuardDeps = {}): void {
  const home = deps.home ?? homedir();
  const allow = deps.allowRealHome ?? process.env["CCC_TEST_ALLOW_REAL_HOME"];
  const hasInstall = deps.hasInstall ?? ((dir: string) => existsSync(dir));

  if (allow === "1") return;
  if (!looksLikeAPersonsHome(home)) return;

  // All three are built from homedir() at module load, so all three are reachable by a
  // test that forgets to inject. Checking only ~/.marginfront-ccc would wave through a home
  // that still has the coding-agent settings files after an uninstall --purge.
  const guarded = [
    join(home, ".marginfront-ccc"),
    join(home, ".claude", "settings.json"),
    join(home, ".codex", "hooks.json"),
  ];
  const configDir = guarded.find((path) => hasInstall(path)) ?? guarded[0]!;
  if (!hasInstall(configDir)) return;

  throw new Error(
    [
      "",
      "REFUSING TO RUN THE TESTS: HOME is a real user home, and these tests can reach",
      `into it. Found a live file at ${configDir}.`,
      "",
      "What happens if we run anyway: some tests call the real uninstall reverters,",
      "and their paths come from HOME when the module loads. They would delete that",
      "install, including its cap-check script and its hooks.",
      "",
      "Fix: re-run with a throwaway HOME.",
      "  HOME=$(mktemp -d) npx vitest run",
      "",
      // On Windows, os.homedir() reads USERPROFILE, not HOME (libuv uv_os_homedir).
      // Handing over the bash line alone would send a Windows runner in circles.
      "On Windows (PowerShell) - USERPROFILE is the one Node reads, so set both:",
      '  $d = Join-Path $env:TEMP "ccc-$([guid]::NewGuid())"; New-Item -ItemType Directory $d | Out-Null',
      "  $env:USERPROFILE = $d; $env:HOME = $d; npx vitest run",
      "",
      "Override, only if you truly mean to test against this machine:",
      "  CCC_TEST_ALLOW_REAL_HOME=1 npx vitest run",
      "",
    ].join("\n"),
  );
}

assertHomeIsThrowaway();
