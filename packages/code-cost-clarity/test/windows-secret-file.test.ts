// windows-secret-file.test.ts: the .env that holds the API key
// is actually owner-only, including on Windows.
//
// THE HOLE THIS FILLS. NTFS has no permission bits; Node's chmod there only
// flips the read-only attribute and writes no ACL, so a file written with mode
// 0600 stays readable by every account on the machine, and a mode-bit
// assertion reads 0o666 back without noticing.
//
// So on Windows the assertion reads the ACL back out of the filesystem with
// icacls instead of trusting the call that set it. The negative control below
// is the load-bearing part: it writes a file the plain chmod way and proves
// that file FAILS the assertion. Without it, "owner-only" could be a check that
// nothing can fail.

import { test, expect, describe } from "vitest";
import {
  writeFileSync,
  readFileSync,
  chmodSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSecretFile, restrictToOwnerOnWindows } from "../src/connector";
import {
  expectOwnerOnly,
  windowsFileAccounts,
  windowsAclText,
  currentAccountName,
} from "./helpers/owner-only";

const onWindows = process.platform === "win32";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ccc-secret-"));
}

describe("writeSecretFile", () => {
  test("a new secrets file is owner-only", () => {
    const dir = tmp();
    const path = join(dir, ".env");
    writeSecretFile(path, "MARGINFRONT_API_KEY=\n");
    expectOwnerOnly(path);
    rmSync(dir, { recursive: true, force: true });
  });

  test("rewriting an EXISTING secrets file keeps it owner-only", () => {
    const dir = tmp();
    const path = join(dir, ".env");
    // A file created wide and never locked down.
    writeFileSync(path, "MARGINFRONT_API_KEY=\n");
    chmodSync(path, 0o644);

    writeSecretFile(path, "MARGINFRONT_API_KEY=\nCCC_CACHE_WRITE_TTL=5m\n");
    expectOwnerOnly(path);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the contents are what was asked for, not just the permissions", () => {
    const dir = tmp();
    const path = join(dir, ".env");
    writeSecretFile(path, "CCC_DEVELOPER_EMAIL=dev@example.com\n");
    // A permission check that passes must never stand in for a file that was
    // never written.
    expect(readFileSync(path, "utf8")).toBe(
      "CCC_DEVELOPER_EMAIL=dev@example.com\n",
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// THE LOCKDOWN-FAILED WARNING
//
// It must never hand the user `icacls <path> /inheritance:r /grant:r <account>:F`,
// which the note above OWNER_ONLY_POWERSHELL in connector.ts explains: it exits 0 and
// leaves SYSTEM and Administrators on a file holding an API key. The code builds the
// ACL through .NET, so the message has to say so.
//
// nodePlatform is forced to win32 so this runs on any host; restrictToOwnerOnWindows
// then fails on macOS/Linux (no powershell), which is exactly the branch under test.
// ---------------------------------------------------------------------------

describe("the warning when the Windows lockdown fails", () => {
  function warningFor(): string {
    const dir = tmp();
    const path = join(dir, ".env");
    const warnings: string[] = [];
    writeSecretFile(path, "MARGINFRONT_API_KEY=\n", {
      warn: (m) => warnings.push(m),
      nodePlatform: "win32",
    });
    rmSync(dir, { recursive: true, force: true });
    return warnings.join("\n");
  }

  test.skipIf(onWindows)("it never hands out the icacls command", () => {
    const warning = warningFor();

    expect(warning).not.toMatch(/icacls/i);
    expect(warning).not.toMatch(/inheritance:r/);
    expect(warning).not.toMatch(/grant:r/);
  });

  test.skipIf(onWindows)(
    "it says what happened, why, and exactly what to do",
    () => {
      const warning = warningFor();

      expect(warning).toMatch(/What happened:/);
      expect(warning).toMatch(/Why:/);
      expect(warning).toMatch(/Fix/);
      // It names the mechanism the code actually uses.
      expect(warning).toMatch(/PowerShell/);
      expect(warning).toMatch(/ {2}1\. /);
      expect(warning).toMatch(/ {2}2\. /);
      expect(warning).toMatch(/ {2}3\. /);
      expect(warning).toMatch(/MARGINFRONT_API_KEY/);
      // Printed text: no em dashes.
      expect(warning).not.toMatch(/—/);
    },
  );

  test.skipIf(onWindows)("it surfaces why Windows refused", () => {
    const warning = warningFor();

    expect(warning).toMatch(/Windows said: \S/);
  });
});

// ---------------------------------------------------------------------------
// THE NEGATIVE CONTROL
// ---------------------------------------------------------------------------

describe("the assertion can actually fail", () => {
  test.runIf(onWindows)(
    "mode 0600 plus chmod does NOT produce an owner-only file on Windows",
    () => {
      const dir = tmp();
      const path = join(dir, ".env");
      // The plain chmod approach.
      writeFileSync(path, "MARGINFRONT_API_KEY=\n", { mode: 0o600 });
      chmodSync(path, 0o600);

      const accounts = windowsFileAccounts(path);
      // chmod leaves the inherited ACL untouched on Windows, so accounts beyond this developer still hold
      // rights on a file containing an API key.
      expect(accounts.length).toBeGreaterThan(1);
      expect(() => expectOwnerOnly(path)).toThrow();
      rmSync(dir, { recursive: true, force: true });
    },
  );

  // Runs BEFORE the ACL assertions so a red build names the cause. If icacls itself
  // refuses - a name it cannot resolve, a volume with no ACL support - every
  // owner-only assertion fails identically, and this is the one that says why.
  test.runIf(onWindows)("the icacls call itself succeeds", () => {
    const dir = tmp();
    const path = join(dir, ".env");
    writeFileSync(path, "MARGINFRONT_API_KEY=\n");

    const outcome = restrictToOwnerOnWindows(path);
    expect(
      outcome.ok,
      `icacls exited ${outcome.status} for account "${outcome.account}": ${outcome.output}`,
    ).toBe(true);
    // And what it left behind, in full, whether or not it claimed success.
    expect(
      windowsFileAccounts(path),
      `after a "successful" icacls, the ACL is:\n${windowsAclText(path)}`,
    ).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test.runIf(onWindows)(
    "icacls reports exactly this account after writeSecretFile",
    () => {
      const dir = tmp();
      const path = join(dir, ".env");
      writeSecretFile(path, "MARGINFRONT_API_KEY=\n");

      const accounts = windowsFileAccounts(path);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]!.toLowerCase()).toContain(currentAccountName());
      for (const stranger of [
        "everyone",
        "builtin\\users",
        "authenticated users",
      ]) {
        expect(accounts.join(" ").toLowerCase()).not.toContain(stranger);
      }
      rmSync(dir, { recursive: true, force: true });
    },
  );

  test.runIf(!onWindows)(
    "a world-readable file fails the owner-only assertion here too",
    () => {
      const dir = tmp();
      const path = join(dir, ".env");
      writeFileSync(path, "MARGINFRONT_API_KEY=\n", { mode: 0o644 });
      chmodSync(path, 0o644);
      expect(() => expectOwnerOnly(path)).toThrow();
      rmSync(dir, { recursive: true, force: true });
    },
  );
});
