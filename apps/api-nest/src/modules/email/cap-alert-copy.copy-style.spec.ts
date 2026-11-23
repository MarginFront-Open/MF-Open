/**
 * Structural copy-style gate for alert-email copy: zero em/en dashes, zero
 * uncontracted forms, across every mode/rung combination.
 */
import { buildCapAlertContent } from './cap-alert-copy';

const EM_OR_EN_DASH = /[—–]/;
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

describe('copy-style gate — cap-alert email copy', () => {
  const combos: Array<['track' | 'enforce', number]> = [
    ['track', 50],
    ['track', 80],
    ['track', 100],
    ['enforce', 50],
    ['enforce', 80],
    ['enforce', 100],
  ];

  it.each(combos)('%s mode at rung %i is clean', (mode, rung) => {
    const c = buildCapAlertContent({
      mode,
      rung,
      scope: 'dev',
      scopeValue: 'dev@co.example',
      providerScope: 'all',
      amountUsd: 200,
      period: 'week',
      spentUsd: (rung / 100) * 200 + 1,
      percentOfCap: rung + 1,
      asOf: new Date('2026-07-23T12:00:00.000Z'),
    });
    for (const [label, text] of Object.entries(c)) {
      expect(`${label}: ${text}`).not.toMatch(EM_OR_EN_DASH);
      for (const form of UNCONTRACTED) {
        expect(`${label}: ${text}`).not.toMatch(form);
      }
    }
  });
});
