// Copy gates. Every public surface in this package must tell the both-tools truth.
// These are grep gates: they fail if "Claude Code only" wording appears, or if a
// required honesty sentence goes missing. They read the shipped files, not a copy.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  finishedWorkStatusLine,
  renderHelp,
  workIdInitStep,
  workIdStatusLine,
} from "../src/cli";
import {
  CCC_COMMAND_INVOCATION,
  renderEnvFile,
  resolveCollectorAsset,
} from "../src/connector";
import {
  renderFinishedWorkMemoryBlock,
  roiFinishedWorkPointer,
} from "../src/finished-work";
import { userFacingStrings } from "./helpers/source-strings";

const PKG_ROOT = join(__dirname, "..");

// git checks these out with CRLF on Windows, and several gates below match across a
// line break. The gates are about the words, not the line endings, so read every
// shipped file in one line-ending shape.
function readShipped(...segments: string[]): string {
  return readFileSync(join(PKG_ROOT, ...segments), "utf8").replace(
    /\r\n/g,
    "\n",
  );
}

const readme = readShipped("README.md");
const cliSource = readShipped("src", "cli.ts");
const controlSource = readShipped("src", "control.ts");

describe("README - Spend Control tells the both-tools truth", () => {
  test("the README makes no Claude-only promises", () => {
    expect(readme).not.toContain("Codex is next");
    expect(readme).not.toContain("Claude Code only (this release)");
    expect(readme).not.toContain("stop\na Claude Code tool call");
  });

  // Matched across whitespace, not against one exact line break: the README is
  // prose-wrapped, so a reword upstream of these phrases moves the line break and
  // would fail a literal match on wording that never changed.
  test("the headline names both tools", () => {
    expect(readme).toMatch(/a Claude Code or\s+Codex tool call/);
    expect(readme).toMatch(
      /Claude Code and\s+Codex run before every tool call/,
    );
  });

  // The README carries the full cap-coverage list. The three limits below are the
  // ones a reader deciding whether to run `init --control` has to see before they
  // type it.
  test("the honesty limits a reader needs before --control survive", () => {
    // A dev can remove it: guardrail, not a hard limit.
    expect(readme).toContain("This is a guardrail, not a hard limit.");
    // Tools, not tokens.
    expect(readme).toContain("stops TOOL CALLS, not tokens");
    // Hosted tools stay uncovered.
    expect(readme).toContain("never sees hosted tools");
    // And the rest of the list.
    expect(readme).toContain("It fails open.");
    expect(readme).toContain("A team cap is not enforced here");
    expect(readme).not.toMatch(/docs\.marginfront\.com/);
  });

  test("the Codex arming step is the documented /hooks flow", () => {
    expect(readme).toContain("run `/hooks` once inside codex and trust the");
    // The undocumented trusted_hash self-grant does not ship, anywhere.
    expect(readme).not.toContain("trusted_hash");
  });
});

describe("CLI source - no self-granted trust, anywhere", () => {
  test("neither cli.ts nor control.ts ever writes or mentions trusted_hash", () => {
    expect(cliSource).not.toContain("trusted_hash");
    expect(controlSource).not.toContain("trusted_hash");
  });

  test("the post-install summary names both tools", () => {
    expect(cliSource).toContain("before Claude Code and Codex tool calls.");
    expect(cliSource).not.toContain("before every `claude` tool call");
  });
});

// ---------------------------------------------------------------------------
// Strings that would be FALSE on Windows, which is supported.
//
// Where a seam exists these drive the real function rather than grepping, so an
// honest rewording passes and a reworded false claim still fails.
// ---------------------------------------------------------------------------

