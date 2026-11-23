import { CAP_MANAGE_ROLES, type CapMode, type CapPeriod, type CapScope } from '@marginfront/db';

/**
 * The PURE copy builder for ladder alerts, kept
 * dependency-free (no Nest, no Resend, no clock beyond the `asOf` the caller
 * passes) so its wording is unit-tested as literal strings, the same way
 * MODE_COPY is. EmailService.sendCapAlertEmail wraps this in HTML and sends.
 *
 * The one rule that governs every line: NEVER blur "alert" and "block". Track
 * mode watches and warns and never claims to stop work; enforce mode is the only
 * one that names a real block, and at 100% it also names the raise path — with
 * the authority DERIVED from CAP_MANAGE_ROLES so a role rename can't strand the
 * copy pointing at a seat that can no longer change caps.
 */

export interface CapAlertCopyInput {
  mode: CapMode;
  /** The rung that fired, a whole percent (50/80/100 or a custom ladder entry). */
  rung: number;
  scope: CapScope;
  scopeValue: string | null;
  providerScope: string;
  amountUsd: number;
  period: CapPeriod;
  spentUsd: number;
  /** Actual spend as a percent of the cap (may sit above the rung that fired). */
  percentOfCap: number;
  asOf: Date;
}

export interface CapAlertContent {
  subject: string;
  headline: string;
  /** The cap as a plain sentence ("Stop AI spend at $200.00 per week"). */
  capSentence: string;
  whatHappened: string;
  whatItMeans: string;
  whatToDo: string;
}

// Must match the page title in
// apps/dashboard/src/features/internal-ai-spend/index.tsx (pinned by
// cap-alert-copy.spec.ts) — the email tells users to open this page by name.
const PAGE_LABEL = 'Internal AI Spend';

function formatUsd(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function periodWord(period: CapPeriod): string {
  return period; // 'day' | 'week' | 'month' already read as plain English
}

function providerLabel(providerScope: string): string {
  return providerScope === 'all' ? 'AI' : providerScope;
}

/** "for dev@co.example" / "for the payments team" / "" — who the cap governs. */
function scopeSuffix(scope: CapScope, scopeValue: string | null): string {
  if (scope === 'dev' && scopeValue) return ` for ${scopeValue}`;
  return '';
}

/**
 * "an owner or finance user" — derived from CAP_MANAGE_ROLES so the raise path
 * always points at exactly the seats that can change a cap, even if that set
 * changes later. Never hardcode role names in the copy.
 */
function raiseAuthority(): string {
  return `an ${[...CAP_MANAGE_ROLES].join(' or ')} user`;
}

function capSentenceFor(input: CapAlertCopyInput): string {
  const who = scopeSuffix(input.scope, input.scopeValue);
  const provider = providerLabel(input.providerScope);
  const money = formatUsd(input.amountUsd);
  const per = periodWord(input.period);
  if (input.mode === 'enforce') {
    return `Stop ${provider} spend at ${money} per ${per}${who}`;
  }
  return `Track ${provider} spend against ${money} per ${per}${who}`;
}

export function buildCapAlertContent(input: CapAlertCopyInput): CapAlertContent {
  const provider = providerLabel(input.providerScope);
  const capMoney = formatUsd(input.amountUsd);
  const spentMoney = formatUsd(input.spentUsd);
  const actualPct = Math.round(input.percentOfCap);
  const who = scopeSuffix(input.scope, input.scopeValue);
  const capSentence = capSentenceFor(input);
  const reached = input.rung >= 100;
  const milestone = reached ? 'reached 100%' : `passed ${input.rung}%`;

  const subject = reached
    ? `${input.mode === 'enforce' ? 'Cap reached' : 'Heads up'}: your ${provider} spend hit 100% of a ${capMoney} cap`
    : `Heads up: your ${provider} spend passed ${input.rung}% of a ${capMoney} cap`;

  const headline =
    input.mode === 'enforce' && reached
      ? 'A spend cap just kicked in'
      : reached
        ? "You've reached a spend cap"
        : `You've ${milestone} of a spend cap`;

  const whatHappened =
    `Your ${provider} spend${who} is ${spentMoney}. That's ${actualPct}% of your ` +
    `${capMoney} ${periodWord(input.period)} cap (as of ${input.asOf.toUTCString()}).`;

  let whatItMeans: string;
  let whatToDo: string;

  if (input.mode === 'track') {
    if (reached) {
      // The ONE sanctioned "stop" in track copy: the explicit disclaimer.
      whatItMeans =
        "You've hit the cap. But this is a notification, not a stop. Your work keeps " +
        'going and nothing changes on your machines.';
    } else {
      whatItMeans =
        "This cap only watches and warns, so you're seeing the spend early. Your work keeps " +
        'going as normal.';
    }
    whatToDo = `Nothing to do. If this looks wrong, open ${PAGE_LABEL} to review the cap.`;
  } else {
    if (reached) {
      whatItMeans = `${capSentence}. New ${provider} spend is now blocked on machines where this cap is armed.`;
      whatToDo = `To get more room, ask ${raiseAuthority()} to raise it. Open ${PAGE_LABEL} to make the change.`;
    } else {
      whatItMeans =
        `This cap is in enforce mode: at 100% it stops new ${provider} spend on machines where ` +
        `it's armed. You're at ${actualPct}% now, still running.`;
      whatToDo = `If you want more room before it stops, ask ${raiseAuthority()} to raise the cap in ${PAGE_LABEL}.`;
    }
  }

  return { subject, headline, capSentence, whatHappened, whatItMeans, whatToDo };
}
