/**
 * cap-sentence: the shared plain-English cap rendering. Pure, no DB. Runs
 * under tsx in <1s (packages/db src test convention:
 * standalone assert scripts, NOT vitest):
 *
 *   npx tsx packages/db/src/lib/cap-sentence.test.ts
 *
 * WHY load-bearing: the MCP/SDK writes echo THIS sentence and never
 * re-derive it. If the wording here drifts from what a human expects (or from the
 * dashboard's mirror in spend-controls-utils.ts), the "here's what changed" line
 * an agent shows after a write becomes wrong. The NEGATIVE CONTROL proves these
 * assertions can fail: a naive formatter that skips the provider label and scope
 * phrase is shown to produce a different string than the real rule.
 */

import assert from "node:assert/strict";

import {
  buildCapSentence,
  capProviderLabel,
  sentenceMoney,
} from "./cap-sentence";

// ─── NEGATIVE CONTROL — proves these assertions are capable of failing ──────
// A naive formatter that interpolates the raw fields and skips the provider
// label + scope phrase the real rule applies.
const naive = (p: {
  providerScope: string;
  amountUsd: number;
  scope: string;
  scopeValue: string | null;
  period: string;
}): string =>
  `Stop ${p.providerScope} spend at $${p.amountUsd} ${p.scope} per ${p.period}`;
assert.notEqual(
  naive({
    providerScope: "anthropic",
    amountUsd: 200,
    scope: "dev",
    scopeValue: "alice@acme.example",
    period: "week",
  }),
  "Stop Claude spend at $200 for alice@acme.example per week",
  "NEGATIVE CONTROL: a formatter that skips the provider label + scope phrase must NOT match the real sentence — this is what the real rule fixes",
);

// ─── Provider labels ────────────────────────────────────────────────────────
assert.equal(capProviderLabel("all"), "AI");
assert.equal(capProviderLabel("anthropic"), "Claude");
assert.equal(capProviderLabel("openai"), "Codex (OpenAI)");
assert.equal(capProviderLabel("google"), "Gemini");
assert.equal(capProviderLabel("xai"), "Grok (xAI)");
// Open set: an unknown provider falls back to its raw string, never a blank.
assert.equal(
  capProviderLabel("cohere"),
  "cohere",
  "an unknown provider renders its raw string, not a blank label",
);

// ─── Money formatting ───────────────────────────────────────────────────────
assert.equal(sentenceMoney(200), "$200");
assert.equal(sentenceMoney(1500), "$1,500");
assert.equal(sentenceMoney(5000), "$5,000");

// ─── The sentence, per scope ────────────────────────────────────────────────

// dev cap with a named developer
assert.equal(
  buildCapSentence({
    providerScope: "anthropic",
    amountUsd: 200,
    scope: "dev",
    scopeValue: "alice@acme.example",
    period: "week",
  }),
  "Stop Claude spend at $200 for alice@acme.example per week",
);

// org ceiling, all providers
assert.equal(
  buildCapSentence({
    providerScope: "all",
    amountUsd: 5000,
    scope: "org",
    scopeValue: null,
    period: "month",
  }),
  "Stop AI spend at $5,000 across the whole team per month",
);

// team cap
assert.equal(
  buildCapSentence({
    providerScope: "openai",
    amountUsd: 1000,
    scope: "team",
    scopeValue: "Platform",
    period: "day",
  }),
  'Stop Codex (OpenAI) spend at $1,000 per person on team "Platform" per day',
);

// dev cap with no scopeValue → generic "per developer"
assert.equal(
  buildCapSentence({
    providerScope: "all",
    amountUsd: 50,
    scope: "dev",
    scopeValue: null,
    period: "week",
  }),
  "Stop AI spend at $50 per developer per week",
);

console.log("cap-sentence.test.ts: all assertions passed");
