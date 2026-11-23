// finished-work-memory.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: the assistant learns to count finished work
// from ONE block written into the memory file it already reads every session -
// ~/.claude/CLAUDE.md for Claude Code, ~/.codex/AGENTS.md for Codex, the same two
// paths under %USERPROFILE% on Windows. No hook, no second mechanism.
//
// Three properties, and the round trip is the one that matters: a customer who runs
// init and then uninstall gets their file back BYTE FOR BYTE. Anything less and we
// are leaving litter in a file the customer's assistant reads on every run.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_BEGIN_MARKER,
  MEMORY_END_MARKER,
  insertMemoryBlock,
  removeMemoryBlock,
  renderFinishedWorkMemoryBlock,
} from "../src/finished-work";
import {
  CLAUDE_MEMORY_PATH,
  CODEX_MEMORY_PATH,
  removeFinishedWorkMemoryBlocks,
  writeFinishedWorkMemoryBlocks,
} from "../src/connector";

const INVOCATION = "node ~/.marginfront-ccc/cli.js";
const NAMES = ["contract summarized", "slide deck"];
const BLOCK = () => renderFinishedWorkMemoryBlock(NAMES, INVOCATION);

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccc-memory-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("the block the assistant reads", () => {
  test("it is fenced by the two markers, and nothing else in it is ours", () => {
    const block = BLOCK();
    expect(block.startsWith(MEMORY_BEGIN_MARKER)).toBe(true);
    expect(block.endsWith(MEMORY_END_MARKER)).toBe(true);
    // HTML comments, because both files are Markdown and a Markdown reader must not
    // render our fence posts as text the assistant tries to follow.
    expect(MEMORY_BEGIN_MARKER.startsWith("<!--")).toBe(true);
    expect(MEMORY_END_MARKER.endsWith("-->")).toBe(true);
  });

  test("it names both commands and the customer's own words", () => {
    const block = BLOCK();
    expect(block).toContain(`${INVOCATION} work`);
    expect(block).toContain(`${INVOCATION} done`);
    expect(block).toContain("contract summarized, slide deck");
  });

  test("it tells the assistant to re-run work when the work changes", () => {
    expect(BLOCK().toLowerCase()).toContain("when the work changes");
  });

  test("with no names it still reads as an instruction, not a blank", () => {
    const block = renderFinishedWorkMemoryBlock([], INVOCATION);
    expect(block).toContain(`${INVOCATION} done`);
    expect(block).not.toContain("()");
  });

  // THE POINT OF THE PER-FILE FLAG: with both assistants installed and neither seen
  // working yet, `done` refuses rather than guess which column the row belongs in.
  // Each file's own copy carries its own answer, so the assistant reading it never
  // meets that refusal.
  test("with both installed, each file's note names its own assistant", () => {
    expect(
      renderFinishedWorkMemoryBlock(NAMES, INVOCATION, "claude-code"),
    ).toContain(`${INVOCATION} done "<name>" --agent claude-code`);
    expect(renderFinishedWorkMemoryBlock(NAMES, INVOCATION, "codex")).toContain(
      `${INVOCATION} done "<name>" --agent codex`,
    );
  });

  test("with one installed, the note carries no flag to get wrong", () => {
    expect(BLOCK()).not.toContain("--agent");
  });

  // Customer copy, in a file a human opens.
  test("no em dash, no banned vocabulary", () => {
    const block = BLOCK();
    expect(block).not.toContain("—");
    expect(block).not.toMatch(/\bjust\b/i);
    expect(block).not.toMatch(
      /\b(matter|matters|legal|law firm|case|cases)\b/i,
    );
  });
});

describe("the memory-block wording", () => {
  test("says whose outcomes they are and forbids counting its own work", () => {
    const block = BLOCK();
    expect(block).toContain("belong to the person you are helping");
    expect(block).toContain("Never count your own edits");
    expect(block).toContain("Never invent a name");
    expect(block).toContain("Do not ask first");
    expect(block).toContain("say it is not on the list");
  });

  test("the note carries no sentence that invites invented records", () => {
    const block = BLOCK().toLowerCase();
    expect(block).not.toContain("count the work you finish");
    expect(block).not.toContain("pick a short plain name");
  });

  test("shows the count form, with the agent flag when there is one", () => {
    expect(BLOCK()).toContain(`${INVOCATION} done "<name>" 3`);
    expect(renderFinishedWorkMemoryBlock(NAMES, INVOCATION, "codex")).toContain(
      `${INVOCATION} done "<name>" 3 --agent codex`,
    );
  });

  test("tells a sandboxed shell to ask for approval before the first attempt", () => {
    expect(BLOCK()).toContain("ask for approval");
    expect(BLOCK()).toContain("need the network");
  });
});

