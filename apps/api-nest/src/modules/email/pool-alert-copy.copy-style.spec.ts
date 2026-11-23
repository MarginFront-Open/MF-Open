/**
 * Structural copy-style gate for pool-alert email copy, clone of the cap-alert
 * gate: zero em/en dashes, zero uncontracted forms, across every stage in
 * both live and period-closed variants, with and without an overage rate.
 */
import { buildPoolAlertContent, POOL_STAGE_LADDER, PoolAlertStage } from './pool-alert-copy';

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

describe('copy-style gate — pool-alert email copy', () => {
  const combos: Array<[PoolAlertStage, boolean, number | null]> = [];
  for (const { stage } of POOL_STAGE_LADDER) {
    for (const periodClosed of [false, true]) {
      for (const overageRate of [0.03, null]) {
        combos.push([stage, periodClosed, overageRate]);
      }
    }
  }

  it.each(combos)('%s (closed=%s, rate=%s) is clean', (stage, periodClosed, overageRate) => {
    const c = buildPoolAlertContent({
      stage,
      customerName: 'Tamarack Commerce',
      subscriptionName: 'Starter',
      poolSizeUnits: 1000,
      remainingUnits: stage === 'pool_exhausted' ? -25 : 120,
      percentUsed: stage === 'pool_exhausted' ? 102.5 : 88,
      overageRate,
      periodClosed,
      asOf: new Date('2026-07-20T09:00:00.000Z'),
    });
    for (const [label, text] of Object.entries(c)) {
      expect(`${label}: ${text}`).not.toMatch(EM_OR_EN_DASH);
      for (const form of UNCONTRACTED) {
        expect(`${label}: ${text}`).not.toMatch(form);
      }
    }
  });
});
