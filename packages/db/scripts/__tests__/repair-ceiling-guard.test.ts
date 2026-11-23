import { describe, expect, it } from "vitest";

import {
  parseCliArgs,
  parseMaxTotalUsd,
} from "../repair-unpriced-tool-children";

describe("--max-total-usd parsing", () => {
  it("returns undefined when the flag is absent", () => {
    expect(parseMaxTotalUsd(undefined)).toBeUndefined();
  });

  it("accepts plain non-negative dollar amounts", () => {
    expect(parseMaxTotalUsd("2")).toBe(2);
    expect(parseMaxTotalUsd("0")).toBe(0);
    expect(parseMaxTotalUsd("1.273966")).toBe(1.273966);
  });

  it.each([
    "$0.01",
    "abc",
    "--apply",
    "",
    "-1",
    "NaN",
    "Infinity",
    "1e3",
    "0x10",
    "1,000",
  ])("refuses %j instead of silently disabling the guard", (raw) => {
    expect(() => parseMaxTotalUsd(raw)).toThrow(/--max-total-usd/);
  });
});

describe("CLI parsing", () => {
  const ORG = "7680de15-0000-4000-8000-00000000000a";

  it("refuses a single-org --apply with no ceiling", () => {
    expect(() =>
      parseCliArgs(["--org-id", ORG, "--provider", "model", "--apply"]),
    ).toThrow(/--max-total-usd/);
  });

  it("refuses an all-orgs --apply with no ceiling", () => {
    expect(() =>
      parseCliArgs(["--all-orgs", "--provider", "model", "--apply"]),
    ).toThrow(/--max-total-usd/);
  });

  it("refuses a flag swallowed as the ceiling value", () => {
    expect(() =>
      parseCliArgs(["--org-id", ORG, "--max-total-usd", "--apply"]),
    ).toThrow(/--max-total-usd/);
  });

  it("refuses a dollar-sign ceiling", () => {
    expect(() =>
      parseCliArgs(["--all-orgs", "--apply", "--max-total-usd", "$0.01"]),
    ).toThrow(/--max-total-usd/);
  });

  it("allows a dry run with no ceiling", () => {
    expect(
      parseCliArgs(["--org-id", ORG, "--provider", "model"]),
    ).toMatchObject({
      mode: "single",
      organizationId: ORG,
      apply: false,
      maxTotalUsd: undefined,
    });
  });

  it("passes a valid ceiling through", () => {
    expect(
      parseCliArgs(["--all-orgs", "--apply", "--max-total-usd", "2"]),
    ).toMatchObject({ mode: "all", apply: true, maxTotalUsd: 2 });
  });
});
