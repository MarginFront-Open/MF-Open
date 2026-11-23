// Shared assertion: "only the person who owns this machine account can read this
// file." What that MEANS is different per OS, so the check has to be too.
//
// On macOS and Linux it is the permission bits, and 0600 says it all.
//
// On Windows it is an ACL, and the mode bits are a decoy. NTFS has no mode bits;
// Node's chmod there only flips the read-only attribute and writes no ACL at all,
// so a file that "is 0600" in Node's eyes can still be readable by every account on
// the box. A real Windows run shows exactly that: the cost meter's .env comes back
// 0o666. So on Windows this reads the ACL back OUT of the filesystem with
// icacls rather than trusting the call that set it.

import { expect } from "vitest";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { userInfo } from "node:os";

// The accounts icacls lists for a path, e.g. ["RUNNERADMIN\\runneradmin"]. Each
// entry line looks like "<path> DOMAIN\\user:(F)" for the first and
// "                       DOMAIN\\group:(I)(F)" for the rest.
export function windowsAclText(path: string): string {
  const listed = spawnSync("icacls", [path], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (listed.status !== 0) {
    throw new Error(
      `icacls could not read the ACL of ${path}: ${listed.stdout}${listed.stderr}`,
    );
  }
  return listed.stdout;
}

export function windowsFileAccounts(path: string): string[] {
  const accounts: string[] = [];
  for (const rawLine of windowsAclText(path).split(/\r?\n/)) {
    const line = rawLine.startsWith(path)
      ? rawLine.slice(path.length)
      : rawLine;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Successfully processed")) continue;
    const rights = trimmed.indexOf(":(");
    if (rights === -1) continue;
    accounts.push(trimmed.slice(0, rights));
  }
  return accounts;
}

export function currentAccountName(): string {
  return (process.env["USERNAME"] ?? userInfo().username).toLowerCase();
}

export function expectOwnerOnly(path: string): void {
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    return;
  }
  const accounts = windowsFileAccounts(path);
  // One entry, and it is this account. Anything else - Everyone, BUILTIN\Users,
  // Authenticated Users, an inherited Administrators grant - means the API key in
  // this file is readable by someone who is not the developer.
  //
  // The raw icacls text rides along in the failure message: a bare "expected 1, got
  // 3" cannot tell a grant that never applied from one that applied and left
  // inherited entries behind, and those need opposite fixes.
  const evidence = `icacls said:\n${windowsAclText(path)}`;
  expect(accounts, evidence).toHaveLength(1);
  expect(accounts[0]!.toLowerCase(), evidence).toContain(currentAccountName());
}