describe("the copy matches what the code does on Windows", () => {
  test("the unsupported-OS error names Windows as supported, and sends nobody to a wall", () => {
    // Reachable only for an OS with no collector build at all. win32 resolves fine.
    let message = "";
    try {
      resolveCollectorAsset("freebsd", "x64");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("freebsd");
    // The message must not say Windows setup "isn't finished yet": that would turn
    // a Windows reader away from a platform that works.
    expect(message).not.toMatch(/isn't finished yet/);
    expect(message).not.toMatch(/setup there/i);
    expect(message).toContain("Fix: run this on macOS, Windows, or Linux.");
  });

  test("resolveCollectorAsset resolves for win32, so that error is unreachable there", () => {
    const asset = resolveCollectorAsset("win32", "x64");
    expect(asset.os).toBe("windows");
    expect(asset.binaryName).toBe("otelcol-contrib.exe");
  });

  test("help does not promise desktop-app metering on Windows", () => {
    // schtasksServiceManager.applyDesktopEnvironment is deliberately a no-op, so the
    // Windows desktop apps are NOT metered, and help must not promise it.
    expect(renderHelp(() => "win32")).not.toMatch(/desktop app/i);
  });

  test("help still promises it on macOS, where the launchd GUI session delivers it", () => {
    // The negative control: without it, deleting the phrase everywhere would pass.
    expect(renderHelp(() => "darwin")).toContain("(or open the desktop apps)");
  });

  test("the no-background-meter block names both service backends", () => {
    // The copy must not call the meter macOS-only: Windows registers a scheduled task.
    expect(cliSource).toContain(
      "the background meter is a macOS LaunchAgent or a Windows scheduled",
    );
    expect(cliSource).not.toContain(
      "Why: the background meter is a macOS LaunchAgent. Linux and WSL have",
    );
  });
});

// Anyone labelling spend reads this section, whatever their industry, so it stays
// neutral.
describe("README - the work-item section stays neutral", () => {
  const section = (() => {
    const start = readme.indexOf("## Label this machine's spend");
    if (start === -1) return "";
    const next = readme.indexOf("\n## ", start + 1);
    return readme.slice(start, next === -1 ? undefined : next);
  })();

  test("the section exists, under a neutral heading", () => {
    expect(readme).toContain("## Label this machine's spend with a work item");
    expect(section).not.toBe("");
  });

  test("the section uses neutral wording", () => {
    expect(section).not.toMatch(/\bmatters?\b/i);
    expect(section).not.toMatch(/\b(legal|law|attorney|filing)\b/i);
  });

  test("it documents CCC_WORK_ID, and says CCC_MATTER_ID still works", () => {
    expect(section).toContain("CCC_WORK_ID=");
    expect(section).toContain("CCC_MATTER_ID");
    expect(section).toMatch(/older name/);
  });

  // The two promises a reader acts on. The meter cannot read the org's
  // records, so it promises the spelling rule, which it CAN keep.
  test("the section keeps the promises a reader acts on", () => {
    expect(section).toMatch(/There's nothing to restart/);
    expect(section).toMatch(/use the same spelling every time/i);
    expect(section).not.toMatch(/Unassigned/);
  });
});

// The finished-work section is what tells a reader a count can never move their
// spend number.
describe("README - the finished-work section says what it has to", () => {
  const section = (() => {
    const start = readme.indexOf("## Count what you finish");
    if (start === -1) return "";
    const next = readme.indexOf("\n## ", start + 1);
    return readme.slice(start, next === -1 ? undefined : next);
  })();

  test("the section exists", () => {
    expect(section).not.toBe("");
  });

  test("it names both commands, with the count", () => {
    expect(section).toContain('cli.js work "Q3 pricing model"');
    expect(section).toContain('cli.js done "contract summarized"');
    expect(section).toContain('done "contract summarized" 3');
  });

  // The one promise a reader has to be able to find before they type it. Without it
  // "recording one is free" is a claim nobody made and everybody has to assume.
  test("it promises a finished thing cannot move the spend number", () => {
    expect(section).toContain("**A finished thing costs nothing on its own.**");
    expect(section).toMatch(/prices it at zero/);
  });

  // The word that keeps an estimate from reading as a measurement.
  test("it says the AI cost beside a count is attributed, not measured", () => {
    expect(section).toMatch(/\*attributed\*/);
    expect(section).toMatch(/never\s+quoted as a measured one/);
    // The page prints the word in prose and the JSON stamps it per number.
    // Neither is "printed on every one of those numbers", so the README must not
    // say that.
    expect(section).toMatch(/stamps every number with where it\s+came from/);
    expect(section).not.toMatch(/printed on every one of those numbers/);
  });

  test("it names the two files the note goes in, and the undo", () => {
    expect(section).toContain("~/.claude/CLAUDE.md");
    expect(section).toContain("~/.codex/AGENTS.md");
    expect(section).toMatch(/`uninstall` takes that note back out/);
  });

  test("it says the question defaults to no and a scripted install never sees it", () => {
    expect(section).toContain(
      "Want to count finished work too, not only spend? (y/N)",
    );
    expect(section).toMatch(/defaults to no/);
  });

  // Same neutrality rule the work-item section lives under.
  test("it uses neutral wording too", () => {
    expect(section).not.toMatch(/\bmatters?\b/i);
    expect(section).not.toMatch(/\b(legal|law|attorney|filing|docket)\b/i);
  });

  test("no em dash, no banned words", () => {
    expect(section).not.toContain("—");
    expect(section).not.toMatch(/\bjust\b/i);
  });
});

// The consent screen points at this list, so the list has to hold every file
// `init` writes.
describe("README - the init change list declares the memory files", () => {
  const section = (() => {
    const start = readme.indexOf("## What `init` changes");
    if (start === -1) return "";
    const next = readme.indexOf("\n## ", start + 1);
    return readme.slice(start, next === -1 ? undefined : next);
  })();

  test("it names both memory files and gates them on the answer", () => {
    expect(section).toContain("~/.claude/CLAUDE.md");
    expect(section).toContain("~/.codex/AGENTS.md");
    expect(section).toMatch(/Only if you say yes to counting finished work/);
    expect(section).toMatch(/defaults to no/);
  });
});

// The command table is where a reader looks first. A command that exists and is not
// in it is a command nobody finds.
describe("README - the commands table lists the two new commands", () => {
  test("work and done are rows in it", () => {
    expect(readme).toMatch(/\|\s*`work \["<name>"\]`/);
    expect(readme).toMatch(/\|\s*`done "<name>" \[n\]`/);
  });

  test("the three new options are rows too", () => {
    for (const option of ["`--agent`", "`--clear`", "`--setup`"]) {
      expect(readme).toMatch(
        new RegExp(`\\|\\s*${option.replace(/[`-]/g, "\\$&")}`),
      );
    }
  });
});

// Four sentences a customer acts on, each checked against what the product
// does. A grep gate is the right shape here: the words are what matter, and the
// only way a wrong one appears is somebody typing it.
describe("the finished-work copy says what the product actually does", () => {
  const changelog = readShipped("CHANGELOG.md");

  test("the meter never claims it watches your AI finish things", () => {
    // Nothing observes a finished piece of work. A person or an assistant runs
    // `done`. A customer who says yes at init and never runs it sees an empty
    // table and concludes the feature is broken.
    expect(cliSource).not.toContain("counts what it");
    expect(cliSource).not.toContain("FINISHES");
    expect(cliSource).toContain(
      "Today this meter counts what your AI spends. This also counts what you",
    );
    expect(cliSource).toContain("Your assistant runs one");
    expect(cliSource).toContain("short command each time, or you do.");
  });

  test("one cost, not one of them: the same sentence in all three places", () => {
    expect(renderHelp()).toContain(
      "so ROI in your dashboard's left menu can show what one cost on its Finished work tab.",
    );
    expect(cliSource).toContain(
      "so ROI in your dashboard's left menu can show what one cost on its Finished work tab.",
    );
    expect(readme).toContain(
      "so ROI in your dashboard's left menu can show what one cost on its Finished work tab.",
    );
    expect(readme).not.toContain("what one of them cost");
    expect(cliSource).not.toContain("what one of them cost");
  });

  test("a parked record is not always a turn, and the queue row says so", () => {
    expect(cliSource).toContain(
      "record(s) waiting to send: turns, and anything you counted with done.",
    );
    expect(cliSource).not.toContain("turn(s) waiting to send");
  });

  test("offline waits for a RUNNING meter, which Linux and WSL have none of", () => {
    // cli.ts already tells Linux and WSL users there is no background
    // meter. "The meter sends it when sending recovers" is a promise nothing
    // on those platforms keeps until the customer runs the watcher themselves.
    for (const source of [readme, changelog, cliSource]) {
      // Markdown wraps these sentences, so compare on the words alone.
      const flat = source.replace(/\s+/g, " ");
      expect(flat).toContain("the next time it's running");
      expect(flat).toContain(
        "On Linux and WSL that means the next time you run",
      );
    }
    expect(readme).not.toContain("**Offline is fine.**");
    expect(cliSource).not.toContain("the meter sends it when sending recovers");
  });
});

// Four sentences a customer reads, each checked against the mechanic
// behind it. The words are what matter in each one, so a grep gate against the
// shipped file is the right shape.
describe("the meter's sentences match the mechanic behind them", () => {
  const changelog = readShipped("CHANGELOG.md");

  // The split's bucket is the DEVELOPER, not the machine: a developer on a laptop
  // and a desktop shares one bucket, and the dashboard's own sentence says so.
  test("`done` with no work item names the developer's AI, not one machine", () => {
    expect(cliSource).toContain(
      "so its AI cost is a share of everything your AI spent outside one.",
    );
    expect(cliSource).not.toContain(
      "a share of everything this machine spent outside one",
    );
  });

  // "to see it" after "Work item: not set" points at the thing just declared absent.
  test("the not-set work-item row gives its pronoun something to point at", () => {
    const notSet = workIdStatusLine({}, true);
    expect(notSet).toContain(
      "to see what you've finished so far and what it cost in AI",
    );
    expect(notSet).not.toContain("to see it");
  });

  // The README's status row names every row `status` prints, and its Queue row
  // covers finished things as well as turns.
  test("the README's status row lists every row status prints", () => {
    const row = readme
      .split("\n")
      .find((line) => line.trimStart().startsWith("| `status`"));
    expect(row).toBeDefined();
    expect(row).toContain(
      "your work item and whether finished-work counting is on",
    );
    expect(row).toContain(
      "A Queue line appears whenever turns or finished things are parked waiting to send",
    );
    expect(row).not.toContain("whenever turns are parked waiting to send");
  });

  // The payload stamps customer_entered and derived_from_customer_input too, and a
  // reader building a spreadsheet off "measured or attributed" has no rule for them.
  test("the README names all three stamps the report publishes", () => {
    const flat = readme.replace(/\s+/g, " ");
    expect(flat).toContain(
      "stamps every number with where it came from, measured, attributed, or your own estimate",
    );
    expect(flat).not.toContain(
      "stamps every number with whether we measured it or attributed it",
    );
  });

  // The 0.18.0 notes are read by customers in every industry, so they carry no
  // industry-specific vocabulary.
  test("the 0.18.0 notes carry no industry-specific vocabulary", () => {
    const start = changelog.indexOf("# 0.18.0");
    const next = changelog.indexOf("\n# ", start + 1);
    const section = changelog.slice(start, next === -1 ? undefined : next);
    expect(section).not.toBe("");
    expect(section).not.toMatch(
      /\b(legal|law|laws|attorney|attorneys|court|filing|filings|docket|firm|firms)\b/i,
    );
    expect(section).toContain(
      "explains the line with an everyday example, and\n  documents both key names",
    );
  });
});

// The wayfinding rule for the directions that leave the terminal.
// Read off what the meter RENDERS, not its source: the pointer arrives through `${}`,
// so a source scan reads "Finished work: on," as a whole sentence and passes on copy
// it never saw. "Above" and "below" are allowed here, unlike on the dashboard, because
// a transcript and a settings file both have a line the reader can genuinely find -
// but not in a sentence that points at the dashboard, where there is none.
describe("directions that leave the terminal name the place and the reason", () => {
  const THE_POINTER =
    "open ROI in the left menu (ask whoever owns your MarginFront account if you don't see it), then the Finished work tab";

  interface Surface {
    what: string;
    text: string;
  }

  /** One rendered surface, flattened to the sentences a customer reads. */
  function sentences(rendered: string): string[] {
    return rendered
      .replace(/^[#|\s]*/gm, " ")
      .replace(/\s+/g, " ")
      .split(/(?<=\.)\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0);
  }

  const namesTab = (text: string): boolean =>
    /\bFinished work tab\b/.test(text);

  /** Sentences that name the tab without naming ROI and the left menu ahead of it. */
  function tabAheadOfItsMenuWord(surfaces: readonly Surface[]): string[] {
    const wrong: string[] = [];
    for (const { what, text } of surfaces) {
      for (const sentence of sentences(text)) {
        if (!namesTab(sentence)) continue;
        const roiAt = sentence.indexOf("ROI");
        const tabAt = sentence.indexOf("Finished work tab");
        if (roiAt === -1 || !/left menu/.test(sentence) || roiAt > tabAt) {
          wrong.push(`${what}: ${sentence}`);
        }
      }
    }
    return wrong;
  }

  /** Dashboard pointers that lean on where something sits on a screen. */
  function screenDirections(surfaces: readonly Surface[]): string[] {
    const wrong: string[] = [];
    for (const { what, text } of surfaces) {
      for (const sentence of sentences(text)) {
        if (!/\b(ROI|Finished work|left menu)\b/.test(sentence)) continue;
        if (/\b(above|below)\b/i.test(sentence))
          wrong.push(`${what}: ${sentence}`);
      }
    }
    return wrong;
  }

  /** Sentences naming a page the left menu has no word for. */
  function pagesWithNoMenuWord(surfaces: readonly Surface[]): string[] {
    const wrong: string[] = [];
    for (const { what, text } of surfaces) {
      for (const sentence of sentences(text)) {
        if (/\byour (ROI )?page\b/i.test(sentence))
          wrong.push(`${what}: ${sentence}`);
      }
    }
    return wrong;
  }

  const WORK_ID_SET = { value: "PROJ-123", key: "CCC_WORK_ID" } as const;

  const RENDERED: ReadonlyArray<Surface> = [
    {
      what: "init, work-item step",
      text: workIdInitStep({ value: undefined }),
    },
    {
      what: "status, work item set, counting on",
      text: workIdStatusLine(WORK_ID_SET, true),
    },
    {
      what: "status, work item set, counting off",
      text: workIdStatusLine(WORK_ID_SET, false),
    },
    {
      what: "status, work item unset, counting on",
      text: workIdStatusLine({ value: undefined }, true),
    },
    {
      what: "status, work item unset, counting off",
      text: workIdStatusLine({ value: undefined }, false),
    },
    {
      what: "status, finished work on",
      text: finishedWorkStatusLine(["contract summarized"]),
    },
    { what: "status, finished work off", text: finishedWorkStatusLine([]) },
    {
      what: "the assistant's memory block",
      text: renderFinishedWorkMemoryBlock(
        ["contract summarized"],
        CCC_COMMAND_INVOCATION,
      ),
    },
    { what: "the settings file", text: renderEnvFile() },
    { what: "README", text: readme },
  ];

  test("every sentence that names the tab names ROI and the left menu first", () => {
    expect(
      RENDERED.filter(({ text }) => namesTab(text)).length,
    ).toBeGreaterThan(3);

    const wrong = tabAheadOfItsMenuWord(RENDERED);
    expect(
      wrong,
      `These name the tab without the menu word first:\n${wrong.join("\n")}`,
    ).toEqual([]);
  });

  test("no direction at the dashboard leans on a screen direction", () => {
    const wrong = screenDirections(RENDERED);
    expect(
      wrong,
      `A dashboard pointer cannot say above or below:\n${wrong.join("\n")}`,
    ).toEqual([]);
  });

  test("no surface names a page the left menu has no word for", () => {
    const wrong = pagesWithNoMenuWord(RENDERED);
    expect(
      wrong,
      `"your page" and "your ROI page" name nothing a reader can find:\n${wrong.join("\n")}`,
    ).toEqual([]);
  });

  // The reader this copy is written for may hold a role ROI is gated against.
  test("the canonical pointer covers the reader whose menu has no ROI in it", () => {
    expect(roiFinishedWorkPointer("to see it")).toContain(
      "ask whoever owns your MarginFront account if you don't see it",
    );
  });

  // A surface that cannot see whether counting is on may not promise a tab that
  // lists only what the meter recorded.
  test("the tab is named only where the meter knows finished work is counted", () => {
    expect(namesTab(workIdStatusLine(WORK_ID_SET, true))).toBe(true);
    expect(namesTab(finishedWorkStatusLine(["contract summarized"]))).toBe(true);
    expect(
      namesTab(
        renderFinishedWorkMemoryBlock(
          ["contract summarized"],
          CCC_COMMAND_INVOCATION,
        ),
      ),
    ).toBe(true);

    expect(namesTab(workIdStatusLine(WORK_ID_SET, false))).toBe(false);
    expect(namesTab(workIdStatusLine({ value: undefined }, false))).toBe(false);
    expect(namesTab(workIdInitStep({ value: undefined }))).toBe(false);
    expect(namesTab(renderEnvFile())).toBe(false);

    for (const sentence of sentences(finishedWorkStatusLine([]))) {
      if (namesTab(sentence)) expect(sentence).toMatch(/\bonce it is on\b/);
    }
  });

  test("with counting off the work-item line still says what the name does", () => {
    expect(workIdStatusLine(WORK_ID_SET, false)).toContain(
      "AI spend adds up under it",
    );
    expect(workIdStatusLine({ value: undefined }, false)).toContain(
      `${CCC_COMMAND_INVOCATION} work "<name>"`,
    );
  });

  test("every CLI surface that promises the tab renders the one pointer", () => {
    const promising = RENDERED.filter(
      ({ what, text }) =>
        what !== "README" && what !== "the settings file" && namesTab(text),
    );
    expect(promising.length).toBeGreaterThan(2);
    for (const { what, text } of promising) {
      expect(text, `${what} does not render the one pointer`).toContain(
        THE_POINTER,
      );
    }
  });

  // Sentences the meter must not print: it cannot read the org's records, so it never
  // knows whether a work item exists or where unmatched spend lands.
  const STRUCK =
    /\bUnassigned\b|match the ID exactly|Create (the|this) work item|the Agents page/i;

  test("the meter never tells anyone to create a work item first", () => {
    const offenders = userFacingStrings()
      .filter((entry) => STRUCK.test(entry.text))
      .map((entry) => `${entry.file}:${entry.line}: ${entry.text.trim()}`);
    expect(
      offenders,
      `Struck wording is still printed:\n${offenders.join("\n")}`,
    ).toEqual([]);
    expect(readme).not.toMatch(STRUCK);
  });

  // Each gate above passes on a surface that says nothing, so each is handed the
  // same predicate the gate itself calls, over a surface it has to reject.
  test("the gates catch the wording they exist to catch", () => {
    const BAD: readonly Surface[] = [
      {
        what: "half a pointer",
        text: "Your work shows on the Finished work tab.",
      },
      {
        what: "a screen direction",
        text: "Open ROI in the left menu and read the table above.",
      },
      {
        what: "a page with no menu word",
        text: "Your ROI page adds it all up for you.",
      },
    ];

    expect(tabAheadOfItsMenuWord(BAD)).toHaveLength(1);
    expect(screenDirections(BAD)).toHaveLength(1);
    expect(pagesWithNoMenuWord(BAD)).toHaveLength(1);
    expect(STRUCK.test("Spend shows under Unassigned.")).toBe(true);
  });
});

// Two spellings of one thing, both off one constant. "work item" is
// the label a row carries; "piece of work" is how a sentence explains what that is.
// A literal typed inline is how the vocabulary splits in two, so none may be.
describe("the printed nouns come from the constants, not from literals", () => {
  test("no user-facing string in src spells either noun out by hand", () => {
    // The exemption follows the declaration: work-item-noun.ts is the one file
    // allowed to spell them, and forwarder.ts only re-exports.
    const offenders = userFacingStrings()
      .filter((entry) => !entry.file.endsWith("work-item-noun.ts"))
      .filter((entry) => /\b(work item|piece of work)\b/i.test(entry.text))
      .map((entry) => `${entry.file}:${entry.line}: ${entry.text.trim()}`);
    expect(
      offenders,
      `These hardcode a noun the constants own:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("the gate catches a hardcoded noun", () => {
    expect(/\b(work item|piece of work)\b/i.test("Pick a piece of work.")).toBe(
      true,
    );
    expect(/\b(work item|piece of work)\b/i.test("Pick a short name.")).toBe(
      false,
    );
  });
});

// This section has to carry the exact line and the fail-open promise - the
// difference between "this repo is off" and "the machine went quiet on its own".
describe("README - the keep-a-repo-off section says what it has to", () => {
  const section = (() => {
    const start = readme.indexOf("## Keep a repo off the meter");
    if (start === -1) return "";
    const next = readme.indexOf("\n## ", start + 1);
    return readme.slice(start, next === -1 ? undefined : next);
  })();

  test("the section exists", () => {
    expect(section).not.toBe("");
  });

  test("it shows the line, with more than one repo on it", () => {
    expect(section).toContain(
      "CCC_IGNORE_REPOS=acme-corp/billing,acme-corp/website",
    );
    expect(section).toContain("~/.marginfront-ccc/.env");
  });

  test("it says capitals make no difference, because the meter lowercases both sides", () => {
    expect(section).toMatch(/capital letters/i);
  });

  test("it makes the fail-open promise in words a reader can act on", () => {
    expect(section).toMatch(
      /A session the meter can't place in a repo is still sent/,
    );
  });

  test("it keeps the live re-read promise the work-item section makes", () => {
    expect(section).toMatch(/There's nothing to restart/);
  });

  test("it says status reads the rule back", () => {
    expect(section).toMatch(/`status`/);
  });

  test("no em dash, no banned words, no industry-specific wording", () => {
    expect(section).not.toContain("—");
    expect(section).not.toMatch(/\bjust\b/i);
    expect(section).not.toMatch(/\bmatters?\b/i);
    expect(section).not.toMatch(/\b(legal|law|attorney|filing|docket)\b/i);
  });
});

describe("README - the setting is discoverable without reading the whole page", () => {
  test("CCC_IGNORE_REPOS is a row in the options table", () => {
    expect(readme).toMatch(/\|\s*`CCC_IGNORE_REPOS`/);
  });

  // The install section promises every session on the machine is reported. That
  // promise has an exception by design, and a promise a feature contradicts is
  // worse than no promise at all.
  test("the every-session promise names the exception", () => {
    const at = readme.indexOf("EVERY `claude` session");
    expect(at).toBeGreaterThan(-1);
    const paragraph = readme.slice(at, at + 400);
    expect(paragraph).toContain("CCC_IGNORE_REPOS");
    // Across whitespace, not one exact line break: the README is prose-wrapped, so a
    // reword upstream moves the break and would fail on wording that never changed.
    expect(paragraph).toMatch(/Keep a repo off\s+the meter/);
  });
});

// A changelog head that drifts from package.json means the entry a reader sees is
// not the build they installed.
describe("CHANGELOG - the head is the shipped version and 0.19.0 says what changed", () => {
  const changelog = readShipped("CHANGELOG.md");
  const shippedVersion = JSON.parse(readShipped("package.json")).version;

  // Changes that have not been given a version yet sit in one "Unreleased" section
  // above it. Nothing else may come before the shipped version's own heading.
  test("the first versioned section is this package's own version", () => {
    const headings = changelog
      .split("\n")
      .filter((line) => line.startsWith("# "));
    const firstVersioned = headings.findIndex((line) => /^# \d/.test(line));
    expect(headings[firstVersioned]).toBe(`# ${shippedVersion}`);
    expect(
      headings
        .slice(0, firstVersioned)
        .every((line) => line.startsWith("# Unreleased")),
    ).toBe(true);
    expect(firstVersioned).toBeLessThanOrEqual(1);
  });

  test("0.19.0 sits above 0.18.0", () => {
    expect(changelog.indexOf("# 0.19.0")).toBeGreaterThan(-1);
    expect(changelog.indexOf("# 0.19.0")).toBeLessThan(
      changelog.indexOf("# 0.18.0"),
    );
  });

  test("it names the line, the fail-open truth, and the dotfiles fix", () => {
    const section = changelog.slice(
      changelog.indexOf("# 0.19.0"),
      changelog.indexOf("# 0.18.0"),
    );
    expect(section).toContain("CCC_IGNORE_REPOS");
    expect(section).toMatch(/still sent/);
    expect(section).toMatch(/home directory/);
    expect(section).not.toContain("—");
    expect(section).not.toMatch(/\bjust\b/i);
  });
});
