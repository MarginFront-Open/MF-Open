// prompt-yesno.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES (the consent gate's ACTUAL decision logic):
//
//   promptYesNo is the one line that authorizes a persistent, machine-wide change
//   to ~/.claude/settings.json AND ~/.codex/config.toml. If its "only an explicit
//   yes counts as yes" rule ever drifts, a bare Enter / a typo / a piped EOF could
//   silently wire up a global config the user never agreed to. So we drive the REAL
//   function (never a stand-in) by feeding it a fake keyboard, and assert it returns:
//
//     true  for "y"/"yes" (any case, whitespace ignored), AND for a bare Enter
//           ONLY when an interactive prompt opts into a yes-default (defaultYes)
//     false for everything else - "n", garbage, partial matches like "ye"/"yep",
//           a piped/EOF stream, a Ctrl-C, and a bare Enter with no yes-default
//
// HOW IT'S A REAL TEST: we inject a real in-memory stream as stdin (the same
// dependency-injection idea the settings writers use for file paths) and read the
// real Promise the gate resolves. Nothing about the unit under test is mocked, so a
// fault in the normalization, the EOF handler, or the SIGINT handler makes a
// case here FAIL (it stops resolving false), rather than passing on a stub.
// ---------------------------------------------------------------------------

import { test, expect, describe } from "vitest";
import { PassThrough } from "node:stream";
import { promptYesNo } from "../src/cli";

// A throwaway writable that swallows whatever promptYesNo prints, so the question
// text never pollutes the test runner's own output. We have to drain it (resume)
// or the writes would back up.
function discardOutput(): PassThrough {
  const sink = new PassThrough();
  sink.resume();
  return sink;
}

// Sentinel returned when the gate fails to resolve in time. A correct gate ALWAYS
// resolves (on a line, on EOF, or on Ctrl-C), so seeing this means a handler was
// dropped - we assert against it so that shows up as a fast, clear failure instead
// of a hung test.
const NEVER_RESOLVED = "NEVER_RESOLVED" as const;

// Drive the real promptYesNo with a fake keyboard.
//   keystrokes: what the "user" types (undefined = type nothing at all, i.e. a bare
//               EOF). Include the trailing "\n" yourself to simulate pressing Enter.
//   endStream:  whether to close stdin afterward (this is how we simulate EOF). The
//               Ctrl-C case leaves it open so the ONLY thing that can resolve the
//               gate is the SIGINT handler - proving that handler specifically works.
//   terminal:   terminal mode. Off by default (a piped/fake stream). The Ctrl-C case
//               turns it on, because the \x03 (Ctrl-C) byte is only interpreted as an
//               interrupt when readline is in terminal mode - exactly like a real TTY.
async function askWithFakeKeyboard(opts: {
  keystrokes?: string;
  endStream?: boolean;
  terminal?: boolean;
  defaultYes?: boolean;
}): Promise<boolean | typeof NEVER_RESOLVED> {
  const fakeStdin = new PassThrough();
  const decision = promptYesNo(
    "Wire it all up now? [Y/n] ",
    {
      input: fakeStdin,
      output: discardOutput(),
      terminal: opts.terminal,
    },
    opts.defaultYes ?? false,
  );

  if (opts.keystrokes !== undefined) fakeStdin.write(opts.keystrokes);
  if (opts.endStream ?? true) fakeStdin.end();

  return Promise.race([
    decision,
    new Promise<typeof NEVER_RESOLVED>((resolve) =>
      setTimeout(() => resolve(NEVER_RESOLVED), 1500),
    ),
  ]);
}

