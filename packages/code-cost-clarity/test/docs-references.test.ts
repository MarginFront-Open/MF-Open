// Documentation-pointer gates.
//
// Every pointer a user is shown has to land on something that ships in this
// repository: a heading in this package's README. A pointer to a section the README
// does not have is a dead end.
import { describe, expect, test } from "vitest";
import {
  docReferences,
  mentionsReadme,
  normalizeHeading,
  readmeCitation,
  readmeHeadings,
  userFacingStrings,
} from "./helpers/source-strings";

describe("no line in src/ points at a hosted address", () => {
  test("src/ carries no docs-site link", () => {
    expect(docReferences()).toEqual([]);
  });

  test("no printed string names a marginfront.com address at all", () => {
    const offenders = userFacingStrings()
      .filter((entry) => /marginfront\.com/i.test(entry.text))
      .map((entry) => `${entry.file}:${entry.line}`);
    expect(offenders).toEqual([]);
  });
});

describe("no printed line sends a user to a README section that does not exist", () => {
  const headings = readmeHeadings();

  test("every README pointer names a heading the README has", () => {
    const broken: string[] = [];

    for (const entry of userFacingStrings()) {
      if (!mentionsReadme(entry.text)) continue;

      const { cited, dead } = readmeCitation(entry.text, headings);
      const where = `${entry.file}:${entry.line}`;

      if (cited.length === 0) {
        broken.push(
          `${where}: says README but names no section: ${entry.text.trim()}`,
        );
      } else if (dead.length > 0) {
        broken.push(
          `${where}: no such README section ${dead.map((name) => `"${name}"`).join(", ")}: ${entry.text.trim()}`,
        );
      }
    }

    expect(
      broken,
      `These printed lines point at README sections that do not exist:\n${broken.join("\n")}`,
    ).toEqual([]);
  });

  test("the checker can tell a live heading from a dead one", () => {
    expect(headings).toContain(normalizeHeading("What `init` changes"));
    expect(headings).toContain(normalizeHeading("Spend Control"));
    expect(headings).not.toContain(normalizeHeading("Spend caps"));
    expect(headings).not.toContain(
      normalizeHeading("Per-teammate attribution is automatic"),
    );
  });
});

// The gate above scans whatever src/ happens to say today, so on a clean tree it
// passes while asserting nothing. These fixtures are what make it a gate: they hand
// the real checker lines that MUST be rejected, so loosening it fails here even when
// src/ is spotless.
describe("the README gate rejects the lines it exists to reject", () => {
  const headings = readmeHeadings();
  const deadOf = (text: string): string[] =>
    readmeCitation(text, headings).dead;

  const mustBeRejected: Array<[string, string]> = [
    [
      "a dead section smuggled alongside a live one",
      'README, section "Per-teammate attribution is automatic" (full list: "What init changes").',
    ],
    [
      "a dead section on its own",
      'Full list: README, "Per-teammate attribution is automatic".',
    ],
    [
      "two live names and one dead one",
      'README: "What init changes", "Install", "Spend caps in depth".',
    ],
    [
      "single-quoted inside the printed line",
      "README, section 'Spend caps in depth'.",
    ],
    ["backtick-quoted", "README, section `Spend caps in depth`."],
    ["possessive phrasing", "See the README's Spend caps in depth section."],
  ];

  for (const [name, line] of mustBeRejected) {
    test(`rejected: ${name}`, () => {
      expect(mentionsReadme(line)).toBe(true);
      expect(deadOf(line)).not.toEqual([]);
    });
  }

  // Naming nothing must not read as "nothing dead, therefore fine" - the scan above
  // treats an empty citation list as broken, and this pins that these lines really
  // do produce one.
  const mustNameNothing = [
    "See the README for the full list.",
    "Readme has the details.",
    "README, section What init changes",
  ];

  for (const line of mustNameNothing) {
    test(`names no section, so it cannot pass: ${line}`, () => {
      expect(mentionsReadme(line)).toBe(true);
      expect(readmeCitation(line, headings).cited).toEqual([]);
    });
  }

  test("a pointer whose every name is live is accepted", () => {
    const good = 'Full list: README, "What init changes".';
    expect(mentionsReadme(good)).toBe(true);
    expect(readmeCitation(good, headings).cited).not.toEqual([]);
    expect(deadOf(good)).toEqual([]);
  });

  test("lowercase spelling is still gated", () => {
    expect(mentionsReadme('see the readme, section "Spend Control"')).toBe(
      true,
    );
  });

  // Two evasions do get through, tried against this gate rather than assumed: a dead
  // section named without the word README ('Docs section "..."'), and one written in
  // a code comment instead of a printed string. Neither is what this gate claims to
  // cover - the first cites no README, the second reaches no reader - and widening
  // to catch them would flag every quoted word in printed copy.
});

