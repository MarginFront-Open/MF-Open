// prompt-survives-refresh.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES (a Windows terminal can show "no valid inputs shown"):
//
//   In terminal mode readline redraws its prompt before it reads a key: it emits
//   ESC[1G (cursor to column 0) and ESC[0J (clear to end of screen), then writes
//   the prompt it was given. If the wizard wrote the question itself and handed
//   readline an EMPTY prompt, that redraw would erase the question and the user
//   would see a blank line with a cursor. Real pty capture:
//     "Wire it up now? ... [Y/n] \x1b[1G\x1b[0J \x1b[1Gy"
//
//   Each prompt is driven with a fake keyboard and a capturing output stream in
//   terminal mode, and the test asserts the question text sits AFTER the last erase
//   sequence in the captured bytes: what survives the redraw is what the user reads.
// ---------------------------------------------------------------------------

import { test, expect, describe } from "vitest";
import { PassThrough } from "node:stream";
import { promptYesNo, promptVisible, promptSecret } from "../src/cli";

const NEVER_RESOLVED = "NEVER_RESOLVED" as const;

function capturingOutput(): { output: PassThrough; bytes: () => string } {
  const chunks: string[] = [];
  const output = new PassThrough();
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  return { output, bytes: () => chunks.join("") };
}

// Everything readline wrote from its last erase onward. The screen shows only this.
function afterLastErase(bytes: string): string {
  const lastErase = Math.max(
    bytes.lastIndexOf("\x1b[1G"),
    bytes.lastIndexOf("\x1b[0J"),
  );
  return lastErase === -1 ? bytes : bytes.slice(lastErase);
}

function withTimeout<T>(
  promise: Promise<T>,
): Promise<T | typeof NEVER_RESOLVED> {
  return Promise.race([
    promise,
    new Promise<typeof NEVER_RESOLVED>((resolve) =>
      setTimeout(() => resolve(NEVER_RESOLVED), 1500),
    ),
  ]);
}

describe("promptYesNo keeps its question on screen in terminal mode", () => {
  test("the question text survives readline's redraw, and Enter still takes the default", async () => {
    const keyboard = new PassThrough();
    const { output, bytes } = capturingOutput();
    const question =
      "Wire it up now? Press Enter for yes, or type n to cancel. [Y/n] ";

    const decision = withTimeout(
      promptYesNo(
        `\n${question}`,
        { input: keyboard, output, terminal: true },
        true,
      ),
    );
    keyboard.write("\n");

    expect(await decision).toBe(true);
    expect(bytes()).toContain(question);
    expect(afterLastErase(bytes())).toContain(question);
  });

  test("the leading newline is written before the prompt, never inside it", async () => {
    const keyboard = new PassThrough();
    const { output, bytes } = capturingOutput();
    const question = "Turn it on now? [Y/n] ";

    const decision = withTimeout(
      promptYesNo(
        `\n${question}`,
        { input: keyboard, output, terminal: true },
        true,
      ),
    );
    keyboard.write("n\n");

    expect(await decision).toBe(false);
    const drawn = afterLastErase(bytes());
    expect(drawn).toContain(question);
    // Readline's cursor math assumes a one-line prompt; a newline inside the prompt
    // would put the cursor on the wrong row on every redraw.
    expect(drawn.indexOf("\n")).toBeGreaterThan(drawn.indexOf(question));
    expect(bytes().indexOf("\n")).toBeLessThan(bytes().indexOf(question));
  });
});

describe("promptVisible keeps its label AND its pre-filled default on screen", () => {
  test("the label is drawn after the redraw and the default follows it", async () => {
    const keyboard = new PassThrough();
    const { output, bytes } = capturingOutput();
    const label = "Developer email for this machine's AI cost: ";

    const answer = withTimeout(
      promptVisible(label, "sam@example.com", {
        input: keyboard,
        output,
        terminal: true,
      }),
    );
    keyboard.write("\n");

    expect(await answer).toBe("sam@example.com");
    const drawn = afterLastErase(bytes());
    expect(drawn).toContain(label);
    expect(drawn).toContain("sam@example.com");
    expect(drawn.indexOf(label)).toBeLessThan(
      drawn.indexOf("sam@example.com"),
    );
  });
});

describe("promptSecret keeps its question on screen while masking the key", () => {
  test("the question survives the redraw, the typed key never appears, the answer is returned", async () => {
    const keyboard = new PassThrough();
    const { output, bytes } = capturingOutput();
    const question =
      "Paste your MarginFront SECRET key (mf_sk_*) (Enter to skip): ";

    const answer = withTimeout(
      promptSecret(question, { input: keyboard, output, terminal: true }),
    );
    keyboard.write("mf_sk_secret_value\n");

    expect(await answer).toBe("mf_sk_secret_value");
    expect(afterLastErase(bytes())).toContain(question);
    expect(bytes()).not.toContain("mf_sk_secret_value");
    expect(bytes()).not.toContain("secret_value");
  });
});
