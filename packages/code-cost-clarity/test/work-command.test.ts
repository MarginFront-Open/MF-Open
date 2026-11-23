// work-command.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: the work-item label has to be easy to
// switch, because attribution splits AI spend by (developer, label) and a label
// nobody changes lumps a week of different work into one bucket. So:
//
//   code-cost-clarity work "<name>"   sets it
//   code-cost-clarity work            prints it
//   code-cost-clarity work --clear    clears it
//
// and the reader the RUNNING meter uses picks the new value up on its next record,
// with no stop and no start. That last one is the load-bearing claim: nobody
// restarts a background meter they cannot see.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdWork } from "../src/cli";
import { clearWorkIdsInEnv, renderEnvFile, writeWorkIdToEnv } from "../src/connector";
import { createWorkIdReader } from "../src/forwarder";

const dirs: string[] = [];

function tempEnvFile(contents: string = renderEnvFile()): string {
  const dir = mkdtempSync(join(tmpdir(), "ccc-work-"));
  dirs.push(dir);
  const path = join(dir, "settings.env");
  writeFileSync(path, contents);
  return path;
}

// The reader skips a re-read when the file's modified time has not moved, and two
// writes inside one millisecond really can share a timestamp. Push it forward so the
// test is proving the re-read, not racing the clock.
function touchForward(path: string, secondsAhead: number): void {
  const when = new Date(Date.now() + secondsAhead * 1000);
  utimesSync(path, when, when);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(envPath: string) {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: () => lines.join("\n"),
    err: () => errors.join("\n"),
    deps: {
      readWorkId: createWorkIdReader({ envPath, env: {} }),
      writeWorkId: (value: string) => writeWorkIdToEnv(value, envPath),
      clearWorkId: () => clearWorkIdsInEnv(envPath),
      log: (message: string) => lines.push(message),
      errorLog: (message: string) => errors.push(message),
    },
  };
}

describe("code-cost-clarity work <name>", () => {
  test("it writes the label into the settings file and says so", () => {
    const envPath = tempEnvFile();
    const h = harness(envPath);

    expect(cmdWork(["PROJ-123"], h.deps)).toBe(0);
    expect(readFileSync(envPath, "utf8")).toContain("CCC_WORK_ID=PROJ-123");
    expect(h.out()).toContain("PROJ-123");
  });

  test("it trims what was typed", () => {
    const envPath = tempEnvFile();
    const h = harness(envPath);

    cmdWork(["  PROJ-123  "], h.deps);
    expect(readFileSync(envPath, "utf8")).toContain("CCC_WORK_ID=PROJ-123\n");
  });

  test("an empty name is refused, and the file is untouched", () => {
    const envPath = tempEnvFile();
    const before = readFileSync(envPath, "utf8");
    const h = harness(envPath);

    expect(cmdWork(["   "], h.deps)).toBe(2);
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(h.err()).not.toBe("");
  });
});

describe("code-cost-clarity work", () => {
  test("with nothing set it says none", () => {
    const h = harness(tempEnvFile());
    expect(cmdWork([], h.deps)).toBe(0);
    expect(h.out().toLowerCase()).toContain("none");
  });

  test("with one set it prints it", () => {
    const envPath = tempEnvFile();
    const h = harness(envPath);
    cmdWork(["PROJ-123"], h.deps);
    touchForward(envPath, 2);

    const read = harness(envPath);
    expect(cmdWork([], read.deps)).toBe(0);
    expect(read.out()).toContain("PROJ-123");
  });
});

describe("code-cost-clarity work --clear", () => {
  test("it clears the label", () => {
    const envPath = tempEnvFile();
    const h = harness(envPath);
    cmdWork(["PROJ-123"], h.deps);
    touchForward(envPath, 2);

    const clear = harness(envPath);
    expect(cmdWork(["--clear"], clear.deps)).toBe(0);
    touchForward(envPath, 4);

    const read = harness(envPath);
    cmdWork([], read.deps);
    expect(read.out().toLowerCase()).toContain("none");
  });

  // The reader also accepts a CCC_MATTER_ID key. Clearing only CCC_WORK_ID on an
  // install that sets CCC_MATTER_ID would leave that label printing.
  test("it also clears the older key, so clearing really clears", () => {
    const envPath = tempEnvFile(
      renderEnvFile().replace("CCC_MATTER_ID=", "CCC_MATTER_ID=OLD-1"),
    );
    const h = harness(envPath);
    expect(h.deps.readWorkId().value).toBe("OLD-1");

    cmdWork(["--clear"], h.deps);
    touchForward(envPath, 2);

    const read = harness(envPath);
    expect(read.deps.readWorkId().value).toBeUndefined();
  });
});

describe("the running meter sees the change without a restart", () => {
  test("a reader built before the write returns the new label on its next read", () => {
    const envPath = tempEnvFile();
    const readWorkId = createWorkIdReader({ envPath, env: {} });

    expect(readWorkId().value).toBeUndefined();

    writeWorkIdToEnv("PROJ-123", envPath);
    touchForward(envPath, 2);
    expect(readWorkId().value).toBe("PROJ-123");

    writeWorkIdToEnv("PROJ-205", envPath);
    touchForward(envPath, 4);
    expect(readWorkId().value).toBe("PROJ-205");

    clearWorkIdsInEnv(envPath);
    touchForward(envPath, 6);
    expect(readWorkId().value).toBeUndefined();
  });
});