describe("printed copy stays plain", () => {
  test('no printed line uses the word "just"', () => {
    const offenders = userFacingStrings()
      .filter((entry) => /\bjust\b/i.test(entry.text))
      .map((entry) => `${entry.file}:${entry.line}: ${entry.text.trim()}`);

    expect(
      offenders,
      `Printed copy must not use "just":\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// This package is general-purpose, so printed copy says "work item", never "matter"
// or legal vocabulary. The IDENTIFIERS stay: CCC_MATTER_ID is a supported settings
// key, and matterId is the wire field ingest reads. Both are stripped before the scan rather than allowlisted,
// because they are names, not words a reader is being asked to understand.
describe("printed copy uses neutral work-item wording", () => {
  const VERTICAL_WORDS =
    /\b(matter|matters|mattered|legal|law|lawyer|attorney|firm|litigation|docket|filing|case|cases)\b/i;

  // Names, not words. Removed before the scan so the key and the wire field can be
  // printed without opening a hole for the prose sense of the same word.
  const IDENTIFIERS = [/CCC_MATTER_ID/g, /matterId/g];

  // Allowed ordinary-English phrases, each one exact. An allowlist of
  // whole phrases rather than of words: "why this matters" may stay, "the matter
  // number" may not, and no new line can hide behind either.
  const ALLOWED: ReadonlyArray<{ phrase: string; why: string }> = [
    { phrase: "Why this matters:", why: "the verb, in the uninstall summary" },
    {
      phrase: "(worst case) a tampered release",
      why: "the idiom, in the checksum-mismatch error",
    },
    {
      phrase: "case $0 in",
      why: "POSIX shell, inside the cap-check script this package writes",
    },
  ];

  function scrub(text: string): string {
    let scrubbed = text;
    for (const identifier of IDENTIFIERS)
      scrubbed = scrubbed.replace(identifier, "");
    for (const { phrase } of ALLOWED)
      scrubbed = scrubbed.split(phrase).join("");
    return scrubbed;
  }

  test("no printed string names a matter, a case, or legal work", () => {
    const offenders: string[] = [];
    for (const entry of userFacingStrings()) {
      const match = scrub(entry.text).match(VERTICAL_WORDS);
      if (match) {
        offenders.push(
          `${entry.file}:${entry.line}: "${match[0]}" in ${entry.text.trim().slice(0, 120)}`,
        );
      }
    }

    expect(
      offenders,
      `Printed copy must use neutral words. Say "work item", not legal vocabulary:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  // An allowlist nobody prunes turns into a blanket exemption. If the line an entry
  // was written for is gone, the entry has to go with it.
  test("every allowed phrase still matches a real printed line", () => {
    const printed = userFacingStrings().map((entry) => entry.text);
    for (const { phrase, why } of ALLOWED) {
      expect(
        printed.some((text) => text.includes(phrase)),
        `Nothing prints "${phrase}" any more (${why}). Remove it from ALLOWED.`,
      ).toBe(true);
    }
  });

  test("the gate catches the wording it exists to catch", () => {
    expect(scrub("Create this matter on the Matters page")).toMatch(
      VERTICAL_WORDS,
    );
    expect(scrub("Set CCC_MATTER_ID to tag this machine")).not.toMatch(
      VERTICAL_WORDS,
    );
    expect(scrub('"matterId": "PROJ-123"')).not.toMatch(VERTICAL_WORDS);
    expect(scrub("Work item: not set.")).not.toMatch(VERTICAL_WORDS);
  });
});

// Pointers that must stay as written, because each one lands on something real.
describe("references that must stay as written are untouched", () => {
  const printed = userFacingStrings().map((entry) => entry.text);

  test("the Linux and WSL pointer cites the README's Platforms section", () => {
    expect(printed).toContain(
      '          packages/code-cost-clarity/README.md, "Platforms"',
    );
  });

  test('the two "What init changes" pointers still cite the README', () => {
    const citations = printed.filter((text) =>
      text.includes('Full list: README, "What init changes".'),
    );
    expect(citations).toHaveLength(2);
  });

  test("the key-creation line names the route inside the operator's own dashboard", () => {
    expect(printed).toContain(
      "  Get it here: your MarginFront dashboard, then Build, then API keys (Create key pair).",
    );
  });
});