describe("the round trip is byte-identical", () => {
  const block = () => BLOCK();

  test("a file that did not exist: nothing is left behind", () => {
    const home = tempHome();
    const dir = join(home, ".claude");
    mkdirSync(dir);
    const path = join(dir, "CLAUDE.md");

    writeFinishedWorkMemoryBlocks({
      names: NAMES,
      claudePath: path,
      claudeInstalled: true,
      codexInstalled: false,
    });
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(MEMORY_BEGIN_MARKER);

    removeFinishedWorkMemoryBlocks({
      claudePath: path,
      codexPath: join(dir, "none"),
    });
    expect(existsSync(path)).toBe(false);
  });

  test("a file that ended with a newline comes back exactly as it was", () => {
    const original = "# My notes\n\nAlways run the tests.\n";
    expect(removeMemoryBlock(insertMemoryBlock(original, block())).text).toBe(
      original,
    );
  });

  test("a file that did NOT end with a newline comes back exactly as it was", () => {
    const original = "# My notes\n\nAlways run the tests.";
    expect(removeMemoryBlock(insertMemoryBlock(original, block())).text).toBe(
      original,
    );
  });

  test("an empty file comes back empty", () => {
    expect(removeMemoryBlock(insertMemoryBlock("", block())).text).toBe("");
  });

  test("the customer's own text survives on both sides of our block", () => {
    const original = "# Top\n\nkeep me\n";
    const withBlock =
      insertMemoryBlock(original, block()) + "\n# Added later\n";
    const back = removeMemoryBlock(withBlock);
    expect(back.found).toBe(true);
    expect(back.text).toContain("keep me");
    expect(back.text).toContain("# Added later");
    expect(back.text).not.toContain(MEMORY_BEGIN_MARKER);
  });
});

describe("running it twice changes nothing", () => {
  test("a second insert replaces our block instead of adding a second one", () => {
    const original = "# My notes\n";
    const once = insertMemoryBlock(original, BLOCK());
    const twice = insertMemoryBlock(once, BLOCK());
    expect(twice).toBe(once);
    expect(twice.split(MEMORY_BEGIN_MARKER)).toHaveLength(2);
  });

  test("new names replace the old block in place", () => {
    const once = insertMemoryBlock("# My notes\n", BLOCK());
    const twice = insertMemoryBlock(
      once,
      renderFinishedWorkMemoryBlock(["bug fixed"], INVOCATION),
    );
    expect(twice.split(MEMORY_BEGIN_MARKER)).toHaveLength(2);
    expect(twice).toContain("bug fixed");
    expect(twice).not.toContain("slide deck");
  });

  test("removing from a file that never had one leaves it alone", () => {
    const original = "# My notes\n";
    const back = removeMemoryBlock(original);
    expect(back.found).toBe(false);
    expect(back.text).toBe(original);
  });
});

// A customer half-cleans the block by hand: the closing marker goes, the opening
// one stays, and their own rules end up below it. Everything after that has to
// keep the one promise this note makes, which is that we never touch a line we did
// not write.
describe("a marker the customer left behind by hand", () => {
  const ORPHAN = MEMORY_BEGIN_MARKER;

  test("insert replaces the orphan instead of adding a second block", () => {
    const halfCleaned = `${ORPHAN}\nMY OWN RULE\n`;
    const after = insertMemoryBlock(halfCleaned, BLOCK());
    expect(after.split(MEMORY_BEGIN_MARKER)).toHaveLength(2);
    expect(after.split(MEMORY_END_MARKER)).toHaveLength(2);
  });

  test("with a second block above it, removal takes ours and leaves theirs", () => {
    const withOrphan = `${ORPHAN}\nMY OWN RULE\n`;
    const withBlock = `${withOrphan}${BLOCK()}\n`;
    const back = removeMemoryBlock(withBlock);
    expect(back.found).toBe(true);
    expect(back.text).toContain("MY OWN RULE");
    expect(back.text).toContain(ORPHAN);
    expect(back.text).not.toContain(MEMORY_END_MARKER);
    expect(back.text).not.toContain("contract summarized");
  });

  test("an orphan on its own is not a block, so removal changes nothing", () => {
    const orphanOnly = `${ORPHAN}\nMY OWN RULE\n`;
    const back = removeMemoryBlock(orphanOnly);
    expect(back.found).toBe(false);
    expect(back.text).toBe(orphanOnly);
  });

  test("init then uninstall on a half-cleaned file leaves their line standing", () => {
    const halfCleaned = `${ORPHAN}\nMY OWN RULE\n`;
    const after = insertMemoryBlock(halfCleaned, BLOCK());
    const back = removeMemoryBlock(after);
    expect(back.found).toBe(true);
    expect(back.text).toContain("MY OWN RULE");
  });
});

