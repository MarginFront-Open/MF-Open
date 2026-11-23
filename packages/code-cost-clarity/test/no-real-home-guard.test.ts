// no-real-home-guard.test.ts - the suite's own safety belt.
//
// WHAT THIS FILE PROVES: the guard wired into vitest.config.ts refuses to let the
// suite run when HOME is a real user home holding a live ~/.marginfront-ccc install,
// stays out of the way on a throwaway HOME, and tells the runner exactly what to type
// instead. Without it, one test that forgets to inject a path deletes the runner's
// real Spend Control install.

import { test, expect, describe } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertHomeIsThrowaway } from "./helpers/no-real-home";

const LIVE_INSTALL = () => true;
const NO_INSTALL = () => false;

describe("it stops the suite on a real home with a live install", () => {
  // The drive-rooted shapes cover Windows homes, which match none of the POSIX
  // prefixes. Without them the guard waves every Windows machine straight through.
  for (const home of [
    "/Users/alex",
    "/home/alex",
    "/root",
    "C:\\Users\\alex",
    "D:\\Users\\alex",
    "C:/Users/alex",
  ]) {
    test(`${home}`, () => {
      expect(() =>
        assertHomeIsThrowaway({
          home,
          hasInstall: LIVE_INSTALL,
          allowRealHome: "",
        }),
      ).toThrow(/REFUSING TO RUN THE TESTS/);
    });
  }

  // join, not a slashed literal: the guard builds the path with node:path, which
  // renders backslashes on Windows. What is asserted is WHICH install it names.
  test("it names the install it is protecting", () => {
    expect(() =>
      assertHomeIsThrowaway({
        home: "/Users/alex",
        hasInstall: LIVE_INSTALL,
        allowRealHome: "",
      }),
    ).toThrow(join("/Users/alex", ".marginfront-ccc"));
  });

  test("on Windows it names the drive-rooted install", () => {
    expect(() =>
      assertHomeIsThrowaway({
        home: "C:\\Users\\alex",
        hasInstall: LIVE_INSTALL,
        allowRealHome: "",
      }),
    ).toThrow(join("C:\\Users\\alex", ".marginfront-ccc"));
  });

  test("it hands a Windows runner a command that works there", () => {
    // HOME alone is a no-op on Windows: os.homedir() reads USERPROFILE.
    expect(() =>
      assertHomeIsThrowaway({
        home: "C:\\Users\\alex",
        hasInstall: LIVE_INSTALL,
        allowRealHome: "",
      }),
    ).toThrow("$env:USERPROFILE = $d; $env:HOME = $d; npx vitest run");
  });

  // The whole value of the message: a runner who hits this must not have to guess.
  test("it hands over the exact command to run instead", () => {
    expect(() =>
      assertHomeIsThrowaway({
        home: "/Users/alex",
        hasInstall: LIVE_INSTALL,
        allowRealHome: "",
      }),
    ).toThrow("HOME=$(mktemp -d) npx vitest run");
  });
});

describe("it stays out of the way otherwise", () => {
  test("a throwaway HOME passes even with an install in it", () => {
    expect(() =>
      assertHomeIsThrowaway({
        home: "/private/tmp/ccc-throwaway",
        hasInstall: LIVE_INSTALL,
      }),
    ).not.toThrow();
  });

  test("a real home with no install passes", () => {
    expect(() =>
      assertHomeIsThrowaway({ home: "/Users/alex", hasInstall: NO_INSTALL }),
    ).not.toThrow();
  });

  // The shape the Windows CI lane actually runs under (RUNNER_TEMP, not a user
  // profile). A drive-rooted arm that flagged every C:\ path would red the lane.
  for (const home of [
    "D:\\a\\_temp\\ccc-home-4c61421a",
    "C:\\Windows\\Temp\\ccc-home-4c61421a",
  ]) {
    test(`a Windows throwaway HOME passes even with an install in it: ${home}`, () => {
      expect(() =>
        assertHomeIsThrowaway({ home, hasInstall: LIVE_INSTALL }),
      ).not.toThrow();
    });
  }

  test("CCC_TEST_ALLOW_REAL_HOME=1 is the deliberate override", () => {
    expect(() =>
      assertHomeIsThrowaway({
        home: "/Users/alex",
        hasInstall: LIVE_INSTALL,
        allowRealHome: "1",
      }),
    ).not.toThrow();
  });

  test("any other value of the override does NOT open the gate", () => {
    expect(() =>
      assertHomeIsThrowaway({
        home: "/Users/alex",
        hasInstall: LIVE_INSTALL,
        allowRealHome: "true",
      }),
    ).toThrow(/REFUSING TO RUN THE TESTS/);
  });
});

// A guard nobody loads is not a guard. This pins the wiring that makes
// `npx vitest run` pick it up.
test("vitest.config.ts loads the guard as a setup file", () => {
  const config = readFileSync(
    join(__dirname, "..", "vitest.config.ts"),
    "utf8",
  );
  expect(config).toContain("setupFiles");
  expect(config).toContain("./test/helpers/no-real-home.ts");
});
