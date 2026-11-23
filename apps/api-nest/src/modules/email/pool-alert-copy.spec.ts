/**
 * The honest-copy proofs for staged pool alerts, sibling of
 * cap-alert-copy.spec.ts. These pin the copy rules as LITERAL strings so a
 * future edit that breaks the track-only truth fails CI, not a customer's
 * trust:
 *   - NOTHING stops at zero: every warning stage says usage keeps flowing,
 *     and no line reads like a gate, a block, or a cutoff.
 *   - The exhausted email says the overage rate is now in effect, with the
 *     real rate when the tiers carry one.
 *   - Every email states what happened / what it means / what to do, and the
 *     what-to-do names the needs-attention page (the CTA's deep-link target).
 *   - Boundary (period-closed) copy speaks in past tense about a finished
 *     period instead of pretending the countdown is live.
 */

import { buildPoolAlertContent, PoolAlertCopyInput, POOL_STAGE_LADDER } from './pool-alert-copy';

const base: Omit<PoolAlertCopyInput, 'stage'> = {
  customerName: 'Tamarack Commerce',
  subscriptionName: 'Starter',
  poolSizeUnits: 1000,
  remainingUnits: 450,
  percentUsed: 55,
  overageRate: 0.03,
  periodClosed: false,
  asOf: new Date('2026-07-20T09:00:00.000Z'),
};

const content = (over: Partial<PoolAlertCopyInput> & Pick<PoolAlertCopyInput, 'stage'>) =>
  buildPoolAlertContent({ ...base, ...over });

const allText = (c: ReturnType<typeof buildPoolAlertContent>) =>
  `${c.subject} ${c.headline} ${c.whatHappened} ${c.whatItMeans} ${c.whatToDo}`;

describe('POOL_STAGE_LADDER — the pinned thresholds, lowest first', () => {
  it('is exactly pool_50/50, pool_80/80, pool_95/95, pool_exhausted/100', () => {
    expect(POOL_STAGE_LADDER.map((s) => [s.stage, s.percent])).toEqual([
      ['pool_50', 50],
      ['pool_80', 80],
      ['pool_95', 95],
      ['pool_exhausted', 100],
    ]);
  });
});

describe('buildPoolAlertContent — warning stages, live period', () => {
  it('pool_50 is the literal calm countdown', () => {
    const c = content({ stage: 'pool_50' });
    expect(c.subject).toBe('Heads up: Tamarack Commerce has passed 50% of its credit pool');
    expect(c.headline).toBe('A credit pool passed 50%');
    expect(c.whatHappened).toBe(
      "Tamarack Commerce's Starter subscription has used 55% of its 1,000 unit credit pool, " +
        'with 450 units left (as of Mon, 20 Jul 2026 09:00:00 GMT).',
    );
    expect(c.whatItMeans).toBe(
      'Half the pool is used. Nothing changes at this mark: usage keeps flowing, and ' +
        'this countdown email exists so the pace never surprises you.',
    );
    expect(c.whatToDo).toBe(
      'Nothing to do. The needs-attention page in your dashboard tracks the countdown.',
    );
  });

  it('pool_80 names the overage truth with the real rate', () => {
    const c = content({ stage: 'pool_80', remainingUnits: 150, percentUsed: 85 });
    expect(c.subject).toBe('Heads up: Tamarack Commerce has passed 80% of its credit pool');
    expect(c.whatItMeans).toBe(
      'The pool is running down. Nothing stops when it empties: usage keeps flowing and ' +
        'bills as overage at $0.03 per unit.',
    );
  });

  it('pool_95 warns without claiming any stop', () => {
    const c = content({ stage: 'pool_95', remainingUnits: 40, percentUsed: 96 });
    expect(c.subject).toBe('Almost out: Tamarack Commerce has passed 95% of its credit pool');
    expect(c.whatItMeans).toBe(
      'The pool is nearly empty. Nothing stops at zero: usage keeps flowing and bills ' +
        'as overage at $0.03 per unit.',
    );
    expect(c.whatToDo).toBe(
      "If overage would surprise this customer, now's the time to reach out. " +
        'The needs-attention page in your dashboard has the live numbers.',
    );
  });

  it('a missing overage rate falls back to naming the plan rate, never a number', () => {
    const c = content({ stage: 'pool_95', overageRate: null });
    expect(c.whatItMeans).toContain("as overage at the plan's overage rate");
    expect(c.whatItMeans).not.toContain('$');
  });
});

