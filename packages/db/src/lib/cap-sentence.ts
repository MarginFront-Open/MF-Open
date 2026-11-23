/**
 * cap-sentence.ts: the ONE plain-English rendering
 * of a spend cap, kept pure (no Prisma, no Nest) so the programmatic write
 * surfaces can echo what changed WITHOUT re-deriving the wording.
 *
 * WHY here: every MCP/SDK cap write echoes the cap as its plain sentence and
 * never re-derives it. api-nest computes the
 * sentence from this module and returns it on create/update/delete; MCP and the
 * SDK surface the server's string. The dashboard keeps its OWN copy of this
 * wording in features/internal-ai-spend/spend-controls-utils.ts (buildCapSentence) because a
 * `'use client'` bundle can't value-import @marginfront/db (drags Prisma into the
 * browser) — the same forced mirror as the CAP_SCOPES vocabulary. Output here is
 * kept byte-identical to that client copy; change both together.
 */

import type { CapPeriod, CapScope } from "./cap-policy";

/**
 * How a provider string renders in human copy. 'all' is "AI"; known providers get
 * their product name; an unknown provider (the set is open) falls back to the raw
 * string so a cap is never hidden behind a blank label.
 */
export const CAP_PROVIDER_LABELS: Record<string, string> = {
  all: "AI",
  anthropic: "Claude",
  openai: "Codex (OpenAI)",
  google: "Gemini",
  xai: "Grok (xAI)",
};

export function capProviderLabel(providerScope: string): string {
  return CAP_PROVIDER_LABELS[providerScope] ?? providerScope;
}

const CAP_PERIOD_LABELS: Record<CapPeriod, string> = {
  day: "day",
  week: "week",
  month: "month",
};

/** The "per ___" phrase for a cap's scope. */
function scopePhrase(scope: CapScope, scopeValue: string | null): string {
  if (scope === "org") return "across the whole team";
  if (scope === "team") return `per person on team "${scopeValue ?? ""}"`;
  return scopeValue ? `for ${scopeValue}` : "per developer";
}

/** Whole dollars with thousands separators for the sentence ("$200", "$1,500"). */
export function sentenceMoney(amountUsd: number): string {
  return `$${Number(amountUsd).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

export interface CapSentenceParts {
  providerScope: string;
  amountUsd: number;
  scope: CapScope;
  scopeValue: string | null;
  period: CapPeriod;
}

/**
 * The cap as one sentence. Example output:
 *   "Stop Claude spend at $200 for alice@acme.example per week"
 *   "Stop AI spend at $5,000 across the whole team per month"
 */
export function buildCapSentence(parts: CapSentenceParts): string {
  return (
    `Stop ${capProviderLabel(parts.providerScope)} spend at ` +
    `${sentenceMoney(parts.amountUsd)} ` +
    `${scopePhrase(parts.scope, parts.scopeValue)} ` +
    `per ${CAP_PERIOD_LABELS[parts.period]}`
  );
}
