import { describe, expect, it } from "vitest";

import {
  parseProviderScope,
  providerInScope,
} from "../repair-unpriced-tool-children";

describe("repair provider scope", () => {
  it("defaults to tool so the default sweep stays narrow", () => {
    expect(parseProviderScope(undefined)).toBe("tool");
  });

  it("accepts tool, model and any, and refuses anything else", () => {
    expect(parseProviderScope("model")).toBe("model");
    expect(parseProviderScope("any")).toBe("any");
    expect(() => parseProviderScope("llm")).toThrow(/--provider/);
  });

  it("never puts the outcome marker in scope", () => {
    for (const scope of ["tool", "model", "any"] as const) {
      expect(providerInScope("outcome", scope)).toBe(false);
      expect(providerInScope(" Outcome ", scope)).toBe(false);
    }
  });

  it("splits tool and model providers cleanly", () => {
    expect(providerInScope("tool", "tool")).toBe(true);
    expect(providerInScope("anthropic", "tool")).toBe(false);
    expect(providerInScope("anthropic", "model")).toBe(true);
    expect(providerInScope("TOOL", "model")).toBe(false);
    expect(providerInScope("tool", "any")).toBe(true);
    expect(providerInScope("openai", "any")).toBe(true);
  });
});