describe('buildPoolAlertContent — pool_exhausted says the overage rate is now in effect', () => {
  it('exactly zero left: used all units, overage now billing at the rate', () => {
    const c = content({ stage: 'pool_exhausted', remainingUnits: 0, percentUsed: 100 });
    expect(c.subject).toBe(
      'Credit pool used up: Tamarack Commerce is now billing at the overage rate',
    );
    expect(c.headline).toBe('A credit pool ran out');
    expect(c.whatHappened).toBe(
      "Tamarack Commerce's Starter subscription has used all 1,000 units in its credit pool " +
        '(as of Mon, 20 Jul 2026 09:00:00 GMT).',
    );
    expect(c.whatItMeans).toBe(
      'Nothing has stopped. Usage keeps flowing, and every unit past the pool now bills ' +
        'as overage at $0.03 per unit.',
    );
    expect(c.whatToDo).toBe(
      'Review the overage in progress on the needs-attention page in your dashboard.',
    );
  });

  it('a negative balance names the overdraw honestly', () => {
    const c = content({ stage: 'pool_exhausted', remainingUnits: -200, percentUsed: 120 });
    expect(c.whatHappened).toBe(
      "Tamarack Commerce's Starter subscription has used all 1,000 units in its credit pool " +
        'and is 200 units past it (as of Mon, 20 Jul 2026 09:00:00 GMT).',
    );
  });
});

describe('buildPoolAlertContent — period-closed (boundary) copy is past tense', () => {
  it('a closed period that stayed under the pool says no overage happened', () => {
    const c = content({
      stage: 'pool_95',
      remainingUnits: 40,
      percentUsed: 96,
      periodClosed: true,
    });
    expect(c.subject).toBe('Period closed: Tamarack Commerce ended at 96% of its credit pool');
    expect(c.headline).toBe('A period ended past 95% of its pool');
    expect(c.whatHappened).toBe(
      "Tamarack Commerce's Starter subscription ended its last billing period at 96% of its " +
        '1,000 unit credit pool, with 40 units left.',
    );
    expect(c.whatItMeans).toBe(
      'The period closed before the pool emptied, so it produced no overage. ' +
        'The new period starts with a fresh pool.',
    );
    expect(c.whatToDo).toBe(
      "The period's invoice carries the final numbers. The needs-attention page in your " +
        'dashboard tracks the new period.',
    );
  });

  it('a closed period that ran out points at the invoice carrying the overage', () => {
    const c = content({
      stage: 'pool_exhausted',
      remainingUnits: -80,
      percentUsed: 108,
      periodClosed: true,
    });
    expect(c.subject).toBe(
      'Period closed: Tamarack Commerce used up its credit pool and billed overage',
    );
    expect(c.whatHappened).toBe(
      "Tamarack Commerce's Starter subscription ended its last billing period with its 1,000 unit " +
        'credit pool used up, 80 units past it.',
    );
    expect(c.whatItMeans).toBe(
      "Usage past the pool bills as overage at $0.03 per unit on that period's invoice. " +
        'The new period starts with a fresh pool.',
    );
  });
});

describe('buildPoolAlertContent — track-only truth holds everywhere', () => {
  const combos: Array<[PoolAlertCopyInput['stage'], boolean]> = [
    ['pool_50', false],
    ['pool_80', false],
    ['pool_95', false],
    ['pool_exhausted', false],
    ['pool_50', true],
    ['pool_80', true],
    ['pool_95', true],
    ['pool_exhausted', true],
  ];

  it.each(combos)('%s (periodClosed=%s) never reads like a gate or block', (stage, closed) => {
    const c = content({ stage, periodClosed: closed });
    // The sanctioned "stop" vocabulary is the disclaimer family only:
    // "Nothing stops ..." / "Nothing has stopped". Strip it, then no
    // stop/block/gate/suspend language may remain.
    const residue = allText(c)
      .toLowerCase()
      .split('nothing stops')
      .join('')
      .split('nothing has stopped')
      .join('');
    expect(residue).not.toContain('stop');
    expect(residue).not.toContain('block');
    expect(residue).not.toContain('gate');
    expect(residue).not.toContain('suspend');
    expect(residue).not.toContain('cut off');
  });

  it.each(combos)(
    '%s (periodClosed=%s) names the needs-attention page in what-to-do',
    (stage, closed) => {
      const c = content({ stage, periodClosed: closed });
      expect(c.whatToDo.toLowerCase()).toContain('needs-attention page');
    },
  );

  it('a subscription with no customer row falls back to the subscription name', () => {
    const c = content({ stage: 'pool_50', customerName: null });
    expect(c.subject).toBe('Heads up: Starter has passed 50% of its credit pool');
    expect(c.whatHappened).toContain('The Starter subscription has used');
  });
});
