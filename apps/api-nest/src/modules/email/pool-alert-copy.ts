/**
 * The PURE copy builder for staged pool alerts,
 * sibling of cap-alert-copy.ts: dependency-free (no Nest, no Resend, no clock
 * beyond the `asOf` the caller passes) so its wording is unit-tested as
 * literal strings. EmailService.sendPoolAlertEmail wraps this in HTML and
 * points the CTA at the needs-attention page.
 *
 * The one rule that governs every line: track-only truth. NOTHING stops at
 * zero — a pool that runs out keeps flowing and bills as overage at the
 * plan's overage rate. No line may read like a gate, a block, or a cutoff.
 */

export type PoolAlertStage = 'pool_50' | 'pool_80' | 'pool_95' | 'pool_exhausted';

/**
 * The evaluation ladder, lowest first. `percent` is the crossing threshold of
 * the pinned stage formula (percent = (periodGrantUnits - remainingUnits) /
 * periodGrantUnits); pool_exhausted is crossed by remainingUnits <= 0, never
 * by the percent (the two agree on a positive grant, but the remaining-units
 * definition is the one the spec pins — negative balances allowed).
 */
export const POOL_STAGE_LADDER: ReadonlyArray<{ stage: PoolAlertStage; percent: number }> = [
  { stage: 'pool_50', percent: 50 },
  { stage: 'pool_80', percent: 80 },
  { stage: 'pool_95', percent: 95 },
  { stage: 'pool_exhausted', percent: 100 },
];

export interface PoolAlertCopyInput {
  stage: PoolAlertStage;
  /** The end-customer the subscription bills; null when the row has none. */
  customerName: string | null;
  subscriptionName: string;
  /** The period grant's size in usage units (the pinned formula's denominator). */
  poolSizeUnits: number;
  /** Drawable units left (includes top-ups, excludes expired; negative = overage). */
  remainingUnits: number;
  /** Actual percent used per the pinned formula (may sit above the stage that fired). */
  percentUsed: number;
  /** The plan's overage rate in dollars per unit, when the tiers carry one. */
  overageRate: number | null;
  /** True on a boundary evaluation: the period this alert describes already ended. */
  periodClosed: boolean;
  asOf: Date;
}

export interface PoolAlertContent {
  subject: string;
  headline: string;
  whatHappened: string;
  whatItMeans: string;
  whatToDo: string;
}

const PAGE_LABEL = 'the needs-attention page in your dashboard';
const PAGE_LABEL_LEADING = 'The needs-attention page in your dashboard';

function formatUnits(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatRate(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function stagePercent(stage: PoolAlertStage): number {
  return POOL_STAGE_LADDER.find((s) => s.stage === stage)!.percent;
}

/** "Acme's Starter subscription" / "The Starter subscription" — whose pool this is. */
function subscriptionLabel(input: PoolAlertCopyInput): string {
  if (input.customerName) return `${input.customerName}'s ${input.subscriptionName} subscription`;
  return `The ${input.subscriptionName} subscription`;
}

/** The overage clause, with the real rate when the tiers carry one. */
function overageClause(overageRate: number | null): string {
  return overageRate !== null && overageRate > 0
    ? `as overage at ${formatRate(overageRate)} per unit`
    : `as overage at the plan's overage rate`;
}

export function buildPoolAlertContent(input: PoolAlertCopyInput): PoolAlertContent {
  const who = input.customerName ?? input.subscriptionName;
  const label = subscriptionLabel(input);
  const size = formatUnits(input.poolSizeUnits);
  const remaining = formatUnits(Math.max(0, input.remainingUnits));
  const overdrawn = input.remainingUnits < 0 ? formatUnits(-input.remainingUnits) : null;
  const pct = Math.round(input.percentUsed);
  const exhausted = input.stage === 'pool_exhausted';
  const mark = exhausted ? 100 : stagePercent(input.stage);

  let subject: string;
  let headline: string;
  let whatHappened: string;
  let whatItMeans: string;
  let whatToDo: string;

  if (input.periodClosed) {
    if (exhausted) {
      subject = `Period closed: ${who} used up its credit pool and billed overage`;
      headline = 'A period ended in overage';
      whatHappened =
        `${label} ended its last billing period with its ${size} unit credit pool used up` +
        `${overdrawn ? `, ${overdrawn} units past it` : ''}.`;
      whatItMeans =
        `Usage past the pool bills ${overageClause(input.overageRate)} on that period's ` +
        `invoice. The new period starts with a fresh pool.`;
    } else {
      subject = `Period closed: ${who} ended at ${pct}% of its credit pool`;
      headline = `A period ended past ${mark}% of its pool`;
      whatHappened =
        `${label} ended its last billing period at ${pct}% of its ${size} unit credit pool, ` +
        `with ${remaining} units left.`;
      whatItMeans =
        `The period closed before the pool emptied, so it produced no overage. ` +
        `The new period starts with a fresh pool.`;
    }
    whatToDo = `The period's invoice carries the final numbers. ${PAGE_LABEL_LEADING} tracks the new period.`;
    return { subject, headline, whatHappened, whatItMeans, whatToDo };
  }

  if (exhausted) {
    subject = `Credit pool used up: ${who} is now billing at the overage rate`;
    headline = 'A credit pool ran out';
    whatHappened =
      `${label} has used all ${size} units in its credit pool` +
      `${overdrawn ? ` and is ${overdrawn} units past it` : ''} (as of ${input.asOf.toUTCString()}).`;
    whatItMeans =
      `Nothing has stopped. Usage keeps flowing, and every unit past the pool now bills ` +
      `${overageClause(input.overageRate)}.`;
    whatToDo = `Review the overage in progress on ${PAGE_LABEL}.`;
    return { subject, headline, whatHappened, whatItMeans, whatToDo };
  }

  subject =
    input.stage === 'pool_95'
      ? `Almost out: ${who} has passed 95% of its credit pool`
      : `Heads up: ${who} has passed ${mark}% of its credit pool`;
  headline = `A credit pool passed ${mark}%`;
  whatHappened =
    `${label} has used ${pct}% of its ${size} unit credit pool, with ${remaining} units ` +
    `left (as of ${input.asOf.toUTCString()}).`;

  if (input.stage === 'pool_50') {
    whatItMeans =
      `Half the pool is used. Nothing changes at this mark: usage keeps flowing, and ` +
      `this countdown email exists so the pace never surprises you.`;
    whatToDo = `Nothing to do. ${PAGE_LABEL_LEADING} tracks the countdown.`;
  } else if (input.stage === 'pool_80') {
    whatItMeans =
      `The pool is running down. Nothing stops when it empties: usage keeps flowing and ` +
      `bills ${overageClause(input.overageRate)}.`;
    whatToDo = `Nothing to do yet. If this pace looks wrong, ${PAGE_LABEL} has the live numbers.`;
  } else {
    whatItMeans =
      `The pool is nearly empty. Nothing stops at zero: usage keeps flowing and bills ` +
      `${overageClause(input.overageRate)}.`;
    whatToDo = `If overage would surprise this customer, now's the time to reach out. ${PAGE_LABEL_LEADING} has the live numbers.`;
  }

  return { subject, headline, whatHappened, whatItMeans, whatToDo };
}