describe("promptYesNo - the global-config consent gate", () => {
  // ---- the only two inputs that may EVER mean yes -------------------------
  test("'y' + Enter resolves true", async () => {
    expect(await askWithFakeKeyboard({ keystrokes: "y\n" })).toBe(true);
  });

  test("'yes' + Enter resolves true", async () => {
    expect(await askWithFakeKeyboard({ keystrokes: "yes\n" })).toBe(true);
  });

  // A yes must survive the normal sloppiness of a real keyboard: stray case and
  // surrounding spaces. (The gate trims + lowercases before comparing.)
  test("'Y', 'YES', and a padded ' yes ' all resolve true", async () => {
    expect(await askWithFakeKeyboard({ keystrokes: "Y\n" })).toBe(true);
    expect(await askWithFakeKeyboard({ keystrokes: "YES\n" })).toBe(true);
    expect(await askWithFakeKeyboard({ keystrokes: "  yes  \n" })).toBe(true);
  });

  // ---- everything below must be NO -----------------------------------------
  test("a bare Enter on a piped/non-interactive stream resolves false (no yes-default)", async () => {
    expect(await askWithFakeKeyboard({ keystrokes: "\n" })).toBe(false);
  });

  test("'n' + Enter resolves false", async () => {
    expect(await askWithFakeKeyboard({ keystrokes: "n\n" })).toBe(false);
  });

  test("a garbage answer resolves false", async () => {
    expect(await askWithFakeKeyboard({ keystrokes: "banana\n" })).toBe(false);
  });

  test("a closed/EOF stream (piped input that ends, nothing typed) resolves false", async () => {
    // No keystrokes at all, only a closed stdin: this is the non-interactive / piped
    // case, and it must never be read as an accidental yes.
    expect(await askWithFakeKeyboard({ keystrokes: undefined })).toBe(false);
  });

  test("Ctrl-C (SIGINT) resolves false, never a crash", async () => {
    // \x03 is the Ctrl-C byte. We keep the stream OPEN (endStream: false) so the
    // SIGINT handler is the ONLY path that can resolve the gate - if that handler
    // were dropped, this would time out to NEVER_RESOLVED and fail.
    const result = await askWithFakeKeyboard({
      keystrokes: "\x03",
      endStream: false,
      terminal: true,
    });
    expect(result).toBe(false);
  });

  // ---- "ONLY y/yes" lockdown: near-misses and other truthy-looking words --
  // This guards against a well-meaning "fix" that loosens the gate to accept
  // partial matches or other affirmatives. The contract is literally y/yes, full stop.
  test("near-misses and other affirmatives all resolve false (only y/yes count)", async () => {
    for (const answer of [
      "ye", // partial - not yes
      "yep", // colloquial - not yes
      "yeah", // colloquial - not yes
      "yess", // typo - not yes
      "ok", // affirmative but not y/yes
      "sure", // affirmative but not y/yes
      "1", // truthy-looking - not y/yes
      "true", // truthy-looking - not y/yes
      "yesn't", // contains "yes" but isn't "yes"
    ]) {
      expect(await askWithFakeKeyboard({ keystrokes: `${answer}\n` })).toBe(
        false,
      );
    }
  });
});

describe("promptYesNo - defaultYes (interactive Enter takes the stated default)", () => {
  // The init consent prompt calls promptYesNo(..., defaultYes=true) so a real user
  // who presses Enter PROCEEDS (they ran `init`).
  // These prove that, and that the non-interactive SAFETY default is preserved.
  test("interactive bare Enter with defaultYes=true resolves TRUE (the consent prompt)", async () => {
    expect(
      await askWithFakeKeyboard({
        keystrokes: "\n",
        terminal: true,
        defaultYes: true,
      }),
    ).toBe(true);
  });

  test("interactive bare Enter with defaultYes=false resolves false", async () => {
    expect(
      await askWithFakeKeyboard({
        keystrokes: "\n",
        terminal: true,
        defaultYes: false,
      }),
    ).toBe(false);
  });

  test("interactive 'n' overrides defaultYes=true -> false", async () => {
    expect(
      await askWithFakeKeyboard({
        keystrokes: "n\n",
        terminal: true,
        defaultYes: true,
      }),
    ).toBe(false);
  });

  test("SAFETY: a piped (non-terminal) bare Enter ignores defaultYes -> false", async () => {
    expect(
      await askWithFakeKeyboard({
        keystrokes: "\n",
        terminal: false,
        defaultYes: true,
      }),
    ).toBe(false);
  });

  test("SAFETY: EOF with defaultYes=true still resolves false (no auto-wire without a keypress)", async () => {
    expect(
      await askWithFakeKeyboard({ keystrokes: undefined, defaultYes: true }),
    ).toBe(false);
  });
});
