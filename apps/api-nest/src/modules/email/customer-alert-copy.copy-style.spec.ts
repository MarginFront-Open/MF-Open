/**
 * Structural copy-style gate for customer-watch email copy: zero em/en dashes,
 * zero uncontracted forms, zero banned sentence CONSTRUCTIONS, across every
 * variant/metric/mode combination. Clone of the cap-alert copy-style gate.
 *
 * The construction list exists because a character-only gate has a blind
 * spot: "no billing, no limits, just the heads-up" is em-dash-free and fully
 * contracted, and it is still the banned "No X. No Y. Just Z." emphasis
 * triplet. Shapes, not just characters.
 */
import { buildCustomerAlertContent } from './customer-alert-copy';

const EM_OR_EN_DASH = /[—–]/;
const BANNED_CONSTRUCTIONS = [
  // "no X, no Y, just Z" (and the "No X. No Y. Just Z." period variant)
  /\bno\s+[^.,;:]{1,40}[,.]\s+no\s+[^.,;:]{1,40}[,.]\s+just\b/i,
  // "it's not X, it's Y" pivot, incl. this/that and uncontracted variants
  /\b(?:it|this|that)(?:'s|\s+is)\s+not\s+[^.,;:]{1,60}[,;]\s*(?:it|this|that)(?:'s|\s+is)\b/i,
];
const UNCONTRACTED = [
  /\bdo not\b/i,
  /\bdoes not\b/i,
  /\bdid not\b/i,
  /\bcannot\b/i,
  /\bwill not\b/i,
  /\bwould not\b/i,
  /\bshould not\b/i,
  /\bcould not\b/i,
  /\bis not\b/i,
  /\bare not\b/i,
  /\bwas not\b/i,
  /\bwere not\b/i,
  /\bhave not\b/i,
  /\bhas not\b/i,
  /\bhad not\b/i,
  /\bit is\b/i,
  /\byou are\b/i,
  /\bwe are\b/i,
  /\bthey are\b/i,
];

describe('copy-style gate — customer-watch email copy', () => {
  const combos: Array<
    ['trigger' | 'confirmation', 'cost' | 'revenue', 'month' | 'rolling' | 'custom']
  > = [];
  for (const variant of ['trigger', 'confirmation'] as const) {
    for (const metric of ['cost', 'revenue'] as const) {
      for (const mode of ['month', 'rolling', 'custom'] as const) {
        combos.push([variant, metric, mode]);
      }
    }
  }

  it.each(combos)('%s / %s / %s is clean', (variant, metric, mode) => {
    const c = buildCustomerAlertContent({
      variant,
      customerName: 'Acme',
      metric,
      thresholdUsd: 500,
      windowMode: mode,
      customStartDate: mode === 'custom' ? new Date('2026-08-01T00:00:00.000Z') : null,
      customEndDate: mode === 'custom' ? new Date('2026-08-31T00:00:00.000Z') : null,
      valueUsd: variant === 'trigger' ? 512.4 : null,
      asOf: new Date('2026-08-26T12:00:00.000Z'),
    });
    for (const [label, text] of Object.entries(c)) {
      expect(`${label}: ${text}`).not.toMatch(EM_OR_EN_DASH);
      for (const form of UNCONTRACTED) {
        expect(`${label}: ${text}`).not.toMatch(form);
      }
      for (const shape of BANNED_CONSTRUCTIONS) {
        expect(`${label}: ${text}`).not.toMatch(shape);
      }
    }
  });
});