describe("only the assistants that are here get a block", () => {
  function homeWithBoth() {
    const home = tempHome();
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".codex"));
    return {
      home,
      claudePath: join(home, ".claude", "CLAUDE.md"),
      codexPath: join(home, ".codex", "AGENTS.md"),
    };
  }

  test("both installed: both files get one, each naming its own assistant", () => {
    const { claudePath, codexPath } = homeWithBoth();
    const results = writeFinishedWorkMemoryBlocks({
      names: NAMES,
      claudePath,
      codexPath,
      claudeInstalled: true,
      codexInstalled: true,
    });
    expect(results.map((r) => r.action)).toEqual(["written", "written"]);
    expect(readFileSync(claudePath, "utf8")).toContain("--agent claude-code");
    expect(readFileSync(codexPath, "utf8")).toContain("--agent codex");
  });

  test("one installed: no flag, because there is nothing to disambiguate", () => {
    const { claudePath, codexPath } = homeWithBoth();
    writeFinishedWorkMemoryBlocks({
      names: NAMES,
      claudePath,
      codexPath,
      claudeInstalled: true,
      codexInstalled: false,
    });
    expect(readFileSync(claudePath, "utf8")).not.toContain("--agent");
  });

  test("only Codex installed: Claude's file is never created", () => {
    const { claudePath, codexPath } = homeWithBoth();
    writeFinishedWorkMemoryBlocks({
      names: NAMES,
      claudePath,
      codexPath,
      claudeInstalled: false,
      codexInstalled: true,
    });
    expect(existsSync(claudePath)).toBe(false);
    expect(existsSync(codexPath)).toBe(true);
  });

  test("installed but no directory: nothing is created, and it says so", () => {
    const home = tempHome();
    const results = writeFinishedWorkMemoryBlocks({
      names: NAMES,
      claudePath: join(home, ".claude", "CLAUDE.md"),
      codexPath: join(home, ".codex", "AGENTS.md"),
      claudeInstalled: true,
      codexInstalled: true,
    });
    expect(results.every((r) => r.action === "no-directory")).toBe(true);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  // Uninstall runs after someone may have deleted an assistant. The block still goes.
  test("removal is not gated on the assistant still being installed", () => {
    const { claudePath, codexPath } = homeWithBoth();
    writeFinishedWorkMemoryBlocks({
      names: NAMES,
      claudePath,
      codexPath,
      claudeInstalled: true,
      codexInstalled: true,
    });
    writeFileSync(claudePath, `# kept\n${readFileSync(claudePath, "utf8")}`);

    const results = removeFinishedWorkMemoryBlocks({ claudePath, codexPath });
    expect(results.map((r) => r.action).sort()).toEqual(["removed", "removed"]);
    expect(readFileSync(claudePath, "utf8")).toContain("# kept");
    expect(readFileSync(claudePath, "utf8")).not.toContain(MEMORY_BEGIN_MARKER);
    expect(existsSync(codexPath)).toBe(false);
  });
});

// The Windows half. Node's homedir() reads USERPROFILE there, so these two constants
// ARE the %USERPROFILE% paths on the Windows lane without a second spelling to keep
// in sync, and the temp-home round trips above run against backslash paths there.
describe("the paths are the same two on both operating systems", () => {
  test("they sit under this machine's home, named for each assistant", () => {
    expect(CLAUDE_MEMORY_PATH).toBe(join(homedir(), ".claude", "CLAUDE.md"));
    expect(CODEX_MEMORY_PATH).toBe(join(homedir(), ".codex", "AGENTS.md"));
  });
});

// The block is read by an assistant top to bottom, once, and acted
// on. "One of these" pointing at a list that has not appeared yet is the kind of
// instruction that gets guessed at.
describe("the block reads in the order it is acted on", () => {
  test("the names come before the line that says to finish one of them", () => {
    const block = BLOCK();
    expect(block).toContain(
      "The only things to count, exactly as written: contract summarized, slide deck.",
    );
    expect(block.indexOf("These are the things to count")).toBeLessThan(
      block.indexOf("When the person tells you one of those is finished"),
    );
  });

  test("it names the command to re-run rather than the bare word", () => {
    expect(BLOCK()).toContain(
      "When the work changes, run the work command again with the new name.",
    );
  });

  test("with no names it still says to reuse one, before the done line", () => {
    const block = renderFinishedWorkMemoryBlock([], INVOCATION);
    expect(block).toContain(
      "Count only what the person tells you is finished, with the name they use, and reuse that name next time.",
    );
    expect(block.indexOf("Use the same name every time")).toBeLessThan(
      block.indexOf("When the person tells you one of those is finished"),
    );
  });
});
