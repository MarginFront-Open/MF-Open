import type { CustomerAlertMetric, CustomerAlertWindowMode } from '@marginfront/db';

/**
 * WHAT THIS FILE DOES: the PURE copy builder for customer-watch emails
 * — the "your customer crossed the line" trigger email and the
 * "your watch is live" confirmation email. Dependency-free (no Nest, no
 * Resend, no clock beyond the asOf the caller passes) so the wording is
 * unit-tested as literal strings, exactly like cap-alert-copy.ts.
 * CONNECTS TO: email.service.ts sendCustomerAlertEmail /
 * sendCustomerAlertConfirmationEmail (HTML wrap + send), and the copy-style gate
 * beside this file.
 *
 * The rule that governs every line: a watch WATCHES. It never bills, blocks,
 * or throttles the customer, and the copy never implies it does. The email
 * reports a number crossing a line the user drew, and points at the customer
 * page — nothing else.
 */

export interface CustomerAlertCopyInput {
  variant: 'trigger' | 'confirmation';
  customerName: string;
  metric: CustomerAlertMetric;
  thresholdUsd: number;
  windowMode: CustomerAlertWindowMode;
  /** Custom mode only; null otherwise. */
  customStartDate: Date | null;
  customEndDate: Date | null;
  /** The measured value at fire time. Trigger variant only; null on confirmation. */
  valueUsd: number | null;
  asOf: Date;
}

export interface CustomerAlertContent {
  subject: string;
  headline: string;
  whatHappened: string;
  whatItMeans: string;
  whatToDo: string;
}

function formatUsd(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatUtcDay(d: Date): string {
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** "this month" / "the last 30 days" / "your custom window (Aug 1, 2026 to Aug 31, 2026 UTC)". */
function windowLabel(
  mode: CustomerAlertWindowMode,
  customStartDate: Date | null,
  customEndDate: Date | null,
): string {
  if (mode === 'month') return 'this month';
  if (mode === 'rolling') return 'the last 30 days';
  const range =
    customStartDate && customEndDate
      ? ` (${formatUtcDay(customStartDate)} to ${formatUtcDay(customEndDate)} UTC)`
      : '';
  return `your custom window${range}`;
}

/** "what Acme costs you" (cost) / "what Acme owes you" (revenue). */
function metricPhrase(metric: CustomerAlertMetric, customerName: string): string {
  return metric === 'cost' ? `what ${customerName} costs you` : `what ${customerName} owes you`;
}

/** How this watch re-fires, in one honest sentence per mode. */
function reFireSentence(mode: CustomerAlertWindowMode, customerName: string): string {
  if (mode === 'month') {
    return 'This watch fires once per calendar month and re-arms itself when a new month starts.';
  }
  if (mode === 'rolling') {
    return (
      `This watch fires once per crossing: it stays quiet while ${customerName} ` +
      'stays over the line, and re-arms when the number drops back under.'
    );
  }
  return 'This watch covers a fixed date range, fires at most once, and expires when the range ends.';
}

export function buildCustomerAlertContent(input: CustomerAlertCopyInput): CustomerAlertContent {
  const name = input.customerName;
  const threshold = formatUsd(input.thresholdUsd);
  const window = windowLabel(input.windowMode, input.customStartDate, input.customEndDate);
  const phrase = metricPhrase(input.metric, name);

  if (input.variant === 'confirmation') {
    return {
      subject: `Watch created: ${name} ${input.metric} over ${threshold}`,
      headline: 'Your customer watch is live',
      whatHappened:
        `You'll get an email at this address when ${phrase} passes ${threshold} ` +
        `for ${window}.`,
      whatItMeans:
        `${reFireSentence(input.windowMode, name)} Watching changes nothing for ` +
        `${name}: a watch never bills or limits them. It only emails you.`,
      whatToDo: `Nothing to do. To adjust or remove the watch, open ${name}'s customer page.`,
    };
  }

  const value = formatUsd(input.valueUsd ?? 0);
  return {
    subject: `Heads up: ${name} passed your ${threshold} ${input.metric} watch`,
    headline: `${name} crossed a line you drew`,
    whatHappened:
      `${capitalize(phrase)} is ${value} for ${window}. That passed the ` +
      `${threshold} tripwire you set (as of ${input.asOf.toUTCString()}).`,
    whatItMeans:
      `${reFireSentence(input.windowMode, name)} Nothing changed for ${name}: ` +
      'the watch never bills or limits them. You asked for a heads-up and this is it.',
    whatToDo: `Open ${name}'s customer page to see what's driving the number.`,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
